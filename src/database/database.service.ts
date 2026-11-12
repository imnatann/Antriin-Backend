import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;
  readonly db;
  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: config.getOrThrow<number>('DATABASE_POOL_MAX'),
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
    });
    this.pool.on('error', () =>
      console.error('PostgreSQL idle connection failed'),
    );
    this.db = drizzle(this.pool, { schema });
  }
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
