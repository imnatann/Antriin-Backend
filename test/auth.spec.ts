import 'reflect-metadata';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../src/database/database.service';
import { RedisService } from '../src/infrastructure/redis.service';
import { AUTH_OTP_DELIVERY } from '../src/modules/auth/auth.constants';
import type { OtpDeliveryMessage } from '../src/modules/auth/auth.constants';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { AuthRateLimitGuard } from '../src/modules/auth/auth-rate-limit.guard';
import { AuthService } from '../src/modules/auth/auth.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testSecret = randomBytes(48).toString('base64url');
const testEncryptionKey = randomBytes(32).toString('base64');

class CapturingOtpDelivery {
  readonly messages: OtpDeliveryMessage[] = [];
  failNextSend = false;

  async send(message: OtpDeliveryMessage): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('controlled delivery failure');
    }
    this.messages.push(message);
  }

  forChallenge(challengeId: string): OtpDeliveryMessage | undefined {
    return this.messages.find((message) => message.challengeId === challengeId);
  }
}

class MemoryRedis {
  readonly counts = new Map<string, number>();

  readonly client = {
    eval: async (
      _script: string,
      _numKeys: number,
      key: string,
      _ttl: number,
    ) => {
      void _ttl;
      const count = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, count);
      return count;
    },
  };

  async ping(): Promise<void> {}
}

