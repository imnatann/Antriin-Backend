import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { AccessService } from '../src/modules/access/access.service';
import { AuditService } from '../src/modules/audit/audit.service';

describe(
  'Scoped immutable audit PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL },
  () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const database = { pool } as DatabaseService;
    const service = new AuditService(database, new AccessService(database));
    const campus = randomUUID();
    const otherCampus = randomUUID();
    const manager = randomUUID();
    const buyer = randomUUID();
    before(async () => {
      await pool.query(
        "INSERT INTO campuses(id,name) VALUES($1,'Audit campus'),($2,'Other audit campus')",
        [campus, otherCampus],
      );
      await pool.query(
        "INSERT INTO users(id,display_name) VALUES($1,'Audit manager'),($2,'Audit buyer')",
        [manager, buyer],
      );
      await pool.query(
        "INSERT INTO campus_memberships(campus_id,user_id,permissions) VALUES($1,$2,ARRAY['campus.audit.read'])",
        [campus, manager],
      );
    });
    after(async () => {
      await pool.end();
    });
    it('persists actor, target and reason atomically and denies cross-campus reads', async () => {
      const tx = await pool.connect();
      const target = randomUUID();
      try {
        await tx.query('BEGIN');
        await service.append(tx, {
          actor: { userId: manager },
          scopeType: 'campus',
          scopeId: campus,
          action: 'case.decided',
          targetType: 'case',
          targetId: target,
          reason: 'Operational review',
        });
        await tx.query('COMMIT');
        const page = await service.listCampus(manager, campus);
        const row = page.data.find((r) => r.targetId === target);
        assert.ok(row);
        assert.equal(row.actorUserId, manager);
        assert.equal(row.reason, 'Operational review');
        await assert.rejects(
          service.listCampus(manager, otherCampus),
          /Campus access denied/,
        );
        await assert.rejects(
          service.listCampus(buyer, campus),
          /Campus access denied/,
        );
        await assert.rejects(
          pool.query('UPDATE audit_events SET reason=$1 WHERE id=$2', [
            'Changed',
            row.id,
          ]),
          /immutable/,
        );
        await assert.rejects(
          pool.query('DELETE FROM audit_events WHERE id=$1', [row.id]),
          /immutable/,
        );
        await assert.rejects(pool.query('TRUNCATE audit_events'), /immutable/);
        await assert.rejects(
          pool.query('TRUNCATE access_audit_events'),
          /append-only/,
        );
      } finally {
        tx.release();
      }
    });
    it('does not keep audit for a rolled-back domain operation', async () => {
      const tx = await pool.connect();
      const target = randomUUID();
      try {
        await tx.query('BEGIN');
        await service.append(tx, {
          actor: { service: 'test' },
          scopeType: 'campus',
          scopeId: campus,
          action: 'test.rollback',
          targetType: 'case',
          targetId: target,
          reason: 'Rollback test',
        });
        await tx.query('ROLLBACK');
        assert.equal(
          (
            await pool.query('SELECT id FROM audit_events WHERE target_id=$1', [
              target,
            ])
          ).rowCount,
          0,
        );
      } finally {
        tx.release();
      }
    });
  },
);
