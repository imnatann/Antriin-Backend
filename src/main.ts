import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { helmetOptions } from './common/security-headers';
import { ApiGuideService } from './modules/api-guide/api-guide.service';
async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 1048576,
      // The pilot host puts nginx in front of the API, so without this every
      // request would look like it came from 127.0.0.1 and the public rate
      // limiter would lump all anonymous traffic into a single bucket. Trusting
      // X-Forwarded-For is safe here because the API listens on loopback only
      // (API_BIND_ADDRESS=127.0.0.1 on the host), so nginx is the sole source.
      trustProxy: true,
    }),
    // rawBody keeps the exact webhook bytes for HMAC signature verification.
    { bufferLogs: true, rawBody: true },
  );
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  await app.register(helmet, helmetOptions);
  // Image uploads (POST /media) are the only multipart routes. The size limit is
  // applied here so an oversized body is rejected while streaming rather than
  // after it has been buffered; MediaService re-checks the same bound.
  await app.register(multipart, {
    limits: {
      fileSize: config.getOrThrow<number>('MEDIA_MAX_BYTES'),
      files: 1,
      fields: 0,
    },
  });
  app.enableCors({
    origin: config
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  // The document is built once: /docs renders it, and the API guide at
  // /api/v1/guide derives its endpoint and object reference from it. Both stay
  // behind SWAGGER_ENABLED so the surface is not published by default.
  if (config.getOrThrow<boolean>('SWAGGER_ENABLED')) {
    const options = new DocumentBuilder()
      .setTitle('Antriin API')
      .setDescription(
        'Backend foundation; business endpoints are implemented incrementally.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, options);
    app.get(ApiGuideService).setDocument(document);
    SwaggerModule.setup('docs', app, document);
  }
  await app.listen(
    config.getOrThrow<number>('PORT'),
    config.getOrThrow<string>('HOST'),
  );
}
void bootstrap().catch(() => {
  console.error('API startup failed; verify configuration and dependencies.');
  process.exitCode = 1;
});