describe(
  'Auth HTTP and PostgreSQL contract',
  { skip: !testDatabaseUrl },
  () => {
    let app: NestFastifyApplication;
    let pool: Pool;
    let delivery: CapturingOtpDelivery;
    let memoryRedis: MemoryRedis;
    let secret: string;
    const challengeIds: string[] = [];
    const userIds: string[] = [];
    const campusIds: string[] = [];
    const domainIds: string[] = [];

    before(async () => {
      pool = new Pool({ connectionString: testDatabaseUrl });
      delivery = new CapturingOtpDelivery();
      memoryRedis = new MemoryRedis();
      secret = testSecret;
      const configValues: Record<string, string | number> = {
        AUTH_SECRET: secret,
        AUTH_ENCRYPTION_KEY: testEncryptionKey,
        AUTH_OTP_TTL_SECONDS: 300,
        AUTH_OTP_MAX_ATTEMPTS: 5,
        AUTH_OTP_RESEND_COOLDOWN_SECONDS: 60,
        AUTH_SESSION_TTL_SECONDS: 86400,
        AUTH_OTP_DELIVERY_MAX_ATTEMPTS: 5,
      };
      const config = {
        get: <T>(key: string, fallback?: T): T | undefined =>
          (configValues[key] as T | undefined) ?? fallback,
      };
      const module = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          AuthService,
          AuthGuard,
          AuthRateLimitGuard,
          { provide: DatabaseService, useValue: { pool } },
          { provide: ConfigService, useValue: config },
          { provide: RedisService, useValue: memoryRedis },
          { provide: AUTH_OTP_DELIVERY, useValue: delivery },
        ],
      }).compile();
      app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      app.setGlobalPrefix('api/v1');
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    after(async () => {
      await app?.close();
      await pool?.end();
    });

    afterEach(async () => {
      memoryRedis?.counts.clear();
      delivery?.messages.splice(0);
      if (delivery) delivery.failNextSend = false;
      if (!pool) return;
      await pool.query(
        `delete from auth_otp_deliveries where challenge_id = any($1::uuid[])`,
        [challengeIds],
      );
      await pool.query(
        `delete from auth_otp_challenges where id = any($1::uuid[])`,
        [challengeIds],
      );
      await pool.query(
        `delete from campus_email_verifications where user_id = any($1::uuid[])`,
        [userIds],
      );
      await pool.query(
        `delete from auth_sessions where user_id = any($1::uuid[])`,
        [userIds],
      );
      await pool.query(
        `delete from auth_identities where user_id = any($1::uuid[])`,
        [userIds],
      );
      await pool.query(`delete from users where id = any($1::uuid[])`, [
        userIds,
      ]);
      await pool.query(
        `delete from campus_email_domains where id = any($1::uuid[])`,
        [domainIds],
      );
      await pool.query(`delete from campuses where id = any($1::uuid[])`, [
        campusIds,
      ]);
      challengeIds.splice(0);
      userIds.splice(0);
      campusIds.splice(0);
      domainIds.splice(0);
    });

    it('creates an OTP account once, stores only protected secrets, and authenticates bearer sessions', async () => {
      const destination = `login-${randomUUID()}@example.test`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'email', destination },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.body.includes(destination), false);
      const challengeId = created.json().data.challengeId as string;
      challengeIds.push(challengeId);
      const delivered = delivery.forChallenge(challengeId);
      assert.ok(delivered);
      const verified = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/otp-challenges/${challengeId}/verify`,
        payload: { code: delivered.code },
      });
      assert.equal(verified.statusCode, 200);
      const verifiedData = verified.json().data;
      assert.equal(typeof verifiedData.sessionToken, 'string');
      assert.equal(verifiedData.sessionToken.length >= 40, true);
      const userId = verifiedData.user.id as string;
      userIds.push(userId);

      const secondUse = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/otp-challenges/${challengeId}/verify`,
        payload: { code: delivered.code },
      });
      assert.equal(secondUse.statusCode, 400);

      const storedChallenge = await pool.query<{
        status: string;
        code_hash: string;
        destination_ciphertext: string;
      }>(
        `select status, code_hash, destination_ciphertext
       from auth_otp_challenges where id = $1`,
        [challengeId],
      );
      assert.equal(storedChallenge.rows[0].status, 'consumed');
      assert.notEqual(storedChallenge.rows[0].code_hash, delivered.code);
      assert.notEqual(
        storedChallenge.rows[0].destination_ciphertext,
        destination,
      );
      const storedDelivery = await pool.query<{
        status: string;
        destination_ciphertext: string | null;
        code_ciphertext: string | null;
      }>(
        `select status, destination_ciphertext, code_ciphertext
       from auth_otp_deliveries where challenge_id = $1`,
        [challengeId],
      );
      assert.equal(storedDelivery.rows[0].status, 'sent');
      assert.equal(storedDelivery.rows[0].destination_ciphertext, null);
      assert.equal(storedDelivery.rows[0].code_ciphertext, null);
      const expectedTokenHash = createHmac('sha256', secret)
        .update(`session:${verifiedData.sessionToken}`)
        .digest('hex');
      const storedSession = await pool.query<{ token_hash: string }>(
        `select token_hash from auth_sessions where user_id = $1`,
        [userId],
      );
      assert.equal(storedSession.rows[0].token_hash, expectedTokenHash);
      assert.notEqual(
        storedSession.rows[0].token_hash,
        verifiedData.sessionToken,
      );

      const status = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/campus-email-verifications/current',
        headers: { authorization: `Bearer ${verifiedData.sessionToken}` },
      });
      assert.equal(status.statusCode, 200);
      assert.deepEqual(status.json().data, { verified: false });
    });

    it('locks a challenge after five incorrect attempts and never returns a session', async () => {
      const destination = `attempt-${randomUUID()}@example.test`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'email', destination },
      });

      const challengeId = created.json().data.challengeId as string;
      challengeIds.push(challengeId);
      const delivered = delivery.forChallenge(challengeId);
      assert.ok(delivered);
      const wrongCode = delivered.code === '000000' ? '000001' : '000000';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/auth/otp-challenges/${challengeId}/verify`,
          payload: { code: wrongCode },
        });
        assert.equal(response.statusCode, attempt === 4 ? 429 : 400);
        assert.equal(response.body.includes('sessionToken'), false);
      }
      const lockedChallenge = await pool.query<{
        status: string;
        attempts: number;
      }>(`select status, attempts from auth_otp_challenges where id = $1`, [
        challengeId,
      ]);
      assert.equal(lockedChallenge.rows[0].status, 'locked');
      assert.equal(lockedChallenge.rows[0].attempts, 5);
    });

    it('enforces identity resend cooldown and rejects an expired challenge', async () => {
      const destination = `cooldown-${randomUUID()}@example.test`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'email', destination },
      });
      assert.equal(created.statusCode, 201);
      const challengeId = created.json().data.challengeId as string;
      challengeIds.push(challengeId);
      const cooldown = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'email', destination },
      });
      assert.equal(cooldown.statusCode, 429);
      await pool.query(
        `update auth_otp_challenges set expires_at = now() - interval '1 second'
         where id = $1`,
        [challengeId],
      );
      const delivered = delivery.forChallenge(challengeId);
      assert.ok(delivered);
      const expired = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/otp-challenges/${challengeId}/verify`,
        payload: { code: delivered.code },
      });
      assert.equal(expired.statusCode, 400);
      const stored = await pool.query<{ status: string }>(
        `select status from auth_otp_challenges where id = $1`,
        [challengeId],
      );
      assert.equal(stored.rows[0].status, 'sent');
    });

    it('persists failed OTP delivery for an idempotent worker retry', async () => {
      const destination = `retry-${randomUUID()}@example.test`;
      delivery.failNextSend = true;
      const failedDelivery = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'email', destination },
      });
      assert.equal(failedDelivery.statusCode, 503);
      const challengeId = failedDelivery.json().challengeId as string;
      challengeIds.push(challengeId);
      const pending = await pool.query<{
        status: string;
        attempts: number;
        destination_ciphertext: string | null;
        code_ciphertext: string | null;
      }>(
        `select d.status, d.attempts, d.destination_ciphertext, d.code_ciphertext
         from auth_otp_deliveries d where d.challenge_id = $1`,
        [challengeId],
      );
      assert.equal(pending.rows[0].status, 'pending');
      assert.equal(pending.rows[0].attempts, 1);
      assert.notEqual(pending.rows[0].destination_ciphertext, destination);
      assert.ok(pending.rows[0].code_ciphertext);
      await pool.query(
        `update auth_otp_deliveries set available_at = now() where challenge_id = $1`,
        [challengeId],
      );
      const auth = app.get(AuthService);
      const drained = await auth.drainOtpDeliveries(1, challengeId);
      assert.equal(drained.sent, 1);
      const delivered = delivery.forChallenge(challengeId);
      assert.ok(delivered);
      const stored = await pool.query<{
        status: string;
        destination_ciphertext: string | null;
        code_ciphertext: string | null;
      }>(
        `select status, destination_ciphertext, code_ciphertext
         from auth_otp_deliveries where challenge_id = $1`,
        [challengeId],
      );
      assert.equal(stored.rows[0].status, 'sent');
      assert.equal(stored.rows[0].destination_ciphertext, null);
      assert.equal(stored.rows[0].code_ciphertext, null);
    });

    it('rotates and revokes opaque sessions atomically', async () => {
      const destination = `rotate-${randomUUID()}@example.test`;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'email', destination, displayName: 'Test User' },
      });
      const challengeId = created.json().data.challengeId as string;
      challengeIds.push(challengeId);
      const delivered = delivery.forChallenge(challengeId);
      assert.ok(delivered);
      const login = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/otp-challenges/${challengeId}/verify`,
        payload: { code: delivered.code },
      });
      const userId = login.json().data.user.id as string;
      userIds.push(userId);
      const oldToken = login.json().data.sessionToken as string;
      const refreshed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/refresh',
        headers: { authorization: `Bearer ${oldToken}` },
      });
      assert.equal(refreshed.statusCode, 200);
      const newToken = refreshed.json().data.sessionToken as string;
      assert.notEqual(newToken, oldToken);
      const oldSessionResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/campus-email-verifications/current',
        headers: { authorization: `Bearer ${oldToken}` },
      });
      assert.equal(oldSessionResponse.statusCode, 401);
      const newSessionResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/campus-email-verifications/current',
        headers: { authorization: `Bearer ${newToken}` },
      });
      assert.equal(newSessionResponse.statusCode, 200);
      const revoked = await app.inject({
        method: 'DELETE',
        url: '/api/v1/auth/sessions/current',
        headers: { authorization: `Bearer ${newToken}` },
      });
      assert.equal(revoked.statusCode, 200);
      const afterRevoke = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/campus-email-verifications/current',
        headers: { authorization: `Bearer ${newToken}` },
      });
      assert.equal(afterRevoke.statusCode, 401);
    });

    it('validates runtime DTOs and rejects unknown fields', async () => {
      const invalidChannel = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'sms', destination: 'user@example.test' },
      });
      assert.equal(invalidChannel.statusCode, 400);
      const unknownField = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: {
          channel: 'email',
          destination: `unknown-${randomUUID()}@example.test`,
          userId: randomUUID(),
        },
      });
      assert.equal(unknownField.statusCode, 400);
    });

    it('keeps campus email verification separate and requires a verified active domain', async () => {
      const loginEmail = `student-${randomUUID()}@example.test`;
      const loginChallenge = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp-challenges',
        payload: { channel: 'email', destination: loginEmail },
      });
      const loginChallengeId = loginChallenge.json().data.challengeId as string;
      challengeIds.push(loginChallengeId);
      const loginOtp = delivery.forChallenge(loginChallengeId);
      assert.ok(loginOtp);
      const login = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/otp-challenges/${loginChallengeId}/verify`,
        payload: { code: loginOtp.code },
      });
      const userId = login.json().data.user.id as string;
      const token = login.json().data.sessionToken as string;
      userIds.push(userId);

      const campusId = randomUUID();
      const domainId = randomUUID();
      const domain = `campus-${randomUUID().replaceAll('-', '')}.example.test`;
      campusIds.push(campusId);
      domainIds.push(domainId);
      await pool.query(
        `insert into campuses (id, name, timezone, status)
       values ($1, $2, 'Asia/Jakarta', 'active')`,
        [campusId, `Auth test ${campusId}`],
      );
      await pool.query(
        `insert into campus_email_domains
         (id, campus_id, domain, active, verified_at)
       values ($1, $2, $3, true, now())`,
        [domainId, campusId, domain],
      );
      const campusEmail = `buyer@${domain}`;
      const request = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/campus-email-verifications',
        headers: { authorization: `Bearer ${token}` },
        payload: { email: campusEmail },
      });
      assert.equal(request.statusCode, 201);
      const challengeId = request.json().data.challengeId as string;
      challengeIds.push(challengeId);
      const verificationOtp = delivery.forChallenge(challengeId);
      assert.ok(verificationOtp);
      const verified = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/campus-email-verifications/${challengeId}/verify`,
        headers: { authorization: `Bearer ${token}` },
        payload: { code: verificationOtp.code },
      });
      assert.equal(verified.statusCode, 200);
      assert.equal(verified.json().data.verified, true);
      const current = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/campus-email-verifications/current',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(current.json().data.campusId, campusId);
      const linkedIdentity = await pool.query<{ user_id: string }>(
        `select user_id from auth_identities where channel = 'email' and user_id = $1`,
        [userId],
      );
      assert.equal(linkedIdentity.rowCount, 2);
    });
  },
);
