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

interface Sesion {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

interface Workout {
  id: string;
  clientUuid: string;
  type: string;
  planSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  avgPaceSecPerKm: number | null;
  elevationGainMeters: number;
  calories: number | null;
  bestKmIndex: number | null;
  feeling: number | null;
  notes: string | null;
  clientReported: unknown;
  splits: { index: number; distanceMeters: number; paceSecPerKm: number }[];
}

interface Arranque {
  session: Sesion;
  workout: Workout;
  ingestToken: string;
}

interface Cierre {
  session: Sesion;
  workout: Workout;
  discardedPoints: number;
  shoe: { id: string; distanceMeters: number; wearAlert: boolean } | null;
}

/** Mismo radio que usa `haversine`, para que las distancias del test sean exactas. */
const METROS_POR_GRADO_LAT = 111_194.93;

/**
 * Sesiones de entrenamiento contra Postgres real.
 *
 * Lo que importa aqui es que las metricas salgan del **servidor** y no de lo
 * que diga el cliente, que una sesion no se pueda tocar dos veces y que nadie
 * cierre la sesion de otro.
 */
describe('Workout sessions (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `wtest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let userId = '';
  let tokenOtro = '';

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

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

  const arrancar = (body: object = {}, t = token) =>
    http()
      .post('/api/v1/workouts/sessions')
      .set(auth(t))
      .send({ clientUuid: randomUUID(), ...body });

  /**
   * Siembra un recorrido recto: `puntos` puntos cada `segundos`, avanzando
   * `metros` hacia el norte desde el ecuador.
   */
  async function sembrarRecorrido(
    sessionId: string,
    opciones: {
      puntos: number;
      metros: number;
      segundos: number;
      desde: Date;
      altitudPorPunto?: number;
    },
  ) {
    const { puntos, metros, segundos, desde } = opciones;

    await prisma.position.createMany({
      data: Array.from({ length: puntos }, (_, i) => ({
        trackingSessionId: sessionId,
        userId,
        recordedAt: new Date(desde.getTime() + i * segundos * 1000),
        lat: (i * metros) / METROS_POR_GRADO_LAT,
        lng: 0,
        altitude: opciones.altitudPorPunto === undefined ? null : i * opciones.altitudPorPunto,
        accuracyMeters: 5,
        clientPointId: `${sessionId}-${i}`,
      })),
    });
  }

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
    tokenOtro = (await registrarUsuario('dos')).token;
  });

  afterAll(async () => {
    await limpiar();
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  /** Deja a los dos usuarios sin sesiones, workouts ni posiciones. */
  async function limpiar(): Promise<void> {
    const usuarios = await prisma.user.findMany({
      where: { email: { contains: marca } },
      select: { id: true },
    });
    const ids = usuarios.map((u) => u.id);
    if (ids.length === 0) return;

    await prisma.position.deleteMany({ where: { userId: { in: ids } } });
    await prisma.trackingSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workoutSplit.deleteMany({ where: { workout: { userId: { in: ids } } } });
    await prisma.workout.deleteMany({ where: { userId: { in: ids } } });
    await prisma.shoe.deleteMany({ where: { userId: { in: ids } } });
  }

  afterEach(limpiar);

  // ─────────────────────────────────────────────────────────────────────────

  describe('arranque', () => {
    it('devuelve el ingestToken una sola vez y guarda solo su hash', async () => {
      const res = await arrancar().expect(201);
      const { data } = res.body as Envelope<Arranque>;

      expect(data.ingestToken).toHaveLength(43); // 32 bytes en base64url
      expect(data.session.status).toBe('active');
      expect(data.workout.type).toBe('free_run');

      const fila = await prisma.trackingSession.findUnique({ where: { id: data.session.id } });
      expect(fila?.ingestToken).not.toBe(data.ingestToken);
      expect(fila?.ingestToken).toHaveLength(64); // sha256 en hex
    });

    it('es idempotente por clientUuid y rota el token', async () => {
      const clientUuid = randomUUID();

      const primero = (await arrancar({ clientUuid }).expect(201)).body as Envelope<Arranque>;
      const segundo = (await arrancar({ clientUuid }).expect(201)).body as Envelope<Arranque>;

      expect(segundo.data.session.id).toBe(primero.data.session.id);
      expect(segundo.data.workout.id).toBe(primero.data.workout.id);
      expect(segundo.data.ingestToken).not.toBe(primero.data.ingestToken);

      expect(await prisma.workout.count({ where: { clientUuid } })).toBe(1);
    });

    it('rechaza una segunda sesion abierta con otro uuid', async () => {
      const primera = (await arrancar().expect(201)).body as Envelope<Arranque>;

      const res = await arrancar().expect(409);
      const { error } = res.body as ErrorBody;
      expect(error.code).toBe('SESSION_ALREADY_ACTIVE');
      expect(error.details[0]).toMatchObject({ sessionId: primera.data.session.id });
    });

    it('registra el dispositivo para que OsmAnd pueda resolverlo despues', async () => {
      const uniqueId = `${marca}-device`;
      await arrancar({ deviceId: uniqueId }).expect(201);

      const device = await prisma.device.findUnique({ where: { uniqueId } });
      expect(device?.userId).toBe(userId);
      await prisma.device.delete({ where: { uniqueId } });
    });

    it('exige token', async () => {
      await http().post('/api/v1/workouts/sessions').send({ clientUuid: randomUUID() }).expect(401);
    });
  });

  describe('pausa y reanudacion', () => {
    let sessionId = '';

    beforeEach(async () => {
      sessionId = ((await arrancar().expect(201)).body as Envelope<Arranque>).data.session.id;
    });

    it('pausa y reanuda', async () => {
      const pausada = await http()
        .patch(`/api/v1/workouts/sessions/${sessionId}/pause`)
        .set(auth())
        .expect(200);
      expect((pausada.body as Envelope<Sesion>).data.status).toBe('paused');

      const activa = await http()
        .patch(`/api/v1/workouts/sessions/${sessionId}/resume`)
        .set(auth())
        .expect(200);
      expect((activa.body as Envelope<Sesion>).data.status).toBe('active');
    });

    it('no reanuda una sesion que no esta en pausa', async () => {
      const res = await http()
        .patch(`/api/v1/workouts/sessions/${sessionId}/resume`)
        .set(auth())
        .expect(409);
      expect((res.body as ErrorBody).error.code).toBe('SESSION_NOT_ACTIVE');
    });

    it('no pausa dos veces', async () => {
      await http().patch(`/api/v1/workouts/sessions/${sessionId}/pause`).set(auth()).expect(200);
      await http().patch(`/api/v1/workouts/sessions/${sessionId}/pause`).set(auth()).expect(409);
    });
  });

  describe('consolidacion al finalizar', () => {
    const finalizar = (id: string, body: object = {}, t = token) =>
      http().post(`/api/v1/workouts/sessions/${id}/finish`).set(auth(t)).send(body);

    it('calcula distancia, splits y ritmo desde las posiciones', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      const desde = new Date(arranque.data.session.startedAt);

      // 121 puntos, 25 m cada 5 s: 3 km en 10 min, ritmo 3:20/km.
      await sembrarRecorrido(arranque.data.session.id, {
        puntos: 121,
        metros: 25,
        segundos: 5,
        desde,
        altitudPorPunto: 1,
      });

      const res = await finalizar(arranque.data.session.id).expect(200);
      const { data } = res.body as Envelope<Cierre>;

      expect(data.session.status).toBe('finished');
      expect(data.session.finishedAt).not.toBeNull();
      expect(data.workout.distanceMeters).toBeCloseTo(3000, -1);
      expect(data.workout.durationSeconds).toBe(600);
      expect(data.workout.movingSeconds).toBe(600);
      expect(data.workout.avgPaceSecPerKm).toBeCloseTo(200, -1);
      expect(data.workout.elevationGainMeters).toBeGreaterThan(100);
      expect(data.workout.splits).toHaveLength(3); // 3 km exactos
      expect(data.workout.bestKmIndex).not.toBeNull();
    });

    it('ignora los numeros del cliente pero los guarda para comparar', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      await sembrarRecorrido(arranque.data.session.id, {
        puntos: 41,
        metros: 25,
        segundos: 5,
        desde: new Date(arranque.data.session.startedAt),
      });

      const res = await finalizar(arranque.data.session.id, {
        clientReported: { distanceMeters: 99_999, durationSeconds: 1 },
        feeling: 4,
        notes: 'Con viento en contra',
      }).expect(200);

      const { data } = res.body as Envelope<Cierre>;
      expect(data.workout.distanceMeters).toBeCloseTo(1000, -1);
      expect(data.workout.distanceMeters).not.toBe(99_999);
      expect(data.workout.clientReported).toMatchObject({ distanceMeters: 99_999 });
      expect(data.workout.feeling).toBe(4);
      expect(data.workout.notes).toBe('Con viento en contra');
    });

    it('cierra una sesion sin posiciones con las metricas a cero', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      const res = await finalizar(arranque.data.session.id).expect(200);

      const { data } = res.body as Envelope<Cierre>;
      expect(data.workout.distanceMeters).toBe(0);
      expect(data.workout.avgPaceSecPerKm).toBeNull();
      expect(data.workout.splits).toEqual([]);
      expect(data.session.status).toBe('finished');
    });

    it('cuelga las posiciones del workout al cerrar', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      await sembrarRecorrido(arranque.data.session.id, {
        puntos: 10,
        metros: 25,
        segundos: 5,
        desde: new Date(arranque.data.session.startedAt),
      });

      await finalizar(arranque.data.session.id).expect(200);

      const colgadas = await prisma.position.count({
        where: { workoutId: arranque.data.workout.id },
      });
      expect(colgadas).toBe(10);
    });

    it('suma los kilometros a la zapatilla principal y avisa del desgaste', async () => {
      await prisma.shoe.create({
        data: {
          userId,
          brand: 'Adidas',
          model: 'Adizero',
          distanceMeters: 799_000,
          alertThresholdMeters: 800_000,
          isPrimary: true,
        },
      });

      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      await sembrarRecorrido(arranque.data.session.id, {
        puntos: 121,
        metros: 25,
        segundos: 5,
        desde: new Date(arranque.data.session.startedAt),
      });

      const res = await finalizar(arranque.data.session.id).expect(200);
      const { data } = res.body as Envelope<Cierre>;

      expect(data.shoe).not.toBeNull();
      expect(data.shoe!.distanceMeters).toBeGreaterThanOrEqual(802_000);
      expect(data.shoe!.wearAlert).toBe(true);
    });

    it('sin zapatilla principal se consolida igual', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      const res = await finalizar(arranque.data.session.id).expect(200);
      expect((res.body as Envelope<Cierre>).data.shoe).toBeNull();
    });

    it('no se finaliza dos veces', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      await finalizar(arranque.data.session.id).expect(200);

      const res = await finalizar(arranque.data.session.id).expect(409);
      expect((res.body as ErrorBody).error.code).toBe('SESSION_NOT_ACTIVE');
    });

    it('un usuario no cierra la sesion de otro', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      await finalizar(arranque.data.session.id, {}, tokenOtro).expect(404);
      await http()
        .patch(`/api/v1/workouts/sessions/${arranque.data.session.id}/pause`)
        .set(auth(tokenOtro))
        .expect(404);
    });

    it('finalizar libera el hueco para la siguiente sesion', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      await finalizar(arranque.data.session.id).expect(200);
      await arrancar().expect(201);
    });
  });

  describe('descarte', () => {
    it('borra las posiciones y marca el workout como borrado', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      await sembrarRecorrido(arranque.data.session.id, {
        puntos: 20,
        metros: 25,
        segundos: 5,
        desde: new Date(arranque.data.session.startedAt),
      });

      await http()
        .delete(`/api/v1/workouts/sessions/${arranque.data.session.id}`)
        .set(auth())
        .expect(204);

      const sesion = await prisma.trackingSession.findUnique({
        where: { id: arranque.data.session.id },
      });
      const workout = await prisma.workout.findUnique({ where: { id: arranque.data.workout.id } });
      const posiciones = await prisma.position.count({
        where: { trackingSessionId: arranque.data.session.id },
      });

      expect(sesion?.status).toBe('discarded');
      expect(workout?.deletedAt).not.toBeNull();
      expect(posiciones).toBe(0);
    });

    it('descartar libera el hueco, y no se descarta dos veces', async () => {
      const arranque = (await arrancar().expect(201)).body as Envelope<Arranque>;
      const url = `/api/v1/workouts/sessions/${arranque.data.session.id}`;

      await http().delete(url).set(auth()).expect(204);
      await http().delete(url).set(auth()).expect(409);
      await arrancar().expect(201);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────

  describe('sincronizacion offline', () => {
    /** Un entrenamiento ya terminado, con recorrido recto hacia el norte. */
    function itemConRecorrido(opciones: { puntos: number; metros: number; segundos: number }) {
      const inicio = new Date(Date.now() - opciones.puntos * opciones.segundos * 1000 - 60_000);
      const clientUuid = randomUUID();

      return {
        clientUuid,
        startedAt: inicio.toISOString(),
        endedAt: new Date(
          inicio.getTime() + (opciones.puntos - 1) * opciones.segundos * 1000,
        ).toISOString(),
        clientReported: { distanceMeters: 999_999 },
        points: Array.from({ length: opciones.puntos }, (_, i) => ({
          clientPointId: `${clientUuid}-${i}`,
          recordedAt: new Date(inicio.getTime() + i * opciones.segundos * 1000).toISOString(),
          lat: (i * opciones.metros) / METROS_POR_GRADO_LAT,
          lng: 0,
          accuracy: 5,
        })),
      };
    }

    const sincronizar = (workouts: object[], clave = randomUUID(), t = token) =>
      http()
        .post('/api/v1/workouts/sync')
        .set(auth(t))
        .set('Idempotency-Key', clave)
        .send({ workouts });

    it('exige la cabecera Idempotency-Key', async () => {
      const res = await http()
        .post('/api/v1/workouts/sync')
        .set(auth())
        .send({ workouts: [itemConRecorrido({ puntos: 5, metros: 25, segundos: 5 })] })
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('consolida las metricas desde los puntos e ignora lo que dice el cliente', async () => {
      const item = itemConRecorrido({ puntos: 41, metros: 25, segundos: 5 });
      const res = await sincronizar([item]).expect(200);
      const { data } = res.body as Envelope<{
        created: number;
        results: { status: string; workoutId: string | null }[];
      }>;

      expect(data.created).toBe(1);
      const workoutId = data.results[0]!.workoutId!;

      const detalle = (
        (await http().get(`/api/v1/workouts/${workoutId}`).set(auth()).expect(200))
          .body as Envelope<Workout>
      ).data;

      expect(detalle.distanceMeters).toBeGreaterThan(970);
      expect(detalle.distanceMeters).toBeLessThan(1030);
      expect(detalle.clientReported).toEqual({ distanceMeters: 999_999 });
      expect(detalle.splits).toHaveLength(1);

      expect(await prisma.position.count({ where: { workoutId } })).toBe(41);
    });

    it('reenviar el mismo lote no duplica nada', async () => {
      const item = itemConRecorrido({ puntos: 10, metros: 25, segundos: 5 });
      const clave = randomUUID();

      await sincronizar([item], clave).expect(200);
      const res = await sincronizar([item], clave).expect(200);
      const { data } = res.body as Envelope<{ duplicated: number; created: number }>;

      expect(data).toMatchObject({ created: 0, duplicated: 1 });
      expect(await prisma.workout.count({ where: { clientUuid: item.clientUuid } })).toBe(1);
    });

    it('sin puntos se guarda como manual con lo que declaro el usuario', async () => {
      const inicio = new Date(Date.now() - 3600_000);
      const res = await sincronizar([
        {
          clientUuid: randomUUID(),
          startedAt: inicio.toISOString(),
          endedAt: new Date(inicio.getTime() + 1800_000).toISOString(),
          distanceMeters: 6000,
          durationSeconds: 1800,
        },
      ]).expect(200);

      const { data } = res.body as Envelope<{ results: { workoutId: string | null }[] }>;
      const fila = await prisma.workout.findUniqueOrThrow({
        where: { id: data.results[0]!.workoutId! },
      });

      expect(fila.source).toBe('manual');
      expect(fila.distanceMeters).toBe(6000);
      expect(fila.avgPaceSecPerKm).toBe(300);
    });

    it('un item invalido no tumba el resto del lote', async () => {
      const bueno = itemConRecorrido({ puntos: 10, metros: 25, segundos: 5 });
      const malo = {
        ...itemConRecorrido({ puntos: 10, metros: 25, segundos: 5 }),
        planSessionId: 'no-existe',
      };

      const res = await sincronizar([malo, bueno]).expect(200);
      const { data } = res.body as Envelope<{
        created: number;
        rejected: number;
        results: { status: string; reason: string | null }[];
      }>;

      expect(data).toMatchObject({ created: 1, rejected: 1 });
      expect(data.results[0]!.reason).toContain('sesion del plan');
    });

    it('descarta los puntos con fecha fuera del entrenamiento', async () => {
      const item = itemConRecorrido({ puntos: 10, metros: 25, segundos: 5 });
      item.points.push({
        ...item.points[0]!,
        clientPointId: `${item.clientUuid}-viejo`,
        recordedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
      });

      const res = await sincronizar([item]).expect(200);
      const { data } = res.body as Envelope<{
        results: { workoutId: string | null; discardedPoints: number | null }[];
      }>;

      expect(data.results[0]!.discardedPoints).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.position.count({ where: { workoutId: data.results[0]!.workoutId! } }),
      ).toBe(10);
    });
  });

  describe('historial y estadisticas', () => {
    /** Deja `cantidad` entrenamientos ya cerrados, uno por dia hacia atras. */
    async function sembrarHistorial(cantidad: number, type: 'free_run' | 'race' = 'free_run') {
      for (let i = 0; i < cantidad; i += 1) {
        await prisma.workout.create({
          data: {
            userId,
            clientUuid: randomUUID(),
            type,
            startedAt: new Date(Date.now() - i * 24 * 3600_000),
            endedAt: new Date(Date.now() - i * 24 * 3600_000 + 1800_000),
            durationSeconds: 1800,
            movingSeconds: 1800,
            distanceMeters: 6000,
            avgPaceSecPerKm: 300,
          },
        });
      }
    }

    it('lista del mas reciente al mas viejo y pagina por cursor', async () => {
      await sembrarHistorial(5);

      const primera = await http().get('/api/v1/workouts?limit=2').set(auth()).expect(200);
      const cuerpo = primera.body as Envelope<{ id: string; startedAt: string }[]> & {
        meta: { nextCursor: string | null };
      };

      expect(cuerpo.data).toHaveLength(2);
      expect(new Date(cuerpo.data[0]!.startedAt).getTime()).toBeGreaterThan(
        new Date(cuerpo.data[1]!.startedAt).getTime(),
      );
      expect(cuerpo.meta.nextCursor).not.toBeNull();

      const segunda = await http()
        .get(`/api/v1/workouts?limit=2&cursor=${cuerpo.meta.nextCursor!}`)
        .set(auth())
        .expect(200);
      const siguiente = (segunda.body as Envelope<{ id: string }[]>).data;

      expect(siguiente).toHaveLength(2);
      expect(siguiente.map((w) => w.id)).not.toContain(cuerpo.data[0]!.id);
    });

    it('filtra por tipo y por rango de fechas', async () => {
      await sembrarHistorial(3);
      await sembrarHistorial(1, 'race');

      const soloCarreras = await http().get('/api/v1/workouts?type=race').set(auth()).expect(200);
      expect((soloCarreras.body as Envelope<unknown[]>).data).toHaveLength(1);

      const desdeAyer = new Date(Date.now() - 36 * 3600_000).toISOString();
      const recientes = await http()
        .get(`/api/v1/workouts?from=${desdeAyer}`)
        .set(auth())
        .expect(200);
      expect((recientes.body as Envelope<unknown[]>).data.length).toBeLessThan(4);
    });

    it('el borrado logico saca el entrenamiento del historial', async () => {
      await sembrarHistorial(1);
      const lista = (
        (await http().get('/api/v1/workouts').set(auth()).expect(200)).body as Envelope<
          { id: string }[]
        >
      ).data;

      await http().delete(`/api/v1/workouts/${lista[0]!.id}`).set(auth()).expect(204);
      await http().get(`/api/v1/workouts/${lista[0]!.id}`).set(auth()).expect(404);

      const despues = (
        (await http().get('/api/v1/workouts').set(auth()).expect(200)).body as Envelope<unknown[]>
      ).data;
      expect(despues).toHaveLength(0);
    });

    it('nadie ve ni borra el entrenamiento de otro', async () => {
      await sembrarHistorial(1);
      const lista = (
        (await http().get('/api/v1/workouts').set(auth()).expect(200)).body as Envelope<
          { id: string }[]
        >
      ).data;

      await http().get(`/api/v1/workouts/${lista[0]!.id}`).set(auth(tokenOtro)).expect(404);
      await http().delete(`/api/v1/workouts/${lista[0]!.id}`).set(auth(tokenOtro)).expect(404);

      const ajeno = await http().get('/api/v1/workouts').set(auth(tokenOtro)).expect(200);
      expect((ajeno.body as Envelope<unknown[]>).data).toHaveLength(0);
    });

    it('agrupa por semana y por mes en la zona del proyecto', async () => {
      await sembrarHistorial(3);

      const res = await http().get('/api/v1/workouts/grouped?by=week').set(auth()).expect(200);
      const { data } = res.body as Envelope<{
        by: string;
        groups: { distanceMeters: number; workouts: number; avgPaceSecPerKm: number | null }[];
      }>;

      expect(data.by).toBe('week');
      expect(data.groups.length).toBeGreaterThan(0);
      expect(data.groups.reduce((s, g) => s + g.distanceMeters, 0)).toBe(18_000);
      expect(data.groups[0]!.avgPaceSecPerKm).toBe(300);

      const porMes = await http().get('/api/v1/workouts/grouped?by=month').set(auth()).expect(200);
      expect((porMes.body as Envelope<{ groups: unknown[] }>).data.groups.length).toBeGreaterThan(
        0,
      );
    });

    it('el resumen semanal devuelve las siete casillas de cada semana', async () => {
      await sembrarHistorial(2);

      const res = await http().get('/api/v1/workouts/stats/weekly?weeks=3').set(auth()).expect(200);
      const { data } = res.body as Envelope<{
        weeks: { distanceMeters: number; days: { weekday: number }[] }[];
      }>;

      expect(data.weeks).toHaveLength(3);
      expect(data.weeks.map((s) => s.days.map((d) => d.weekday))).toEqual(
        Array.from({ length: 3 }, () => [1, 2, 3, 4, 5, 6, 7]),
      );
      expect(data.weeks.reduce((s, w) => s + w.distanceMeters, 0)).toBe(12_000);
    });
  });
});
