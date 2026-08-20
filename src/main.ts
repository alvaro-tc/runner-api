import 'reflect-metadata';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { Logger as NestLogger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import express from 'express';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { setupSwagger } from './swagger';
import { UPLOADS_PUBLIC_PREFIX } from './modules/storage/storage.service';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Guarda el cuerpo sin parsear ademas del parseado. Lo necesita la
    // verificacion de la firma del webhook: se firma el cuerpo byte a byte, y
    // `JSON.stringify(JSON.parse(x))` no devuelve `x` —cambia el orden de las
    // claves y los escapes—, asi que reserializar rompe la firma.
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get(AppConfigService);

  app.setGlobalPrefix('api/v1', {
    // Los healthchecks los consume la infraestructura (systemd, Caddy), no el
    // cliente: viven fuera del prefijo versionado y no se rompen nunca. El panel
    // es una pagina, no un endpoint: tampoco tiene sentido que una `/api/v2` le
    // cambie la URL. Su API si vive dentro, en `/api/v1/admin/*`.
    exclude: ['health', 'ready', { path: 'admin', method: RequestMethod.GET }],
  });

  // Detras de Caddy el peer TCP es siempre 127.0.0.1: sin esto `req.ip` es
  // loopback para todo el mundo y el rate limit por IP se convierte en un unico
  // cubo global —120 peticiones por minuto entre todos los usuarios—. Se confia
  // SOLO en loopback: un cliente de internet no puede falsear su IP con una
  // cabecera porque su conexion no llega desde loopback.
  app.set('trust proxy', 'loopback');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const origins = config.corsOrigins;
  app.enableCors({
    origin: origins.includes('*') ? true : origins,
    credentials: true,
  });

  // Los archivos subidos (avatares hoy, tarjetas de resultado despues) se
  // sirven fuera del prefijo versionado: son binarios publicos, no endpoints, y
  // no tiene sentido que una `/api/v2` cambie la URL de una imagen ya guardada.
  // En produccion con Caddy delante conviene que los sirva el proxy; esto
  // asegura que en desarrollo y en un compose minimo funcionen igual.
  const uploadsDir = resolve(config.get('UPLOADS_DIR'));
  await mkdir(uploadsDir, { recursive: true });
  app.useStaticAssets(uploadsDir, {
    prefix: UPLOADS_PUBLIC_PREFIX,
    // Los nombres llevan un UUID: cambiar el avatar cambia la URL, asi que el
    // contenido de una URL dada no cambia nunca y se puede cachear a lo bestia.
    maxAge: '30d',
    immutable: true,
    index: false,
    dotfiles: 'deny',
  });

  const bodyLimit = config.get('BODY_LIMIT');
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // El adapter se conecta ANTES de escuchar: si se hiciera despues, los
  // sockets que entren en ese hueco quedarian atados a esta instancia y nadie
  // se enteraria hasta que un espectador dijera que no ve a nadie.
  const realtime = new RedisIoAdapter(app, config);
  await realtime.connect();
  app.useWebSocketAdapter(realtime);

  setupSwagger(app, config);

  app.enableShutdownHooks();

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');

  NestLogger.log(
    `API escuchando en http://localhost:${port}/api/v1 (docs en /api/docs, live en /live, entorno ${config.get('NODE_ENV')})`,
    'Bootstrap',
  );
}

void bootstrap();
