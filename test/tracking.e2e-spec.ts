import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}
interface ErrorBody {
  error: { code: string; message: string; details: unknown[] };
}

interface Arranque {
  session: { id: string; startedAt: string };
  workout: { id: string };
  ingestToken: string;
}

interface Resultado {
  accepted: number;
  duplicated: number;
  rejected: number;
  reasons: Record<string, number>;
}

const METROS_POR_GRADO_LAT = 111_194.93;

/**
 * Ingesta de posiciones contra Postgres real.
 *
 * Lo que importa: que el `ingestToken` sea la única llave y no sirva para otra
 * sesión, que reenviar un lote no duplique nada, y que un punto imposible se
 * descarte sin tumbar el lote entero.
 */
describe('Tracking (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `ttest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let userId = '';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function registrarUsuario(sufijo: string): Promise<{ token: string; id: string }> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `${marca}-${sufijo}@test.com`,
        password: 'Test1234!',
        name: `Corredor ${sufijo}`,
        deviceId: `${marca}-${sufijo}`,
      })
      .expect(201);

    const { data } = res.body as Envelope<{ accessToken: string; user: { id: string } }>;
    return { token: data.accessToken, id: data.user.id };
  }

  const arrancar = (body: object = {}) =>
    http()
      .post('/api/v1/workouts/sessions')
      .set(auth(token))
      .send({ clientUuid: randomUUID(), ...body });

  /**
   * Lote recto hacia el norte desde el ecuador.
   *
   * Por defecto termina "ahora"; con `desde` arranca en ese instante y avanza,
   * que es lo que hace falta cuando el recorrido dura mas que la tolerancia de
   * `before_session`.
   */
  function lote(opciones: {
    puntos: number;
    metros: number;
    segundos: number;
    prefijo: string;
    desde?: string;
  }) {
    const inicio = opciones.desde
      ? new Date(opciones.desde).getTime()
      : Date.now() - (opciones.puntos - 1) * opciones.segundos * 1000;

    return {
      points: Array.from({ length: opciones.puntos }, (_, i) => ({
        clientPointId: `${opciones.prefijo}-${i}`,
        recordedAt: new Date(inicio + i * opciones.segundos * 1000).toISOString(),
        lat: (i * opciones.metros) / METROS_POR_GRADO_LAT,
        lng: 0,
        altitude: 3600 + i,
        speed: opciones.metros / opciones.segundos,
        accuracy: 5,
        battery: 80,
      })),
    };
  }

  const enviar = (sessionId: string, ingestToken: string, body: object) =>
    http()
      .post(`/api/v1/tracking/sessions/${sessionId}/positions`)
      .set(auth(ingestToken))
      .send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    const principal = await registrarUsuario('uno');
    token = principal.token;
    userId = principal.id;
  });

  afterAll(async () => {
    await limpiar();
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  async function limpiar(): Promise<void> {
    await prisma.position.deleteMany({ where: { userId } });
    await prisma.trackingSession.deleteMany({ where: { userId } });
    await prisma.workout.deleteMany({ where: { userId } });
  }

  afterEach(limpiar);

  // ───────────────────────────────────────────────────────────────────────────

  it('guarda un lote y deja la sesion con lastPositionAt', async () => {
    const { data } = (await arrancar().expect(201)).body as Envelope<Arranque>;

    const res = await enviar(
      data.session.id,
      data.ingestToken,
      lote({ puntos: 20, metros: 5, segundos: 1, prefijo: 'a' }),
    ).expect(202);

    expect((res.body as Envelope<Resultado>).data).toMatchObject({
      accepted: 20,
      duplicated: 0,
      rejected: 0,
    });

    const sesion = await prisma.trackingSession.findUniqueOrThrow({
      where: { id: data.session.id },
    });
    expect(sesion.lastPositionAt).not.toBeNull();

    const guardadas = await prisma.position.findMany({
      where: { trackingSessionId: data.session.id },
      take: 1,
    });
    expect(guardadas[0]!.source).toBe('app_batch');
    // Las posiciones se cuelgan del workout al cerrar, no al llegar.
    expect(guardadas[0]!.workoutId).toBeNull();
  });

  it('reenviar el mismo lote no duplica: los repetidos van a `duplicated`', async () => {
    const { data } = (await arrancar().expect(201)).body as Envelope<Arranque>;
    const cuerpo = lote({ puntos: 10, metros: 5, segundos: 1, prefijo: 'b' });

    await enviar(data.session.id, data.ingestToken, cuerpo).expect(202);
    const res = await enviar(data.session.id, data.ingestToken, cuerpo).expect(202);

    expect((res.body as Envelope<Resultado>).data).toMatchObject({ accepted: 0, duplicated: 10 });
    expect(await prisma.position.count({ where: { trackingSessionId: data.session.id } })).toBe(10);
  });

  it('descarta los puntos imposibles y guarda el resto', async () => {
    const { data } = (await arrancar().expect(201)).body as Envelope<Arranque>;
    const cuerpo = lote({ puntos: 5, metros: 5, segundos: 1, prefijo: 'c' });

    cuerpo.points.push({
      ...cuerpo.points[0]!,
      clientPointId: 'c-futuro',
      recordedAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    cuerpo.points.push({
      ...cuerpo.points[0]!,
      clientPointId: 'c-viejo',
      recordedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    });

    const res = await enviar(data.session.id, data.ingestToken, cuerpo).expect(202);
    const resultado = (res.body as Envelope<Resultado>).data;

    expect(resultado.accepted).toBe(5);
    expect(resultado.rejected).toBe(2);
    expect(resultado.reasons).toMatchObject({ future: 1, before_session: 1 });
  });

  it('una coordenada fuera de rango la para la validacion del DTO', async () => {
    const { data } = (await arrancar().expect(201)).body as Envelope<Arranque>;
    const cuerpo = lote({ puntos: 1, metros: 5, segundos: 1, prefijo: 'd' });
    cuerpo.points[0]!.lat = 200;

    const res = await enviar(data.session.id, data.ingestToken, cuerpo).expect(400);
    expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('el JWT del usuario NO sirve para ingerir', async () => {
    const { data } = (await arrancar().expect(201)).body as Envelope<Arranque>;

    const res = await enviar(
      data.session.id,
      token,
      lote({ puntos: 1, metros: 5, segundos: 1, prefijo: 'e' }),
    ).expect(401);

    expect((res.body as ErrorBody).error.code).toBe('INVALID_INGEST_TOKEN');
  });

  it('el token de una sesion no vale para otra', async () => {
    const primera = ((await arrancar().expect(201)).body as Envelope<Arranque>).data;
    await http()
      .post(`/api/v1/workouts/sessions/${primera.session.id}/finish`)
      .set(auth(token))
      .send({})
      .expect(200);

    const segunda = ((await arrancar().expect(201)).body as Envelope<Arranque>).data;

    const res = await enviar(
      segunda.session.id,
      primera.ingestToken,
      lote({ puntos: 1, metros: 5, segundos: 1, prefijo: 'f' }),
    ).expect(401);

    expect((res.body as ErrorBody).error.code).toBe('INVALID_INGEST_TOKEN');
  });

  it('en pausa se sigue aceptando; despues de finalizar, no', async () => {
    const { data } = (await arrancar().expect(201)).body as Envelope<Arranque>;

    await http()
      .patch(`/api/v1/workouts/sessions/${data.session.id}/pause`)
      .set(auth(token))
      .expect(200);

    await enviar(
      data.session.id,
      data.ingestToken,
      lote({ puntos: 3, metros: 5, segundos: 1, prefijo: 'g' }),
    ).expect(202);

    await http()
      .patch(`/api/v1/workouts/sessions/${data.session.id}/resume`)
      .set(auth(token))
      .expect(200);
    await http()
      .post(`/api/v1/workouts/sessions/${data.session.id}/finish`)
      .set(auth(token))
      .send({})
      .expect(200);

    const res = await enviar(
      data.session.id,
      data.ingestToken,
      lote({ puntos: 3, metros: 5, segundos: 1, prefijo: 'h' }),
    ).expect(409);

    expect((res.body as ErrorBody).error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('los puntos ingeridos son los que consolida el cierre', async () => {
    // La sesion arranca en el pasado: un recorrido de 200 s enviado de golpe
    // tendria puntos "en el futuro" si la sesion empezara ahora mismo.
    const startedAt = new Date(Date.now() - 200_000).toISOString();
    const { data } = (await arrancar({ startedAt }).expect(201)).body as Envelope<Arranque>;

    await enviar(
      data.session.id,
      data.ingestToken,
      lote({ puntos: 41, metros: 25, segundos: 5, prefijo: 'i', desde: data.session.startedAt }),
    ).expect(202);

    const res = await http()
      .post(`/api/v1/workouts/sessions/${data.session.id}/finish`)
      .set(auth(token))
      .send({})
      .expect(200);

    const { workout } = (res.body as Envelope<{ workout: { distanceMeters: number } }>).data;
    expect(workout.distanceMeters).toBeGreaterThan(970);
    expect(workout.distanceMeters).toBeLessThan(1030);

    // Al cerrar, las posiciones ya cuelgan del workout.
    expect(await prisma.position.count({ where: { trackingSessionId: data.session.id } })).toBe(41);
  });

  // ─── OsmAnd ────────────────────────────────────────────────────────────────

  const osmand = (params: Record<string, string | number>) =>
    http()
      .get('/api/v1/tracking/osmand')
      .query(params as Record<string, string>);

  it('acepta un punto por el protocolo OsmAnd y lo deduplica por timestamp', async () => {
    const deviceId = `${marca}-osmand`;
    const { data } = (await arrancar({ deviceId }).expect(201)).body as Envelope<Arranque>;

    const punto = {
      id: deviceId,
      lat: -16.4957,
      lon: -68.1335,
      timestamp: Math.floor(Date.now() / 1000),
      speed: 3.4,
      batt: 74,
      // Traccar Client manda extras que no pedimos: no pueden costar un 400.
      hdop: 0.8,
    };

    const res = await osmand(punto).expect(200);
    expect((res.body as Envelope<Resultado>).data).toMatchObject({ accepted: 1, duplicated: 0 });

    const repetido = await osmand(punto).expect(200);
    expect((repetido.body as Envelope<Resultado>).data).toMatchObject({
      accepted: 0,
      duplicated: 1,
    });

    const guardadas = await prisma.position.findMany({
      where: { trackingSessionId: data.session.id },
    });
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]!.source).toBe('osmand');
    expect(guardadas[0]!.batteryLevel).toBe(74);
  });

  it('OsmAnd sin sesion abierta no crea nada', async () => {
    const deviceId = `${marca}-osmand-sin-sesion`;
    const { data } = (await arrancar({ deviceId }).expect(201)).body as Envelope<Arranque>;
    await http()
      .post(`/api/v1/workouts/sessions/${data.session.id}/finish`)
      .set(auth(token))
      .send({})
      .expect(200);

    const res = await osmand({
      id: deviceId,
      lat: -16.4957,
      lon: -68.1335,
      timestamp: Math.floor(Date.now() / 1000),
    }).expect(409);

    expect((res.body as ErrorBody).error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('un dispositivo desconocido no abre sesion sola', async () => {
    const res = await osmand({
      id: `${marca}-fantasma`,
      lat: -16.4957,
      lon: -68.1335,
    }).expect(409);

    expect((res.body as ErrorBody).error.code).toBe('SESSION_NOT_ACTIVE');
    expect(await prisma.trackingSession.count({ where: { userId } })).toBe(0);
  });

  // ─── Simulacion ────────────────────────────────────────────────────────────

  it('la simulacion mete puntos reales y el cierre los consolida', async () => {
    const { data } = (await arrancar().expect(201)).body as Envelope<Arranque>;

    // 41 puntos rectos hacia el norte, 25 m cada uno: un kilometro exacto.
    const coordinates = Array.from({ length: 41 }, (_, i) => [0, (i * 25) / METROS_POR_GRADO_LAT]);

    const res = await http()
      .post('/api/v1/tracking/simulate')
      .set(auth(data.ingestToken))
      .send({ coordinates, intervalSeconds: 5 })
      .expect(202);

    expect((res.body as Envelope<Resultado>).data).toMatchObject({ accepted: 41, rejected: 0 });

    const cierre = await http()
      .post(`/api/v1/workouts/sessions/${data.session.id}/finish`)
      .set(auth(token))
      .send({})
      .expect(200);

    const { workout } = (cierre.body as Envelope<{ workout: { distanceMeters: number } }>).data;
    expect(workout.distanceMeters).toBeGreaterThan(970);
    expect(workout.distanceMeters).toBeLessThan(1030);
  });

  it('la simulacion tambien exige el ingestToken', async () => {
    await arrancar().expect(201);

    await http()
      .post('/api/v1/tracking/simulate')
      .set(auth(token))
      .send({ coordinates: [[0, 0], [0, 0.0001]] })
      .expect(401);
  });
});
