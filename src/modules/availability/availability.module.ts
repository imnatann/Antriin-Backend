import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
@Module({
  imports: [DatabaseModule, AccessModule, AuthModule],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
