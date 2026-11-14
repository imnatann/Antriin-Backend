import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// The /me slice reads memberships, the campus email verification and the wallet
// balance of the session user only. AccessModule is imported for the module
// contract even though no /me route names a tenant or campus scope: every list
// is derived from the caller's own active memberships.
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AccessModule,
    WalletModule,
    AuditModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
