import { Module } from '@nestjs/common';
import {
  ApiGuideController,
  ApiGuideMarkdownController,
} from './api-guide.controller';
import { ApiGuideService } from './api-guide.service';

// No database, no auth: the guide is generated from the OpenAPI document that
// bootstrap hands to ApiGuideService.setDocument().
@Module({
  controllers: [ApiGuideController, ApiGuideMarkdownController],
  providers: [ApiGuideService],
  exports: [ApiGuideService],
})
export class ApiGuideModule {}
