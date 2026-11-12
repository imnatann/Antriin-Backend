import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CampusesService } from './campuses.service';

@ApiTags('Campuses')
@Controller('campuses')
export class CampusesController {
  constructor(private readonly campuses: CampusesService) {}

  @Get()
  @ApiOperation({ summary: 'List active campuses' })
  list(@Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    return this.campuses.list(limit);
  }
}
