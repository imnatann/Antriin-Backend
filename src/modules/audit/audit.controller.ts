import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { AuditService } from './audit.service';
class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() cursor?: string;
}
@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('campuses/:campusId/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}
  @Get()
  list(
    @CurrentUser() user: { userId: string },
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query() query: AuditQueryDto,
  ) {
    return this.audit.listCampus(
      user.userId,
      campusId,
      query.limit,
      query.cursor,
    );
  }
}
