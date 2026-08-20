import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfigService } from './app-config.service';

/**
 * Configuracion de pino.
 *
 * Dos cosas importan aqui: cada peticion lleva un `requestId` que tambien viaja
 * en el sobre de respuesta (para cruzar un error del cliente con su log), y la
 * lista de redaccion, que evita que una contrasena o un token acaben en disco.
 */
export function buildLoggerOptions(config: AppConfigService): Params {
  const pretty = config.get('LOG_PRETTY');

  return {
    pinoHttp: {
      level: config.get('LOG_LEVEL'),
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const existing = req.headers['x-request-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customProps: () => ({ context: 'HTTP' }),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-ingest-token"]',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.refreshToken',
          'req.body.token',
          'req.body.card',
          'req.body.cardNumber',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      // El healthcheck del contenedor pega cada pocos segundos: no aporta nada
      // en los logs y los vuelve ilegibles.
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/health' || req.url === '/ready',
      },
      transport: pretty
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l' } }
        : undefined,
    },
  };
}
