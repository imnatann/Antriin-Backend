import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { CurrentUser } from '../auth/auth.guard';
import {
  EVENTS_STREAM_OPTIONS,
  type EventsStreamOptions,
} from './events.constants';
import { EventsAuthGuard } from './events-auth.guard';
import { EventsStreamQueryDto } from './events.dto';
import { EventsStream } from './events-stream';
import { EventsService } from './events.service';
import { uuidPattern } from '../notifications/outbox.service';

/**
 * Real-time delivery of in-app notifications.
 *
 * Server-Sent Events rather than WebSockets: the flow is one-way (server to
 * client), it needs no extra protocol server, and it degrades to the existing
 * GET /me/notifications poll when a proxy strips streaming.
 */
@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    @Inject(EVENTS_STREAM_OPTIONS)
    private readonly options: EventsStreamOptions,
  ) {}

  @Get('stream')
  @UseGuards(EventsAuthGuard)
  @ApiBearerAuth()
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Stream your notifications as Server-Sent Events',
    description:
      'Authenticated by the Authorization header or, because EventSource cannot set headers, by ?access_token=. The stream opens with a ready event, then sends a heartbeat comment every 15 seconds and one notification event per new row addressed to the caller, polled from the notifications table. Send last_event_id (or the Last-Event-ID header) when reconnecting to resume after the last delivered event. The connection ends after 15 minutes with a reconnect event; open a new stream from the last event id.',
  })
  @ApiOkResponse({
    description:
      'text/event-stream. Events: ready, notification, reconnect; a heartbeat comment when idle.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiUnauthorizedResponse({
    description:
      'Missing or invalid bearer token in the header or access_token query parameter',
  })
  @ApiBadRequestResponse({
    description:
      'Invalid last_event_id or Last-Event-ID (EVENTS_INVALID_LAST_EVENT_ID), or an unknown query parameter',
  })
  async stream(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: EventsStreamQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const lastEventId = query.last_event_id ?? this.headerLastEventId(request);
    // Resolve the cursor before anything is written: an unusable resume point
    // must still be an ordinary 400 JSON response, not a stream that starts
    // somewhere the client did not ask for.
    const cursor = await this.events.startCursor(user.userId, lastEventId);
    const stream = new EventsStream(reply, {
      userId: user.userId,
      cursor,
      options: this.options,
      feed: this.events,
    });
    await stream.start();
  }

  private headerLastEventId(request: FastifyRequest): string | undefined {
    const header = request.headers['last-event-id'];
    if (header === undefined) return undefined;
    if (typeof header !== 'string' || !uuidPattern.test(header))
      throw new BadRequestException({
        code: 'EVENTS_INVALID_LAST_EVENT_ID',
        message:
          'Last-Event-ID must be a notification id previously delivered to you on this stream',
      });
    return header;
  }
}
