import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { HealthController } from './health.controller';
@Module({
  imports: [DatabaseModule, InfrastructureModule],
  controllers: [HealthController],
})
export class HealthModule {}
