import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { StaffInviteAcceptanceController } from './staff-invite-acceptance.controller';
import { StaffInvitesController } from './staff-invites.controller';
import { StaffInvitesService } from './staff-invites.service';

// Staff invitations. The membership only exists after the invitee redeems the
// token, so this module writes access rows indirectly through the same shape
// AccessService uses; the invitation itself grants nothing until then.
@Module({
  imports: [DatabaseModule, AuthModule, AccessModule, AuditModule],
  controllers: [StaffInvitesController, StaffInviteAcceptanceController],
  providers: [StaffInvitesService],
  exports: [StaffInvitesService],
})
export class InvitesModule {}
