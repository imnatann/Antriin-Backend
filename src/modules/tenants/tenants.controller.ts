import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { ArchiveTenantDto } from '../campuses/dto/archive-tenant.dto';
import { CreateTenantDto } from '../campuses/dto/create-tenant.dto';
import { UpdateTenantDto } from '../campuses/dto/update-tenant.dto';
import { TenantsService } from './tenants.service';

@ApiTags('Tenants')
@Controller()
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get('tenants')
  @ApiOperation({ summary: 'List active-campus tenants' })
  list(
    @Query('campusId') campusId?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    return this.tenants.list({ campusId, limit });
  }

  @Get('tenants/:tenantId')
  @ApiOperation({ summary: 'Get tenant details and campus timezone' })
  get(@Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.tenants.get(tenantId);
  }

  @Post('campuses/:campusId/tenants')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a tenant in an authorized campus' })
  create(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Body() dto: CreateTenantDto,
  ) {
    return this.tenants.create(principal.userId, campusId, dto);
  }

  @Patch('campuses/:campusId/tenants/:tenantId')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update tenant details with an expected timestamp' })
  update(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenants.update(principal.userId, campusId, tenantId, dto);
  }

  @Delete('campuses/:campusId/tenants/:tenantId')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Archive a tenant without deleting its history' })
  archive(
    @CurrentUser() principal: { userId: string; sessionId: string },
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: ArchiveTenantDto,
  ) {
    return this.tenants.archive(
      principal.userId,
      campusId,
      tenantId,
      dto.expectedUpdatedAt,
    );
  }
}
