import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { ErrorResponseDto, ResponseMeta } from '../src/common/dto/response-envelope';

/** supertest tipa `body` como `any`; esto le devuelve forma al sobre. */
interface Envelope<T> {
  data: T;
  meta: ResponseMeta;
}

/**
 * Verifica el andamiaje, no la logica de negocio: que el sobre de respuesta se
 * aplique, que los errores salgan con `code`, y que los healthchecks queden
 * fuera del prefijo versionado.
 */
describe('Andamiaje (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health responde 200 envuelto en { data, meta }', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = res.body as Envelope<{ status: string; uptimeSeconds: number }>;

    expect(body.data.status).toBe('ok');
    expect(typeof body.data.uptimeSeconds).toBe('number');
    expect(typeof body.meta.requestId).toBe('string');
    expect(new Date(body.meta.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('los healthchecks viven fuera de /api/v1', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });

  it('una ruta inexistente devuelve el sobre de error con code', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/no-existe').expect(404);
    const body = res.body as ErrorResponseDto & { data?: unknown };

    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual([]);
    expect(body.meta.requestId).toBeDefined();
    expect(body.data).toBeUndefined();
  });

  it('GET /ready dice QUE dependencia esta caida, no solo que algo fallo', async () => {
    const res = await request(app.getHttpServer()).get('/ready');
    const body = res.body as Envelope<{ status: string; checks: Record<string, unknown> }> &
      ErrorResponseDto;

    if (res.status === 200) {
      // Postgres y Redis estan levantados en esta maquina.
      expect(body.data.status).toBe('ok');
      expect(Object.keys(body.data.checks)).toEqual(['database', 'redis']);
    } else {
      expect(res.status).toBe(503);
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      // Lo importante: el detalle sobrevive al filtro de excepciones.
      expect(body.error.details).toHaveLength(1);
      expect(body.error.details[0]).toHaveProperty('database');
      expect(body.error.details[0]).toHaveProperty('redis');
    }
  });

  it('devuelve el requestId tambien en la cabecera x-request-id', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = res.body as Envelope<unknown>;

    expect(res.headers['x-request-id']).toBe(body.meta.requestId);
  });
});
