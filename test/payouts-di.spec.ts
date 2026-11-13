import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { CasesModule } from '../src/modules/cases/cases.module';
import { CasesService } from '../src/modules/cases/cases.service';
import { BankAccountsService } from '../src/modules/payouts/bank-accounts.service';
import { CampusPayoutsController } from '../src/modules/payouts/campus-payouts.controller';
import { PayoutsModule } from '../src/modules/payouts/payouts.module';
import { PayoutsService } from '../src/modules/payouts/payouts.service';
import { PickupModule } from '../src/modules/pickup/pickup.module';
import { PickupService } from '../src/modules/pickup/pickup.service';
import { SettlementsModule } from '../src/modules/settlements/settlements.module';
import { SettlementsService } from '../src/modules/settlements/settlements.service';

/**
 * Review F6: the settlements <-> cases cycle is resolved with forwardRef, and
 * pickup/payouts consume SettlementsService. Until this spec existed nothing
 * booted the four modules together, so a missing import or a broken forwardRef
 * would only be discovered by starting the API or the worker by hand.
 *
 * The test compiles the real Nest graph. It never queries PostgreSQL or Redis:
 * both clients are lazy and no request is made.
 */
describe('Settlements/payouts/pickup/cases dependency graph (F6)', () => {
  it('boots the four modules together and fills every cross-slice injection', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              // Never dialled: the pg Pool and the ioredis client are lazy.
              DATABASE_URL: 'postgresql://local:local@127.0.0.1:1/unused',
              DATABASE_POOL_MAX: 1,
              REDIS_HOST: '127.0.0.1',
              REDIS_PORT: 6381,
              AUTH_SECRET: 'di-test-secret-value-0123456789abcdef',
              AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
              PAYOUTS_PROVIDER_MODE: 'disabled',
              REFUNDS_PROVIDER_MODE: 'disabled',
              PAYMENTS_PROVIDER_MODE: 'disabled',
            }),
          ],
        }),
        PickupModule,
        CasesModule,
        SettlementsModule,
        PayoutsModule,
      ],
    }).compile();

    try {
      const pickup = moduleRef.get(PickupService);
      const cases = moduleRef.get(CasesService);
      const settlements = moduleRef.get(SettlementsService);
      const payouts = moduleRef.get(PayoutsService);
      const bankAccounts = moduleRef.get(BankAccountsService);

      // forwardRef(settlements <-> cases) resolved in BOTH directions.
      assert.ok(
        (settlements as unknown as { cases: CasesService }).cases instanceof
          CasesService,
        'SettlementsService must receive CasesService',
      );
      assert.ok(
        (cases as unknown as { settlements: SettlementsService })
          .settlements instanceof SettlementsService,
        'CasesService must receive SettlementsService (forwardRef)',
      );
      // The handover release hook (D18 Q2a) is a REQUIRED dependency, so a
      // missing module import fails this boot instead of silently disabling it.
      assert.ok(
        (pickup as unknown as { settlements: SettlementsService })
          .settlements instanceof SettlementsService,
        'PickupService must receive SettlementsService',
      );
      assert.ok(
        (payouts as unknown as { settlements: SettlementsService })
          .settlements instanceof SettlementsService,
        'PayoutsService must receive SettlementsService',
      );
      assert.ok(bankAccounts instanceof BankAccountsService);
      // The provider adapter token is bound to the sandbox implementation.
      assert.equal(
        (payouts as unknown as { adapter: { provider: string } }).adapter
          .provider,
        'sandbox',
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('registers the read-only campus payout monitoring route (F9)', () => {
    const basePath = Reflect.getMetadata(
      PATH_METADATA,
      CampusPayoutsController,
    ) as string;
    assert.equal(basePath, 'campuses/:campusId');
    const handler = CampusPayoutsController.prototype.list;
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, handler),
      'payouts',
      'GET campuses/:campusId/payouts must exist',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, handler),
      RequestMethod.GET,
    );
    // The monitoring surface is read-only: no mutating handler on the class.
    const mutating = Object.getOwnPropertyNames(
      CampusPayoutsController.prototype,
    ).filter((name) => {
      const method = (
        CampusPayoutsController.prototype as unknown as Record<string, unknown>
      )[name];
      if (typeof method !== 'function') return false;
      const verb = Reflect.getMetadata(METHOD_METADATA, method);
      return verb !== undefined && verb !== RequestMethod.GET;
    });
    assert.deepEqual(
      mutating,
      [],
      'campus monitoring must never expose a mutating route',
    );
  });
});
