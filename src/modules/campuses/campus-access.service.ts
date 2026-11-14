import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AccessService } from '../access/access.service';
import { uuidPattern } from '../notifications/outbox.service';

/** D7: response timestamps are the DB microsecond UTC strings themselves. */
const SQL_TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type CampusAccessMember = {
  membershipId: string;
  userId: string;
  displayName: string;
  permissions: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Read-only view of campus membership (docs/ACCESS.md).
 *
 * Campus membership stays a controlled provisioning operation: there is no
 * public endpoint that grants, changes or revokes campus access, so this
 * service only projects the ACTIVE members of one campus. Every call is
 * authorized server-side with campus.access.manage inside the transaction.
 */
@Injectable()
export class CampusAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  /** Active members of one campus, ordered by display name then membership id. */
  async listMembers(
    actorUserId: string,
    campusId: string,
  ): Promise<CampusAccessMember[]> {
    assertUuid(actorUserId, 'user');
    assertUuid(campusId, 'campus');
    return this.withTransaction(async (tx) => {
      await this.access.requireCampus(
        actorUserId,
        campusId,
        'campus.access.manage',
        tx,
      );
      const result = await tx.query<{
        membership_id: string;
        user_id: string;
        display_name: string;
        permissions: string[];
        status: string;
        created_at: string;
        updated_at: string;
      }>(
        `select cm.id::text as membership_id,
                cm.user_id::text as user_id,
                u.display_name,
                cm.permissions,
                cm.status,
                ${SQL_TS('cm.created_at')} as created_at,
                ${SQL_TS('cm.updated_at')} as updated_at
           from campus_memberships cm
           join users u on u.id = cm.user_id
          where cm.campus_id = $1
            and cm.status = 'active'
          order by u.display_name, cm.id`,
        [campusId],
      );
      return result.rows.map((row) => ({
        membershipId: row.membership_id,
        userId: row.user_id,
        displayName: row.display_name,
        permissions: row.permissions,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  private async withTransaction<T>(
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    const connection = await this.database.pool.connect();
    try {
      await connection.query('begin');
      const result = await operation(connection);
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value ?? ''))
    throw new BadRequestException('Invalid ' + name + ' id');
}
