import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { CampusesController } from './campuses.controller';
import { CampusesService } from './campuses.service';
@Module({
  imports: [DatabaseModule],
  controllers: [CampusesController],
  providers: [CampusesService],
  exports: [CampusesService],
})
export class CampusesModule {}
