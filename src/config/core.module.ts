import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { environmentSchema } from './environment';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (input: Record<string, unknown>) => {
        const { error, value } = environmentSchema.validate(input, {
          abortEarly: false,
          allowUnknown: true,
        });
        if (error) throw new Error(`Invalid environment: ${error.message}`);
        return value as Record<string, unknown>;
      },
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.getOrThrow<string>('LOG_LEVEL'),
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
          ],
        },
      }),
    }),
  ],
  exports: [ConfigModule, LoggerModule],
})
export class CoreModule {}
