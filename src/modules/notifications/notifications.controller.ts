import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { NotificationsService } from './notifications.service';
import { NotificationsQueryDto } from './notifications.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get()
  @ApiOperation({
    summary: 'List your in-app notifications; external delivery is not enabled',
    description:
      'Newest first, cursor-paged. meta.unreadCount is the total number of your unread notifications; ?unread=true narrows the page to unread rows only.',
  })
  @ApiOkResponse({
    description:
      'Cursor-paged notifications plus meta.unreadCount (independent of the unread filter)',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              template: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  aggregateType: { type: 'string' },
                  aggregateId: { type: 'string', format: 'uuid' },
                },
                required: ['aggregateType', 'aggregateId'],
              },
              createdAt: { type: 'string', format: 'date-time' },
              readAt: { type: 'string', format: 'date-time', nullable: true },
            },
            required: ['id', 'template', 'data', 'createdAt', 'readAt'],
          },
        },
        meta: {
          type: 'object',
          properties: {
            nextCursor: { type: 'string', nullable: true },
            unreadCount: { type: 'integer', minimum: 0 },
          },
          required: ['nextCursor', 'unreadCount'],
        },
      },
      required: ['data', 'meta'],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  list(
    @CurrentUser() user: { userId: string },
    @Query() query: NotificationsQueryDto,
  ) {
    return this.notifications.list(
      user.userId,
      query.limit,
      query.cursor,
      query.unread,
    );
  }
  @Post(':id/read')
  @HttpCode(204)
  markRead(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(user.userId, id);
  }
}
