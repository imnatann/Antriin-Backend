import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CampusesService } from './campuses.service';
import { ListCampusesQueryDto } from './dto/list-campuses-query.dto';
import { ListCampusTenantsQueryDto } from './dto/list-campus-tenants-query.dto';

@ApiTags('Campuses')
@Controller('campuses')
export class CampusesController {
  constructor(private readonly campuses: CampusesService) {}

  @Get()
  @ApiOperation({ summary: 'List active campuses with optional name search' })
  @ApiOkResponse({ description: 'Active campuses ordered by name' })
  @ApiBadRequestResponse({ description: 'Invalid query parameters' })
  list(@Query() query: ListCampusesQueryDto) {
    return this.campuses.list(query);
  }

  @Get(':campusId')
  @ApiOperation({
    summary: 'Get one active campus; inactive campuses return 404',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiOkResponse({ description: 'The active campus' })
  @ApiNotFoundResponse({ description: 'Campus missing or not active' })
  get(@Param('campusId', new ParseUUIDPipe()) campusId: string) {
    return this.campuses.get(campusId);
  }

  @Get(':campusId/tenants')
  @ApiOperation({
    summary:
      'List tenants of an active campus; defaults to open tenants and never exposes archived ones',
  })
  @ApiParam({ name: 'campusId', format: 'uuid' })
  @ApiOkResponse({ description: 'Non-archived tenants matching the filter' })
  @ApiBadRequestResponse({
    description: 'Invalid status filter or query parameters',
  })
  @ApiNotFoundResponse({ description: 'Campus missing or not active' })
  listTenants(
    @Param('campusId', new ParseUUIDPipe()) campusId: string,
    @Query() query: ListCampusTenantsQueryDto,
  ) {
    return this.campuses.listTenants(campusId, query);
  }
}
