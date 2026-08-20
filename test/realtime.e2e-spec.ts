import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}

interface PosicionEnVivo {
  bib: string | null;
  lat: number;
  lng: number;
  distanceMeters: number;
  t: string;
}

const METROS_POR_GRADO_LAT = 111_194.93;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Seguimiento en vivo, con sockets de verdad contra la app escuchando.
 *
 * Lo que importa: que sin token no se entre, que las salas separen maratones,
 * que un entrenamiento normal **no** se publique a nadie y que el throttling
 * corte las posiciones de más.
 */
describe('Realtime (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let url = '';

  const marca = `lvtest-${Date.now()}`;
  const http = () => request(app.getHttpServer());
  const abiertos: Socket[] = [];

  let token = '';
  let userId = '';
  let marathonId = '';
  let otraMarathonId = '';
  let registrationId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });

  /** Un espectador conectado y suscrito a una maratón. */
  async function espectador(marathon: string, conToken = token): Promise<Socket> {
    const socket = io(`${url}/live`, {
      auth: { token: conToken },
      transports: ['websocket'],
      forceNew: true,
    });
    abiertos.push(socket);

    await new Promise<void>((listo, falla) => {
      socket.on('connect', () => listo());
      socket.on('connect_error', falla);
      socket.on('disconnect', () => falla(new Error('desconectado')));
    });

    const respuesta = await socket.emitWithAck('spectate', { marathonId: marathon });
    expect(respuesta).toEqual({ ok: true, room: `marathon:${marathon}` });

    return socket;
  }

  /** Espera un `runner:position`, o resuelve `null` si no llega ninguno. */
  function esperarPosicion(socket: Socket, ms = 1500): Promise<PosicionEnVivo | null> {
    return new Promise((listo) => {
      const temporizador = setTimeout(() => listo(null), ms);
      socket.once('runner:position', (payload: PosicionEnVivo) => {
        clearTimeout(temporizador);
        listo(payload);
      });
    });
  }

  /** Arranca una sesión y devuelve su `ingestToken`. */
  async function arrancar(body: object): Promise<{ sessionId: string; ingestToken: string }> {
    const res = await http()
      .post('/api/v1/workouts/sessions')
      .set(auth())
      .send({ clientUuid: randomUUID(), ...body })
      .expect(201);

    const { data } = res.body as Envelope<{ session: { id: string }; ingestToken: string }>;
    return { sessionId: data.session.id, ingestToken: data.ingestToken };
  }

  /** Manda un lote de puntos por la ingesta real. */
  function ingerir(sessionId: string, ingestToken: string, desdeIndice: number, cuantos: number) {
    const ahora = Date.now();

    return http()
      .post(`/api/v1/tracking/sessions/${sessionId}/positions`)
      .set({ Authorization: `Bearer ${ingestToken}` })
      .send({
        points: Array.from({ length: cuantos }, (_, i) => ({
          clientPointId: `${sessionId}-${desdeIndice + i}`,
          recordedAt: new Date(ahora - (cuantos - i) * 1000).toISOString(),
          lat: ((desdeIndice + i) * 10) / METROS_POR_GRADO_LAT,
          lng: 0,
          accuracy: 5,
        })),
      })
      .expect(202);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    // Sin puerto real no hay sockets: `listen(0)` coge uno libre.
    await app.listen(0);
    url = await app.getUrl().then((u) => u.replace('[::1]', '127.0.0.1'));
    prisma = app.get(PrismaService);

    const registro = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `${marca}@test.com`,
        password: 'Test1234!',
        name: 'Corredor live',
        deviceId: marca,
      })
      .expect(201);

    const { data } = registro.body as Envelope<{ accessToken: string; user: { id: string } }>;
    token = data.accessToken;
    userId = data.user.id;

    const crearMaraton = (slug: string) =>
      prisma.marathon.create({
        data: {
          slug: `${marca}-${slug}`,
          name: `Maraton ${slug}`,
          city: 'La Paz',
          startsAt: new Date(Date.now() + DIA_MS),
          distanceMeters: 21_097,
          capacity: 100,
          priceCents: 20_000,
          publishedAt: new Date(),
        },
      });

    marathonId = (await crearMaraton('uno')).id;
    otraMarathonId = (await crearMaraton('dos')).id;

    registrationId = (
      await prisma.registration.create({
        data: {
          userId,
          marathonId,
          status: 'confirmed',
          step: 3,
          bibNumber: 'L-007',
          totalCents: 20_000,
          registeredAt: new Date(),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await limpiar();
    await prisma.registration.deleteMany({ where: { userId } });
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  afterEach(async () => {
    for (const socket of abiertos.splice(0)) socket.disconnect();
    await limpiar();
  });

  async function limpiar(): Promise<void> {
    if (!userId) return;

    await prisma.position.deleteMany({ where: { userId } });
    await prisma.trackingSession.deleteMany({ where: { userId } });
    await prisma.workoutSplit.deleteMany({ where: { workout: { userId } } });
    await prisma.workout.deleteMany({ where: { userId } });
  }

  // ─────────────────────────────────────────────────────────────────────────

  describe('conexion', () => {
    it('sin token no se entra', async () => {
      const socket = io(`${url}/live`, { transports: ['websocket'], forceNew: true });
      abiertos.push(socket);

      const desconectado = await new Promise<boolean>((listo) => {
        socket.on('disconnect', () => listo(true));
        socket.on('connect_error', () => listo(true));
        setTimeout(() => listo(false), 2000);
      });

      expect(desconectado).toBe(true);
    });

    it('una maratón que no existe no se puede espiar', async () => {
      const socket = io(`${url}/live`, {
        auth: { token },
        transports: ['websocket'],
        forceNew: true,
      });
      abiertos.push(socket);
      await new Promise<void>((listo) => socket.on('connect', () => listo()));

      const respuesta = await socket.emitWithAck('spectate', { marathonId: 'no-existe' });

      expect(respuesta).toEqual({ ok: false, error: 'MARATHON_NOT_FOUND' });
    });
  });

  describe('publicacion', () => {
    it('publica la posicion del corredor con su dorsal', async () => {
      const socket = await espectador(marathonId);
      const { sessionId, ingestToken } = await arrancar({ type: 'race', registrationId });

      const esperando = esperarPosicion(socket);
      await ingerir(sessionId, ingestToken, 0, 10);

      const payload = await esperando;

      expect(payload).not.toBeNull();
      expect(payload!.bib).toBe('L-007');
      expect(payload!.distanceMeters).toBeGreaterThan(0);
      // Nada que identifique a la persona detrás del dorsal.
      expect(Object.keys(payload!).sort()).toEqual(['bib', 'distanceMeters', 'lat', 'lng', 't']);
    });

    it('un entrenamiento normal no se publica a nadie', async () => {
      const socket = await espectador(marathonId);
      const { sessionId, ingestToken } = await arrancar({});

      const esperando = esperarPosicion(socket);
      await ingerir(sessionId, ingestToken, 0, 10);

      expect(await esperando).toBeNull();
    });

    it('la sala de otra maraton no ve nada', async () => {
      const mirandoOtra = await espectador(otraMarathonId);
      const { sessionId, ingestToken } = await arrancar({ type: 'race', registrationId });

      const esperando = esperarPosicion(mirandoOtra);
      await ingerir(sessionId, ingestToken, 0, 10);

      expect(await esperando).toBeNull();
    });

    it('el throttling corta el segundo lote seguido', async () => {
      const socket = await espectador(marathonId);
      const { sessionId, ingestToken } = await arrancar({ type: 'race', registrationId });

      const primera = esperarPosicion(socket);
      await ingerir(sessionId, ingestToken, 0, 10);
      expect(await primera).not.toBeNull();

      // Dentro de los 5 s de la ventana: se acumula, pero no se emite.
      const segunda = esperarPosicion(socket);
      await ingerir(sessionId, ingestToken, 10, 10);

      expect(await segunda).toBeNull();
    });

    it('dejar la sala corta el flujo', async () => {
      const socket = await espectador(marathonId);
      await socket.emitWithAck('leave', { marathonId });

      const { sessionId, ingestToken } = await arrancar({ type: 'race', registrationId });
      const esperando = esperarPosicion(socket);
      await ingerir(sessionId, ingestToken, 0, 10);

      expect(await esperando).toBeNull();
    });
  });
});
