import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import {
  AUTH_OTP_DELIVERY,
  AUTH_SECURITY_DEFAULTS,
  type OtpChannel,
  type OtpDeliveryPort,
} from './auth.constants';

interface AuthenticatedUser {
  userId: string;
  sessionId: string;
}

export interface ChallengeCreated {
  challengeId: string;
  expiresAt: string;
}

export interface SessionCreated {
  sessionToken: string;
  expiresAt: string;
  user: { id: string; displayName: string };
}

interface ChallengeRow {
  id: string;
  user_id: string | null;
  campus_id: string | null;
  purpose: 'login' | 'campus_email';
  channel: OtpChannel;
  identity_hash: string;
  code_hash: string;
  destination_ciphertext: string;
  display_name: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
}

interface DeliveryRow {
  id: string;
  challenge_id: string;
  channel: OtpChannel;
  destination_ciphertext: string | null;
  code_ciphertext: string | null;
  attempts: number;
}

interface SecurityConfig {
  secret: Buffer;
  encryptionKey: Buffer;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  resendCooldownSeconds: number;
  sessionTtlSeconds: number;
  deliveryMaxAttempts: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    @Inject(AUTH_OTP_DELIVERY) private readonly otpDelivery: OtpDeliveryPort,
  ) {}

  async createLoginChallenge(input: {
    channel: OtpChannel;
    destination: string;
    displayName?: string;
  }): Promise<ChallengeCreated> {
    const security = this.securityConfig();
    const destination = this.normalizeDestination(
      input.channel,
      input.destination,
    );
    const identityHash = this.hash(
      security.secret,
      `identity:${input.channel}:${destination}`,
    );
    const displayName = this.normalizeDisplayName(input.displayName);
    return this.createChallenge({
      security,
      channel: input.channel,
      destination,
      identityHash,
      purpose: 'login',
      displayName,
    });
  }

  async createCampusEmailVerification(
    userId: string,
    emailInput: string,
  ): Promise<ChallengeCreated> {
    const security = this.securityConfig();
    const email = this.normalizeDestination('email', emailInput);
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!this.isValidHostname(domain))
      throw new BadRequestException({
        code: 'invalid_email',
        message: 'Enter a valid email address',
      });
    const client = await this.database.pool.connect();
    let campusId: string | undefined;
    try {
      const result = await client.query<{ campus_id: string }>(
        `select d.campus_id
         from campus_email_domains d
         join campuses c on c.id = d.campus_id and c.status = 'active'
         where d.domain = $1 and d.active = true and d.verified_at is not null
         limit 1`,
        [domain],
      );
      campusId = result.rows[0]?.campus_id;
      if (!campusId)
        throw new BadRequestException({
          code: 'campus_email_domain_not_allowed',
          message: 'Email domain is not enabled for campus verification',
        });
      const existing = await client.query(
        `select 1 from campus_email_verifications where user_id = $1 limit 1`,
        [userId],
      );
      if (existing.rowCount)
        throw new ConflictException({
          code: 'campus_email_already_verified',
          message: 'A campus email is already verified for this account',
        });
    } finally {
      client.release();
    }
    const identityHash = this.hash(security.secret, `identity:email:${email}`);
    return this.createChallenge({
      security,
      channel: 'email',
      destination: email,
      identityHash,
      purpose: 'campus_email',
      userId,
      campusId,
    });
  }

  async verifyLoginChallenge(
    challengeId: string,
    submittedCode: string,
  ): Promise<SessionCreated> {
    const security = this.securityConfig();
    const outcome = await this.inTransaction(async (client) => {
      const challenge = await this.lockChallengeForIdentity(
        client,
        challengeId,
      );
      if (!challenge) return { error: 'challenge_invalid' } as const;
      const invalid = this.checkChallenge(challenge);
      if (invalid) return { error: invalid } as const;
      if (challenge.purpose !== 'login')
        return { error: 'challenge_purpose_mismatch' } as const;
      if (!this.codeMatches(security.secret, challenge, submittedCode)) {
        const nextAttempts = challenge.attempts + 1;
        const locked = nextAttempts >= challenge.max_attempts;
        await client.query(
          `update auth_otp_challenges
           set attempts = $2, status = $3, updated_at = now()
           where id = $1`,
          [challenge.id, nextAttempts, locked ? 'locked' : challenge.status],
        );
        return { error: locked ? 'otp_locked' : 'otp_invalid' } as const;
      }

      await client.query(
        `update auth_otp_challenges
         set status = 'consumed', consumed_at = now(), updated_at = now()
         where id = $1`,
        [challenge.id],
      );
      const identity = await client.query<{
        user_id: string;
        status: string;
        display_name: string;
      }>(
        `select i.user_id, u.status, u.display_name
         from auth_identities i
         join users u on u.id = i.user_id
         where i.channel = $1 and i.identity_hash = $2
         for update of i, u`,
        [challenge.channel, challenge.identity_hash],
      );
      let userId: string;
      let displayName: string;
      let userStatus: string;
      if (identity.rows[0]) {
        userId = identity.rows[0].user_id;
        displayName = identity.rows[0].display_name;
        userStatus = identity.rows[0].status;
      } else {
        const insertedUser = await client.query<{
          id: string;
          display_name: string;
          status: string;
        }>(
          `insert into users (display_name, status)
           values ($1, 'active')
           returning id, display_name, status`,
          [challenge.display_name || 'Pengguna Antriin'],
        );
        const newUser = insertedUser.rows[0];
        await client.query(
          `insert into auth_identities
             (user_id, channel, identity_hash, destination_ciphertext, verified_at)
           values ($1, $2, $3, $4, now())`,
          [
            newUser.id,
            challenge.channel,
            challenge.identity_hash,
            challenge.destination_ciphertext,
          ],
        );
        userId = newUser.id;
        displayName = newUser.display_name;
        userStatus = newUser.status;
      }
      if (userStatus !== 'active')
        return { error: 'account_unavailable' } as const;
      const session = await this.createSessionInTransaction(
        client,
        security,
        userId,
      );
      return {
        session,
        user: {
          id: userId,
          displayName,
        },
      } as const;
    });

    if ('error' in outcome) this.throwChallengeError(outcome.error!);
    return {
      sessionToken: outcome.session.token,
      expiresAt: outcome.session.expiresAt,
      user: outcome.user,
    };
  }

  async verifyCampusEmailChallenge(
    userId: string,
    challengeId: string,
    submittedCode: string,
  ): Promise<{ verified: true; verifiedAt: string }> {
    const security = this.securityConfig();
    const outcome = await this.inTransaction(async (client) => {
      const challenge = await this.lockChallengeForIdentity(
        client,
        challengeId,
      );
      if (!challenge) return { error: 'challenge_invalid' } as const;
      const invalid = this.checkChallenge(challenge);
      if (invalid) return { error: invalid } as const;
      if (
        challenge.purpose !== 'campus_email' ||
        challenge.user_id !== userId ||
        !challenge.campus_id
      )
        return { error: 'challenge_purpose_mismatch' } as const;
      if (!this.codeMatches(security.secret, challenge, submittedCode)) {
        const nextAttempts = challenge.attempts + 1;
        const locked = nextAttempts >= challenge.max_attempts;
        await client.query(
          `update auth_otp_challenges
           set attempts = $2, status = $3, updated_at = now()
           where id = $1`,
          [challenge.id, nextAttempts, locked ? 'locked' : challenge.status],
        );
        return { error: locked ? 'otp_locked' : 'otp_invalid' } as const;
      }

      const userResult = await client.query<{ status: string }>(
        `select status from users where id = $1 for update`,
        [userId],
      );
      if (userResult.rows[0]?.status !== 'active')
        return { error: 'account_unavailable' } as const;
      const email = this.decrypt(
        security.encryptionKey,
        challenge.destination_ciphertext,
      );
      const domain = email.slice(email.lastIndexOf('@') + 1);
      const domainResult = await client.query(
        `select 1
         from campus_email_domains d
         join campuses c on c.id = d.campus_id and c.status = 'active'
         where d.campus_id = $1 and d.domain = $2
           and d.active = true and d.verified_at is not null
         limit 1 for update of d, c`,
        [challenge.campus_id, domain],
      );
      if (!domainResult.rowCount)
        return { error: 'campus_email_domain_not_allowed' } as const;

      await client.query(
        `update auth_otp_challenges
         set status = 'consumed', consumed_at = now(), updated_at = now()
         where id = $1`,
        [challenge.id],
      );
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `identity:email:${challenge.identity_hash}`,
      ]);
      const existingIdentity = await client.query<{ user_id: string }>(
        `select user_id from auth_identities
         where channel = 'email' and identity_hash = $1 for update`,
        [challenge.identity_hash],
      );
      const identityOwner = existingIdentity.rows[0]?.user_id;
      if (identityOwner && identityOwner !== userId)
        return { error: 'campus_email_in_use' } as const;
      if (!identityOwner) {
        await client.query(
          `insert into auth_identities
             (user_id, channel, identity_hash, destination_ciphertext, verified_at)
           values ($1, 'email', $2, $3, now())`,
          [userId, challenge.identity_hash, challenge.destination_ciphertext],
        );
      }
      const verification = await client.query<{ verified_at: Date }>(
        `insert into campus_email_verifications
           (user_id, campus_id, identity_hash, verified_at)
         values ($1, $2, $3, now())
         returning verified_at`,
        [userId, challenge.campus_id, challenge.identity_hash],
      );
      return {
        verifiedAt: verification.rows[0].verified_at.toISOString(),
      } as const;
    });
    if ('error' in outcome) this.throwChallengeError(outcome.error!);
    return { verified: true, verifiedAt: outcome.verifiedAt };
  }

  async currentCampusEmailVerification(userId: string): Promise<{
    verified: boolean;
    campusId?: string;
    verifiedAt?: string;
  }> {
    const result = await this.database.pool.query<{
      campus_id: string;
      verified_at: Date;
    }>(
      `select campus_id, verified_at
       from campus_email_verifications where user_id = $1 limit 1`,
      [userId],
    );
    const verification = result.rows[0];
    return verification
      ? {
          verified: true,
          campusId: verification.campus_id,
          verifiedAt: verification.verified_at.toISOString(),
        }
      : { verified: false };
  }

  async authenticate(token: string): Promise<AuthenticatedUser> {
    const security = this.securityConfig();
    if (!token || token.length > 256)
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'A valid bearer token is required',
      });
    const tokenHash = this.hash(security.secret, `session:${token}`);
    const result = await this.database.pool.query<{
      session_id: string;
      user_id: string;
    }>(
      `select s.id as session_id, s.user_id
       from auth_sessions s
       join users u on u.id = s.user_id
       where s.token_hash = $1
         and s.revoked_at is null
         and s.expires_at > now()
         and u.status = 'active'
       limit 1`,
      [tokenHash],
    );
    const session = result.rows[0];
    if (!session)
      throw new UnauthorizedException({
        code: 'unauthorized',
        message: 'A valid bearer token is required',
      });
    return { userId: session.user_id, sessionId: session.session_id };
  }

  async refreshSession(
    sessionId: string,
    userId: string,
  ): Promise<{
    sessionToken: string;
    expiresAt: string;
  }> {
    const security = this.securityConfig();
    const outcome = await this.inTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        user_id: string;
        revoked_at: Date | null;
        expires_at: Date;
      }>(
        `select id, user_id, revoked_at, expires_at
         from auth_sessions where id = $1 for update`,
        [sessionId],
      );
      const session = result.rows[0];
      if (
        !session ||
        session.user_id !== userId ||
        session.revoked_at ||
        session.expires_at.getTime() <= Date.now()
      )
        return { error: 'session_invalid' } as const;
      const userResult = await client.query<{ status: string }>(
        `select status from users where id = $1 for update`,
        [userId],
      );
      if (userResult.rows[0]?.status !== 'active')
        return { error: 'session_invalid' } as const;
      const rotated = await this.createSessionInTransaction(
        client,
        security,
        userId,
      );
      await client.query(
        `update auth_sessions
         set revoked_at = now(), rotated_to_session_id = $2, updated_at = now()
         where id = $1 and revoked_at is null`,
        [sessionId, rotated.id],
      );
      return { token: rotated.token, expiresAt: rotated.expiresAt } as const;
    });
    if ('error' in outcome) this.throwSessionError();
    return { sessionToken: outcome.token, expiresAt: outcome.expiresAt };
  }

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const result = await this.database.pool.query(
      `update auth_sessions
       set revoked_at = now(), updated_at = now()
       where id = $1 and user_id = $2 and revoked_at is null`,
      [sessionId, userId],
    );
    if (result.rowCount !== 1) this.throwSessionError();
  }

  /** Called by the auth worker/outbox dispatcher; delivery runs outside DB locks. */
  async drainOtpDeliveries(
    limit = 10,
    challengeId?: string,
  ): Promise<{ sent: number; deferred: number }> {
    const security = this.securityConfig();
    const batchSize = Math.max(1, Math.min(Math.trunc(limit), 100));
    const sentIds: string[] = [];
    let deferred = 0;

    await this.database.pool.query(
      `update auth_otp_deliveries d
       set status = 'dead', lease_until = null, destination_ciphertext = null,
           code_ciphertext = null, last_error_code = 'challenge_expired',
           updated_at = now()
       from auth_otp_challenges c
       where d.challenge_id = c.id and d.status in ('pending', 'processing')
         and c.status in ('created', 'sent') and c.expires_at <= now()`,
    );
    await this.database.pool.query(
      `update auth_otp_challenges c
       set status = 'expired', updated_at = now()
       where c.status in ('created', 'sent') and c.expires_at <= now()`,
    );

    for (let index = 0; index < batchSize; index += 1) {
      const delivery = await this.claimOtpDelivery(challengeId);
      if (!delivery) break;
      try {
        if (!delivery.destination_ciphertext || !delivery.code_ciphertext)
          throw new Error('Challenge delivery record is missing');
        const destination = this.decrypt(
          security.encryptionKey,
          delivery.destination_ciphertext,
        );
        const code = this.decrypt(
          security.encryptionKey,
          delivery.code_ciphertext,
        );
        await this.otpDelivery.send({
          challengeId: delivery.challenge_id,
          channel: delivery.channel,
          destination,
          code,
        });
        await this.markDeliverySent(delivery);
        sentIds.push(delivery.challenge_id);
      } catch (error) {
        await this.deferDelivery(delivery, security.deliveryMaxAttempts);
        deferred += 1;
        if (error instanceof ServiceUnavailableException) {
          this.logger.warn('OTP delivery adapter unavailable');
        } else {
          this.logger.warn('OTP delivery attempt failed');
        }
      }
    }
    return { sent: sentIds.length, deferred };
  }

  private async createChallenge(input: {
    security: SecurityConfig;
    channel: OtpChannel;
    destination: string;
    identityHash: string;
    purpose: 'login' | 'campus_email';
    displayName?: string;
    userId?: string;
    campusId?: string;
  }): Promise<ChallengeCreated> {
    const challengeId = randomUUID();
    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = this.hash(
      input.security.secret,
      `otp:${challengeId}:${otp}`,
    );
    const destinationCiphertext = this.encrypt(
      input.security.encryptionKey,
      input.destination,
    );
    const codeCiphertext = this.encrypt(input.security.encryptionKey, otp);
    const outcome = await this.inTransaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `${input.channel}:${input.identityHash}`,
      ]);
      const latest = await client.query<{ created_at: Date }>(
        `select created_at from auth_otp_challenges
         where channel = $1 and identity_hash = $2
         order by created_at desc limit 1`,
        [input.channel, input.identityHash],
      );
      const latestCreatedAt = latest.rows[0]?.created_at;
      if (latestCreatedAt) {
        const retryAt =
          latestCreatedAt.getTime() +
          input.security.resendCooldownSeconds * 1000;
        if (retryAt > Date.now())
          return {
            retryAfterSeconds: Math.ceil((retryAt - Date.now()) / 1000),
          };
      }
      await client.query(
        `update auth_otp_challenges
         set status = 'revoked', updated_at = now()
         where channel = $1 and identity_hash = $2
           and status in ('created', 'sent') and expires_at > now()`,
        [input.channel, input.identityHash],
      );
      await client.query(
        `update auth_otp_deliveries d
         set status = 'dead', lease_until = null, destination_ciphertext = null,
             code_ciphertext = null, last_error_code = 'challenge_replaced',
             updated_at = now()
         from auth_otp_challenges c
         where d.challenge_id = c.id and c.channel = $1 and c.identity_hash = $2
           and d.status in ('pending', 'processing') and c.status = 'revoked'`,
        [input.channel, input.identityHash],
      );
      const inserted = await client.query<{ expires_at: Date }>(
        `insert into auth_otp_challenges
           (id, user_id, campus_id, purpose, channel, identity_hash, code_hash,
            destination_ciphertext, display_name, status, max_attempts, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'created', $10,
                 now() + ($11 * interval '1 second'))
         returning expires_at`,
        [
          challengeId,
          input.userId ?? null,
          input.campusId ?? null,
          input.purpose,
          input.channel,
          input.identityHash,
          codeHash,
          destinationCiphertext,
          input.displayName ?? null,
          input.security.otpMaxAttempts,
          input.security.otpTtlSeconds,
        ],
      );
      await client.query(
        `insert into auth_otp_deliveries
           (challenge_id, channel, destination_ciphertext, code_ciphertext)
         values ($1, $2, $3, $4)`,
        [challengeId, input.channel, destinationCiphertext, codeCiphertext],
      );
      return {
        challengeId,
        expiresAt: inserted.rows[0].expires_at.toISOString(),
      };
    });
    if ('retryAfterSeconds' in outcome)
      throw new HttpException(
        {
          code: 'otp_cooldown',
          message: 'Wait before requesting another code',
          retryAfterSeconds: outcome.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    const delivery = await this.drainOtpDeliveries(1, outcome.challengeId);
    const delivered = await this.database.pool.query<{ status: string }>(
      `select status from auth_otp_deliveries where challenge_id = $1`,
      [outcome.challengeId],
    );
    if (delivered.rows[0]?.status !== 'sent' || delivery.deferred > 0)
      throw new ServiceUnavailableException({
        code: 'otp_delivery_unavailable',
        message: 'OTP delivery is temporarily unavailable',
        challengeId: outcome.challengeId,
      });
    return outcome;
  }

  private async claimOtpDelivery(
    challengeId?: string,
  ): Promise<DeliveryRow | undefined> {
    const result = await this.database.pool.query<DeliveryRow>(
      `with candidate as (
         select d.id
         from auth_otp_deliveries d
         join auth_otp_challenges c on c.id = d.challenge_id
         where ((d.status = 'pending' and d.available_at <= now())
                or (d.status = 'processing' and d.lease_until <= now()))
           and c.status = 'created' and c.expires_at > now()
           and ($1::uuid is null or d.challenge_id = $1)
         order by d.available_at, d.created_at
         for update of d skip locked
         limit 1
       )
       update auth_otp_deliveries d
       set status = 'processing', lease_until = now() + interval '30 seconds',
           attempts = d.attempts + 1, updated_at = now()
       from candidate
       where d.id = candidate.id
       returning d.id, d.challenge_id, d.channel, d.destination_ciphertext,
                 d.code_ciphertext, d.attempts`,
      [challengeId ?? null],
    );
    return result.rows[0];
  }

  private async markDeliverySent(delivery: DeliveryRow): Promise<void> {
    await this.inTransaction(async (client) => {
      const result = await client.query(
        `update auth_otp_deliveries
         set status = 'sent', sent_at = now(), lease_until = null,
             destination_ciphertext = null, code_ciphertext = null,
             last_error_code = null, updated_at = now()
         where id = $1 and status = 'processing'`,
        [delivery.id],
      );
      if (result.rowCount !== 1) return;
      await client.query(
        `update auth_otp_challenges
         set status = 'sent', updated_at = now()
         where id = $1 and status = 'created' and expires_at > now()`,
        [delivery.challenge_id],
      );
    });
  }

  private async deferDelivery(
    delivery: DeliveryRow,
    maxAttempts: number,
  ): Promise<void> {
    const exhausted = delivery.attempts >= maxAttempts;
    const delaySeconds = Math.min(60, 2 ** Math.max(0, delivery.attempts - 1));
    await this.inTransaction(async (client) => {
      await client.query(
        `update auth_otp_deliveries
         set status = $2, available_at = now() + ($3 * interval '1 second'),
             lease_until = null,
             destination_ciphertext = $5,
             code_ciphertext = $6,
             last_error_code = $4, updated_at = now()
         where id = $1 and status = 'processing'`,
        [
          delivery.id,
          exhausted ? 'dead' : 'pending',
          delaySeconds,
          exhausted ? 'delivery_attempts_exhausted' : 'delivery_retry',
          exhausted ? null : delivery.destination_ciphertext,
          exhausted ? null : delivery.code_ciphertext,
        ],
      );
      if (exhausted)
        await client.query(
          `update auth_otp_challenges
           set status = 'delivery_failed', updated_at = now()
           where id = $1 and status = 'created'`,
          [delivery.challenge_id],
        );
    });
  }

  private async lockChallenge(
    client: PoolClient,
    challengeId: string,
  ): Promise<ChallengeRow | undefined> {
    const result = await client.query<ChallengeRow>(
      `select id, user_id, campus_id, purpose, channel, identity_hash, code_hash,
              destination_ciphertext,
              display_name, status, attempts, max_attempts, expires_at
       from auth_otp_challenges where id = $1 for update`,
      [challengeId],
    );
    return result.rows[0];
  }

  private async lockChallengeForIdentity(
    client: PoolClient,
    challengeId: string,
  ): Promise<ChallengeRow | undefined> {
    const initial = await client.query<{
      channel: OtpChannel;
      identity_hash: string;
    }>(`select channel, identity_hash from auth_otp_challenges where id = $1`, [
      challengeId,
    ]);
    const key = initial.rows[0];
    if (!key) return undefined;
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `${key.channel}:${key.identity_hash}`,
    ]);
    const challenge = await this.lockChallenge(client, challengeId);
    if (
      !challenge ||
      challenge.channel !== key.channel ||
      challenge.identity_hash !== key.identity_hash
    )
      return undefined;
    return challenge;
  }

  private checkChallenge(challenge: ChallengeRow): string | undefined {
    if (challenge.expires_at.getTime() <= Date.now()) {
      return 'challenge_expired';
    }
    if (challenge.status === 'locked') return 'otp_locked';
    if (challenge.status !== 'sent') return 'challenge_invalid';
    if (challenge.attempts >= challenge.max_attempts) return 'otp_locked';
    return undefined;
  }

  private codeMatches(
    secret: Buffer,
    challenge: ChallengeRow,
    code: string,
  ): boolean {
    if (!/^\d{6}$/.test(code)) return false;
    const candidate = this.hash(secret, `otp:${challenge.id}:${code}`);
    const expectedBuffer = Buffer.from(challenge.code_hash, 'hex');
    const candidateBuffer = Buffer.from(candidate, 'hex');
    return (
      expectedBuffer.length === candidateBuffer.length &&
      timingSafeEqual(expectedBuffer, candidateBuffer)
    );
  }

  private async createSessionInTransaction(
    client: PoolClient,
    security: SecurityConfig,
    userId: string,
  ): Promise<{ id: string; token: string; expiresAt: string }> {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + security.sessionTtlSeconds * 1000);
    const tokenHash = this.hash(security.secret, `session:${token}`);
    await client.query(
      `insert into auth_sessions (id, user_id, token_hash, expires_at)
       values ($1, $2, $3, $4)`,
      [id, userId, tokenHash, expires],
    );
    return { id, token, expiresAt: expires.toISOString() };
  }

  private async inTransaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('begin');
      const result = await callback(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private securityConfig(): SecurityConfig {
    const secretText = this.config.get<string>('AUTH_SECRET');
    const encryptionKeyText = this.config.get<string>('AUTH_ENCRYPTION_KEY');
    if (!secretText || Buffer.byteLength(secretText, 'utf8') < 32)
      throw new ServiceUnavailableException({
        code: 'auth_not_configured',
        message: 'Authentication is not configured',
      });
    if (!encryptionKeyText)
      throw new ServiceUnavailableException({
        code: 'auth_not_configured',
        message: 'Authentication is not configured',
      });
    const encryptionKey = Buffer.from(encryptionKeyText, 'base64');
    if (encryptionKey.length !== 32)
      throw new ServiceUnavailableException({
        code: 'auth_not_configured',
        message: 'Authentication is not configured',
      });
    return {
      secret: Buffer.from(secretText, 'utf8'),
      encryptionKey,
      otpTtlSeconds: this.configuredInt(
        'AUTH_OTP_TTL_SECONDS',
        AUTH_SECURITY_DEFAULTS.otpTtlSeconds,
        60,
        600,
      ),
      otpMaxAttempts: this.configuredInt(
        'AUTH_OTP_MAX_ATTEMPTS',
        AUTH_SECURITY_DEFAULTS.otpMaxAttempts,
        1,
        10,
      ),
      resendCooldownSeconds: this.configuredInt(
        'AUTH_OTP_RESEND_COOLDOWN_SECONDS',
        AUTH_SECURITY_DEFAULTS.otpResendCooldownSeconds,
        30,
        300,
      ),
      sessionTtlSeconds: this.configuredInt(
        'AUTH_SESSION_TTL_SECONDS',
        AUTH_SECURITY_DEFAULTS.sessionTtlSeconds,
        300,
        24 * 60 * 60,
      ),
      deliveryMaxAttempts: this.configuredInt(
        'AUTH_OTP_DELIVERY_MAX_ATTEMPTS',
        AUTH_SECURITY_DEFAULTS.otpDeliveryMaxAttempts,
        1,
        10,
      ),
    };
  }

  private configuredInt(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = this.config.get<number>(key, fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new ServiceUnavailableException({
        code: 'auth_not_configured',
        message: 'Authentication is not configured',
      });
    return value;
  }

  private normalizeDestination(channel: OtpChannel, value: string): string {
    const normalized = value.trim().normalize('NFKC');
    if (channel === 'phone') {
      if (!/^\+[1-9]\d{7,14}$/.test(normalized))
        throw new BadRequestException({
          code: 'invalid_phone',
          message: 'Phone must use E.164 format',
        });
      return normalized;
    }
    const email = normalized.toLowerCase();
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException({
        code: 'invalid_email',
        message: 'Enter a valid email address',
      });
    if (!this.isValidHostname(email.slice(email.lastIndexOf('@') + 1)))
      throw new BadRequestException({
        code: 'invalid_email',
        message: 'Enter a valid email address',
      });
    return email;
  }

  private isValidHostname(domain: string): boolean {
    return (
      domain.length <= 253 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    );
  }

  private normalizeDisplayName(value?: string): string | undefined {
    const displayName = value?.trim().normalize('NFKC');
    if (!displayName) return undefined;
    if (displayName.length > 200)
      throw new BadRequestException({
        code: 'invalid_display_name',
        message: 'Display name is too long',
      });
    return displayName;
  }

  private hash(secret: Buffer, value: string): string {
    return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
  }

  private encrypt(key: Buffer, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  private decrypt(key: Buffer, value: string): string {
    const payload = Buffer.from(value, 'base64');
    if (payload.length < 29) throw new Error('Invalid encrypted auth payload');
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  private throwChallengeError(code: string): never {
    if (code === 'otp_locked')
      throw new HttpException(
        {
          code: 'otp_locked',
          message: 'The verification code cannot be used',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (code === 'challenge_expired')
      throw new BadRequestException({
        code: 'otp_expired',
        message: 'The verification code expired',
      });
    if (code === 'otp_invalid')
      throw new BadRequestException({
        code: 'otp_invalid',
        message: 'The verification code is invalid',
      });
    if (code === 'campus_email_in_use')
      throw new ConflictException({
        code,
        message: 'This campus email cannot be linked to the account',
      });
    if (
      code === 'campus_email_domain_not_allowed' ||
      code === 'account_unavailable'
    )
      throw new BadRequestException({
        code: 'challenge_invalid',
        message: 'The verification code is invalid or cannot be used',
      });
    if (code === 'challenge_purpose_mismatch')
      throw new BadRequestException({
        code: 'challenge_invalid',
        message: 'The verification code is invalid',
      });
    throw new BadRequestException({
      code: 'challenge_invalid',
      message: 'The verification code is invalid or has already been used',
    });
  }

  private throwSessionError(): never {
    throw new UnauthorizedException({
      code: 'session_invalid',
      message: 'The session is invalid or expired',
    });
  }
}
