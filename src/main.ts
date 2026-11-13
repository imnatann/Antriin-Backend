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
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiGuideService } from './modules/api-guide/api-guide.service';
async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 1048576 }),
    // rawBody keeps the exact webhook bytes for HMAC signature verification.
    { bufferLogs: true, rawBody: true },
  );
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  await app.register(helmet);
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
