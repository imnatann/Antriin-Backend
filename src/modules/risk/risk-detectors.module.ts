import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { RiskDetectorService } from './risk-detectors.service';
import { RiskService } from './risk.service';

/**
 * Worker-side wiring for the risk detectors.
 *
 * It deliberately does not import RiskModule: that module owns the campus HTTP
 * controller (and its AuthGuard), which a background process never serves. The
 * detectors only need RiskService.ingestSignal, and RiskService in turn needs
 * its database/access/audit collaborators.
 */
@Module({
  imports: [DatabaseModule, AccessModule, AuditModule],
  providers: [RiskService, RiskDetectorService],
  exports: [RiskDetectorService],
})
export class RiskDetectorsModule {}
