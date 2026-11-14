import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedPrincipal } from '../auth/auth.guard';
import { CampusEmailDomainsService } from './campus-email-domains.service';
import {
  CreateCampusEmailDomainDto,
  DeleteCampusEmailDomainDto,
  UpdateCampusEmailDomainDto,
  VerifyCampusEmailDomainDto,
} from './dto/campus-email-domain.dto';

const domainSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    domain: { type: 'string' },
    active: { type: 'boolean' },
    verifiedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'domain', 'active', 'verifiedAt', 'createdAt', 'updatedAt'],
};

const single = {
  type: 'object',
  properties: { data: domainSchema },
  required: ['data'],
};

/**
 * Campus email domains (REQUIREMENTS §3.2, docs/ACCESS.md). AuthService accepts
 * an address only when its domain row is active AND verified, so creation
 * never pre-verifies and every mutation is audited with a reason.
 *
 * Verification is a manual attestation: no DNS ownership check exists yet.
 */
@ApiTags('Campus access')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('campuses/:campusId/email-domains')
export class CampusEmailDomainsController {
  constructor(private readonly emailDomains: CampusEmailDomainsService) {}

  @Get()
  @ApiOperation({
    summary: 'List campus email domains (campus.access.manage)',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Domains of the campus ordered by domain',
    schema: {
      type: 'object',
      properties: { data: { type: 'array', items: domainSchema } },
      required: ['data'],
    },
  })
  @ApiForbiddenResponse({
    description: 'campus.access.manage is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
  ) {
    const data = await this.emailDomains.list(principal.userId, campusId);
    return { data };
  }

  @Post()
  @ApiOperation({
    summary: 'Register a campus email domain (starts unverified)',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Domain registered', schema: single })
  @ApiBadRequestResponse({
    description:
      'Invalid domain or reason (VALIDATION_ERROR/EMAIL_DOMAIN_INVALID)',
  })
  @ApiConflictResponse({
    description: 'EMAIL_DOMAIN_TAKEN: the domain is registered to a campus',
  })
  @ApiForbiddenResponse({
    description: 'campus.access.manage is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Body() body: CreateCampusEmailDomainDto,
  ) {
    const data = await this.emailDomains.create(
      principal.userId,
      campusId,
      body,
    );
    return { data };
  }

  @Post(':domainId/verify')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Record manual verification of a domain (no DNS check; audited, idempotent)',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiParam({ name: 'domainId', format: 'uuid' })
  @ApiOkResponse({
    description: 'The domain; an already verified domain is returned unchanged',
    schema: single,
  })
  @ApiBadRequestResponse({ description: 'Invalid reason' })
  @ApiNotFoundResponse({ description: 'Domain not found in this campus' })
  @ApiForbiddenResponse({
    description: 'campus.access.manage is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async verify(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: VerifyCampusEmailDomainDto,
  ) {
    const data = await this.emailDomains.verify(
      principal.userId,
      campusId,
      domainId,
      body,
    );
    return { data };
  }

  @Patch(':domainId')
  @ApiOperation({
    summary: 'Activate or deactivate a campus email domain',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiParam({ name: 'domainId', format: 'uuid' })
  @ApiOkResponse({ description: 'The updated domain', schema: single })
  @ApiBadRequestResponse({ description: 'Invalid active flag or reason' })
  @ApiNotFoundResponse({ description: 'Domain not found in this campus' })
  @ApiForbiddenResponse({
    description: 'campus.access.manage is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: UpdateCampusEmailDomainDto,
  ) {
    const data = await this.emailDomains.update(
      principal.userId,
      campusId,
      domainId,
      body,
    );
    return { data };
  }

  @Delete(':domainId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a campus email domain (audited with the domain name)',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiParam({ name: 'domainId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Domain removed' })
  @ApiBadRequestResponse({ description: 'Invalid reason' })
  @ApiNotFoundResponse({ description: 'Domain not found in this campus' })
  @ApiForbiddenResponse({
    description: 'campus.access.manage is required for this campus',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer authentication is required' })
  async remove(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: DeleteCampusEmailDomainDto,
  ) {
    await this.emailDomains.remove(principal.userId, campusId, domainId, body);
  }
}
