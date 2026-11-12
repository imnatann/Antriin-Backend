import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;
  constructor(config: ConfigService) {
    this.client = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.client.on('error', () => undefined);
  }
  async ping(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end')
      await this.client.connect();
    await this.client.ping();
  }
  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}
