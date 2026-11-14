import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
// The campus access and email-domain controllers use AuthGuard, which resolves
// AuthService from this module's injector.
import { AuthModule } from '../auth/auth.module';
import { CampusAccessController } from './campus-access.controller';
import { CampusAccessService } from './campus-access.service';
import { CampusEmailDomainsController } from './campus-email-domains.controller';
import { CampusEmailDomainsService } from './campus-email-domains.service';
import { CampusProvisioningService } from './campus-provisioning.service';
import { CampusesController } from './campuses.controller';
import { CampusesService } from './campuses.service';

/**
 * Campuses slice: public discovery, controlled campus provisioning, the
 * read-only campus membership listing and the campus email domain registry.
 *
 * The access and email-domain routes are authorization-scoped to
 * campus.access.manage; nothing here grants campus membership
 * (docs/ACCESS.md forbids a public endpoint that hands out campus access).
 */
@Module({
  imports: [DatabaseModule, AccessModule, AuditModule, AuthModule],
  controllers: [
    CampusesController,
    CampusAccessController,
    CampusEmailDomainsController,
  ],
  providers: [
    CampusesService,
    CampusProvisioningService,
    CampusAccessService,
    CampusEmailDomainsService,
  ],
  exports: [CampusesService, CampusProvisioningService],
})
export class CampusesModule {}
