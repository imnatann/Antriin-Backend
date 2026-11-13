import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { SandboxWebhookEventDto } from './dto/sandbox-webhook.dto';
import { PaymentsService } from './payments.service';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  verifyWebhookRequest,
} from './webhook-signature';

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Server-to-server sandbox provider webhook. Authentication is HMAC-SHA256
 * over timestamp + '.' + exactRawBody (separate signature and timestamp
 * headers), NOT a bearer session. The signature is verified over the exact
 * raw bytes before any state change; the validated DTO is used only for typed
 * field access. This endpoint never trusts client-supplied balance/status.
 */
@ApiTags('Payments')
@Controller('webhooks/payments')
export class PaymentsWebhookController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  @Post(':provider')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive a sandbox provider top-up webhook (HMAC authenticated)',
  })
  @ApiParam({ name: 'provider', enum: ['sandbox'] })
  @ApiHeader({
    name: WEBHOOK_SIGNATURE_HEADER,
    description: 'HMAC-SHA256 hex over timestamp + dot + exactRawBody',
    required: true,
  })
  @ApiHeader({
    name: WEBHOOK_TIMESTAMP_HEADER,
    description: 'Unix seconds; must be within 300s of server time',
    required: true,
  })
  @ApiBody({ type: SandboxWebhookEventDto })
  @ApiOkResponse({ description: 'Event applied, deduplicated, or ignored' })
  @ApiBadRequestResponse({
    description:
      'Malformed event body. NOTE (review P2-02): the global ValidationPipe runs before the handler, so a malformed body is rejected with 400 even when signature headers are missing; well-formed bodies with missing/invalid credentials are rejected with 401 before any state change.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid signature or stale timestamp',
  })
  @ApiNotFoundResponse({ description: 'Unsupported provider' })
  @ApiConflictResponse({
    description: 'Event id reused with a different payload',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Reference unmatched or amount/currency/state mismatch; no credit',
  })
  async handle(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest,
    @Body() body: SandboxWebhookEventDto,
  ) {
    if (provider !== 'sandbox')
      throw new NotFoundException({
        code: 'WEBHOOK_PROVIDER_UNSUPPORTED',
        message: 'Unsupported payments provider',
      });
    const rawBody = request.rawBody;
    const verification = verifyWebhookRequest({
      secret: this.config.get<string>('PAYMENTS_SANDBOX_WEBHOOK_SECRET') ?? '',
      timestampHeader: request.headers[WEBHOOK_TIMESTAMP_HEADER],
      signatureHeader: request.headers[WEBHOOK_SIGNATURE_HEADER],
      rawBody,
    });
    if (!verification.ok)
      throw new UnauthorizedException({
        code: verification.code,
        message: 'Webhook authentication failed',
      });

    const result = await this.payments.handleProviderEvent(
      rawBody as Buffer,
      body,
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
        throw new UnprocessableEntityException({
          code: 'PAYMENT_EVENT_UNMATCHED',
          message: 'Provider reference does not match any top-up intent',
        });
    }
  }
}
