import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { PaymentsService } from './payments.service';
import type { ProviderTopupEvent } from './payments.service';

/** Header Xendit uses to prove a callback really came from Xendit. */
export const XENDIT_CALLBACK_TOKEN_HEADER = 'x-callback-token';

/**
 * Xendit status vocabulary mapped to the domain's four provider statuses.
 *
 * Xendit also reports ACTIVE and PENDING, which describe the QR itself rather
 * than a payment; both map to 'pending' and are ignored by the settlement
 * logic, exactly like a sandbox 'pending' event.
 */
const STATUS_MAP: Record<string, ProviderTopupEvent['status']> = {
  SUCCEEDED: 'succeeded',
  COMPLETED: 'succeeded',
  PAID: 'succeeded',
  EXPIRED: 'expired',
  FAILED: 'failed',
  ACTIVE: 'pending',
  PENDING: 'pending',
};

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Xendit QR Code callback.
 *
 * Authentication differs from the sandbox webhook on purpose: Xendit sends a
 * static token in the `x-callback-token` header rather than an HMAC over the
 * body, so this endpoint compares that header in constant time. Forcing
 * Xendit through the HMAC scheme would have meant rejecting every real
 * callback.
 *
 * The body is NOT validated by a class DTO: the global ValidationPipe runs
 * with whitelist + forbidNonWhitelisted, and Xendit sends fields we do not
 * model (basket, payment_detail, channel_code, ...). A DTO would reject every
 * genuine callback. Fields are read defensively instead, and anything missing
 * or malformed is a 400 before any state changes.
 */
@ApiTags('Payments')
@Controller('webhooks/payments')
export class XenditWebhookController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  @Post('xendit')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Receive a Xendit QR payment callback (x-callback-token authenticated)',
  })
  @ApiHeader({
    name: XENDIT_CALLBACK_TOKEN_HEADER,
    description: 'Verification token configured in the Xendit dashboard',
    required: true,
  })
  @ApiOkResponse({ description: 'Callback applied, deduplicated, or ignored' })
  @ApiUnauthorizedResponse({ description: 'Wrong or missing callback token' })
  async handle(@Req() request: RawBodyRequest, @Body() body: unknown) {
    if (this.payments.providerMode() !== 'xendit')
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_PROVIDER_DISABLED',
        message:
          'Xendit callbacks are not accepted while payments are disabled',
      });
    this.assertCallbackToken(request.headers[XENDIT_CALLBACK_TOKEN_HEADER]);

    const event = this.parseEvent(body);
    const result = await this.payments.handleProviderEvent(
      // The raw bytes are hashed for dedupe, so the exact payload that was
      // signed is what gets recorded rather than a re-serialised copy.
      request.rawBody ?? Buffer.from(JSON.stringify(body), 'utf8'),
      event,
      'xendit',
    );
    switch (result.kind) {
      case 'applied':
        return { data: { outcome: 'applied', status: result.status } };
      case 'duplicate':
        return {
          data: {
            outcome: 'duplicate',
            previousOutcome: result.previousOutcome,
          },
        };
      case 'ignored':
        return { data: { outcome: 'ignored' } };
      case 'conflict':
        throw new ConflictException({
          code: 'WEBHOOK_EVENT_CONFLICT',
          message: 'Event id was already processed with a different payload',
        });
      case 'mismatch':
        throw new UnprocessableEntityException({
          code: 'PAYMENT_EVENT_MISMATCH',
          message:
            'Provider event does not match the stored intent (' +
            result.reason +
            ')',
        });
      case 'unmatched':
        // A reference we do not know is answered 200, not 422. Two reasons:
        // Xendit retries non-2xx deliveries, so a 422 for an old or foreign
        // reference would be retried forever; and the dashboard's "test
        // webhook" button sends a sample reference that cannot match any real
        // intent, and refuses to save the URL unless that probe returns 2xx.
        // Nothing is credited either way — the event is still recorded with
        // outcome 'unmatched' and topup_id NULL for reconciliation.
        return {
          data: {
            outcome: 'unmatched',
            note: 'Reference does not match any top-up intent; recorded, not credited',
          },
        };
    }
  }

  /**
   * Constant-time comparison. Fail closed when the token is not configured:
   * an unset secret must never mean "accept everything".
   */
  private assertCallbackToken(header: unknown): void {
    const expected = this.config.get<string>('XENDIT_CALLBACK_TOKEN') ?? '';
    const provided = typeof header === 'string' ? header : '';
    if (!expected || !provided)
      throw new UnauthorizedException({
        code: 'WEBHOOK_CREDENTIALS_MISSING',
        message: 'Webhook authentication failed',
      });
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new UnauthorizedException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Webhook authentication failed',
      });
  }

  /**
   * Reads the fields the settlement logic needs out of Xendit's payload.
   *
   * Xendit wraps some callbacks in `{ event, data }` and sends others flat, so
   * both shapes are accepted. The payment id is preferred as the dedupe key
   * because it is unique per payment; when it is absent the reference and
   * status still identify the transition, and the payload hash recorded by the
   * service keeps two different payments from colliding.
   */
  private parseEvent(body: unknown): ProviderTopupEvent {
    if (typeof body !== 'object' || body === null)
      throw new BadRequestException({
        code: 'PAYMENT_EVENT_INVALID',
        message: 'Callback body must be a JSON object',
      });
    const envelope = body as Record<string, unknown>;
    const payload =
      typeof envelope.data === 'object' && envelope.data !== null
        ? (envelope.data as Record<string, unknown>)
        : envelope;

    const reference = payload.reference_id ?? envelope.reference_id;
    if (typeof reference !== 'string' || reference.length === 0)
      throw new BadRequestException({
        code: 'PAYMENT_EVENT_INVALID',
        message: 'Callback is missing reference_id',
      });

    const rawStatus = payload.status ?? envelope.status;
    const status =
      typeof rawStatus === 'string'
        ? STATUS_MAP[rawStatus.toUpperCase()]
        : null;
    if (!status)
      throw new BadRequestException({
        code: 'PAYMENT_EVENT_INVALID',
        message: 'Callback has an unrecognised status',
      });

    // Xendit sends the amount as a JSON number; it is an integer in the
    // smallest currency unit, which is exactly our money model.
    const rawAmount = payload.amount ?? envelope.amount;
    const amount =
      typeof rawAmount === 'number'
        ? rawAmount
        : typeof rawAmount === 'string'
          ? Number(rawAmount)
          : NaN;
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new BadRequestException({
        code: 'PAYMENT_EVENT_INVALID',
        message: 'Callback has an invalid amount',
      });

    const currency = payload.currency ?? envelope.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
      throw new BadRequestException({
        code: 'PAYMENT_EVENT_INVALID',
        message: 'Callback has an invalid currency',
      });

    const created = payload.created ?? envelope.created;
    const occurredAt =
      typeof created === 'string' && !Number.isNaN(Date.parse(created))
        ? new Date(created).toISOString()
        : new Date().toISOString();

    const paymentId = payload.id ?? envelope.id;
    const qrId = payload.qr_id ?? envelope.qr_id;
    const eventId =
      typeof paymentId === 'string' && paymentId.length > 0
        ? paymentId
        : typeof qrId === 'string' && qrId.length > 0
          ? qrId + ':' + status
          : reference + ':' + status;

    return {
      eventId,
      reference,
      status,
      amountMinor: String(amount),
      currency,
      occurredAt,
    };
  }
}
