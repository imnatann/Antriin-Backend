import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis.service';
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}
  @Get('live')
  @ApiOperation({ summary: 'Process liveness' })
  live() {
    return { status: 'ok', service: 'antriin-api' };
  }
  @Get('ready')
  @ApiOperation({ summary: 'Database and Redis readiness' })
  @ApiResponse({
    status: 503,
    description: 'A required dependency is unavailable',
  })
  async ready() {
    const results = await Promise.allSettled([
      this.database.ping(),
      this.redis.ping(),
    ]);
    const dependencies = {
      database: results[0].status === 'fulfilled',
      redis: results[1].status === 'fulfilled',
    };
    if (!dependencies.database || !dependencies.redis)
      throw new ServiceUnavailableException({
        status: 'unavailable',
        dependencies,
      });
    return { status: 'ok', dependencies };
  }
}
