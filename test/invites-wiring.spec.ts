import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { InvitesModule } from '../src/modules/invites/invites.module';
import { StaffInvitesService } from '../src/modules/invites/staff-invites.service';
import { UsersModule } from '../src/modules/users/users.module';
import { UsersService } from '../src/modules/users/users.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

/**
 * The invitation controllers use AuthGuard, which needs AuthService. Nothing in
 * the HTTP unit specs would catch a missing AuthModule import: the guard is
 * overridden there. This compiles the real module graph instead, the same way
 * the campus module once failed to boot while every stubbed test passed.
 *
 * Neither PostgreSQL nor Redis is dialled: both clients are lazy and no request
 * is made.
 */
describe('Invites and users module wiring', () => {
  it('compiles InvitesModule with its real guard dependencies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              DATABASE_URL: 'postgresql://local:local@127.0.0.1:1/unused',
              DATABASE_POOL_MAX: 1,
              REDIS_HOST: '127.0.0.1',
              REDIS_PORT: 6381,
              AUTH_SECRET: 'di-test-secret-value-0123456789abcdef',
              AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
            }),
          ],
        }),
        InvitesModule,
      ],
    }).compile();

    try {
      const service = moduleRef.get(StaffInvitesService);
      assert.ok(service instanceof StaffInvitesService);
      const internals = service as unknown as {
        access: AccessService;
        audit: AuditService;
      };
      assert.ok(internals.access instanceof AccessService);
      assert.ok(internals.audit instanceof AuditService);
      // The guard the controllers rely on resolves through AuthModule.
      assert.ok(moduleRef.get(AuthService) instanceof AuthService);
    } finally {
      await moduleRef.close();
    }
  });

  it('compiles UsersModule with the wallet and audit dependencies /me needs', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              DATABASE_URL: 'postgresql://local:local@127.0.0.1:1/unused',
              DATABASE_POOL_MAX: 1,
              REDIS_HOST: '127.0.0.1',
              REDIS_PORT: 6381,
              AUTH_SECRET: 'di-test-secret-value-0123456789abcdef',
              AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
            }),
          ],
        }),
        UsersModule,
      ],
    }).compile();

    try {
      const service = moduleRef.get(UsersService);
      assert.ok(service instanceof UsersService);
      const internals = service as unknown as {
        wallet: WalletService;
        audit: AuditService;
      };
      assert.ok(internals.wallet instanceof WalletService);
      assert.ok(internals.audit instanceof AuditService);
      assert.ok(moduleRef.get(AuthService) instanceof AuthService);
    } finally {
      await moduleRef.close();
    }
  });
});
