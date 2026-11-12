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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  })
  list(
    @CurrentUser() user: { userId: string },
    @Query() query: NotificationsQueryDto,
  ) {
    return this.notifications.list(user.userId, query.limit, query.cursor);
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
