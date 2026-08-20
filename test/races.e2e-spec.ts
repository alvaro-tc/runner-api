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

interface Resultado {
  finishTimeSeconds: number;
  chipTimeSeconds: number | null;
  distanceMeters: number;
  avgPaceSecPerKm: number | null;
  overallRank: number | null;
  categoryRank: number | null;
  finishers: number | null;
  shareCardUrl: string | null;
  workoutId: string | null;
}

interface Carrera {
  registrationId: string;
  marathon: { id: string; name: string; startsAt: string };
  bibNumber: string | null;
  categoryName: string | null;
  status: 'upcoming' | 'completed';
  paymentStatus: string | null;
  result: Resultado | null;
}

interface Detalle extends Carrera {
  splits: { index: number; paceSecPerKm: number }[];
  checkpoints: { kmMark: number; splitSeconds: number; lat: number | null }[];
  routeGeoJson: { type: string; coordinates: [number, number][] } | null;
}

/** Mismo radio que usa `haversine`, para que las distancias del test sean exactas. */
const METROS_POR_GRADO_LAT = 111_194.93;

/**
 * Carreras contra Postgres real.
 *
 * Lo que importa: que el resultado nazca solo al cerrar una sesion atada a una
 * inscripcion, que los marcadores caigan cada 5 km, que los puestos respeten los
 * empates y que la carrera de otro devuelva 404.
 */
describe('Races (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `rtest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let userId = '';
  let tokenOtro = '';
  let userIdOtro = '';
  let marathonId = '';
  let categoryId = '';

  /** Largada seis horas atras: cualquier llegada de hoy cae despues. */
  const largada = new Date(Date.now() - 6 * 60 * 60 * 1000);

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

  /** Inscripcion confirmada y pagada, que es la unica que llega a ser carrera. */
  async function inscribir(
    quien: string,
    bib: string,
    opciones: { conCategoria?: boolean; pagada?: boolean } = {},
  ): Promise<string> {
    const registro = await prisma.registration.create({
      data: {
        userId: quien,
        marathonId,
        categoryId: opciones.conCategoria === false ? null : categoryId,
        status: 'confirmed',
        step: 3,
        bibNumber: bib,
        personalData: { fullName: 'Ana Quispe', docId: '1234567' },
        subtotalCents: 20_000,
        serviceFeeCents: 2000,
        totalCents: 22_000,
        registeredAt: new Date(),
        termsAcceptedAt: new Date(),
      },
    });

    if (opciones.pagada !== false) {
      await prisma.payment.create({
        data: {
          registrationId: registro.id,
          method: 'card',
          status: 'paid',
          amountCents: 22_000,
          idempotencyKey: `${marca}-${bib}`,
          paidAt: new Date(),
        },
      });
    }

    return registro.id;
  }

  /**
   * Corre la carrera entera: arranca la sesion, siembra un recorrido recto y la
   * cierra. Devuelve el id del entrenamiento.
   */
  async function correr(
    registrationId: string,
    opciones: { metros: number; segundos: number; quien?: string; t?: string },
  ): Promise<string> {
    const t = opciones.t ?? token;
    const quien = opciones.quien ?? userId;

    const arranque = await http()
      .post('/api/v1/workouts/sessions')
      .set(auth(t))
      .send({ clientUuid: randomUUID(), type: 'race', registrationId })
      .expect(201);

    const { data } = arranque.body as Envelope<{
      session: { id: string };
      workout: { id: string };
    }>;

    // Un punto por segundo, a velocidad constante hacia el norte.
    const puntos = opciones.segundos + 1;
    const metrosPorPunto = opciones.metros / opciones.segundos;
    const desde = new Date(largada.getTime() + 60_000);

    await prisma.position.createMany({
      data: Array.from({ length: puntos }, (_, i) => ({
        trackingSessionId: data.session.id,
        userId: quien,
        recordedAt: new Date(desde.getTime() + i * 1000),
        lat: (i * metrosPorPunto) / METROS_POR_GRADO_LAT,
        lng: 0,
        accuracyMeters: 5,
        clientPointId: `${data.session.id}-${i}`,
      })),
    });

    await http()
      .post(`/api/v1/workouts/sessions/${data.session.id}/finish`)
      .set(auth(t))
      .send({})
      .expect(200);

    return data.workout.id;
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

    const otro = await registrarUsuario('dos');
    tokenOtro = otro.token;
    userIdOtro = otro.id;

    const maraton = await prisma.marathon.create({
      data: {
        slug: `${marca}-maraton`,
        name: 'Maraton de prueba',
        city: 'La Paz',
        startsAt: largada,
        distanceMeters: 21_097,
        capacity: 100,
        priceCents: 20_000,
        publishedAt: new Date(),
        categories: { create: { name: 'General', minAge: 18, maxAge: 99 } },
      },
      include: { categories: true },
    });

    marathonId = maraton.id;
    categoryId = maraton.categories[0]!.id;
  });

  afterAll(async () => {
    await limpiar();
    await prisma.marathon.deleteMany({ where: { slug: { contains: marca } } });
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  /** Deja a los dos usuarios sin carreras, entrenamientos ni posiciones. */
  async function limpiar(): Promise<void> {
    const ids = [userId, userIdOtro].filter(Boolean);
    if (ids.length === 0) return;

    await prisma.position.deleteMany({ where: { userId: { in: ids } } });
    await prisma.trackingSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.workoutSplit.deleteMany({ where: { workout: { userId: { in: ids } } } });
    await prisma.raceCheckpoint.deleteMany({
      where: { raceResult: { registration: { userId: { in: ids } } } },
    });
    await prisma.raceResult.deleteMany({ where: { registration: { userId: { in: ids } } } });
    await prisma.workout.deleteMany({ where: { userId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { registration: { userId: { in: ids } } } });
    await prisma.registration.deleteMany({ where: { userId: { in: ids } } });
    await prisma.shoe.deleteMany({ where: { userId: { in: ids } } });
  }

  afterEach(limpiar);

  // ─────────────────────────────────────────────────────────────────────────

  describe('resultado', () => {
    it('nace al cerrar la sesion, con marcadores cada 5 km', async () => {
      const registrationId = await inscribir(userId, 'A-001');
      // 12 km en 2400 s: 5 m/s, asi que el km 5 cae a los 1000 s de correr.
      await correr(registrationId, { metros: 12_000, segundos: 2400 });

      const res = await http().get(`/api/v1/races/${registrationId}`).set(auth()).expect(200);

      const { data } = res.body as Envelope<Detalle>;

      expect(data.result).not.toBeNull();
      expect(data.result!.distanceMeters).toBeGreaterThan(11_900);
      expect(data.result!.overallRank).toBe(1);
      expect(data.result!.categoryRank).toBe(1);
      expect(data.result!.finishers).toBe(1);

      expect(data.checkpoints.map((c) => c.kmMark)).toEqual([5, 10]);
      expect(data.checkpoints[0]!.splitSeconds).toBeCloseTo(1000, -1);
      expect(data.splits).toHaveLength(12);
    });

    it('el tiempo oficial se mide desde la largada, no desde el boton', async () => {
      const registrationId = await inscribir(userId, 'A-002');
      await correr(registrationId, { metros: 5000, segundos: 1000 });

      const resultado = await prisma.raceResult.findFirstOrThrow({ where: { registrationId } });

      // El corredor arranco un minuto despues del disparo: su chip son 1000 s y
      // su tiempo oficial, 1060.
      expect(resultado.chipTimeSeconds).toBe(1000);
      expect(resultado.finishTimeSeconds).toBe(1060);
    });

    it('devuelve el recorrido simplificado en orden [lng, lat]', async () => {
      const registrationId = await inscribir(userId, 'A-003');
      await correr(registrationId, { metros: 5000, segundos: 1000 });

      const res = await http().get(`/api/v1/races/${registrationId}`).set(auth()).expect(200);
      const { data } = res.body as Envelope<Detalle>;

      expect(data.routeGeoJson?.type).toBe('LineString');
      // Una recta se reduce a sus extremos: 1001 puntos entran, dos salen.
      expect(data.routeGeoJson!.coordinates).toHaveLength(2);
      expect(data.routeGeoJson!.coordinates[0]![0]).toBe(0);
    });

    it('los empates comparten puesto', async () => {
      const mio = await inscribir(userId, 'B-001');
      const suyo = await inscribir(userIdOtro, 'B-002');

      await correr(mio, { metros: 5000, segundos: 1000 });
      await correr(suyo, { metros: 5000, segundos: 1000, quien: userIdOtro, t: tokenOtro });

      const puestos = await prisma.raceResult.findMany({
        where: { registration: { marathonId } },
        select: { overallRank: true, categoryRank: true },
      });

      expect(puestos).toHaveLength(2);
      expect(puestos.every((p) => p.overallRank === 1)).toBe(true);
      expect(puestos.every((p) => p.categoryRank === 1)).toBe(true);
    });

    it('ordena por tiempo oficial cuando no hay empate', async () => {
      const rapido = await inscribir(userId, 'C-001');
      const lento = await inscribir(userIdOtro, 'C-002');

      await correr(rapido, { metros: 5000, segundos: 1000 });
      await correr(lento, { metros: 5000, segundos: 1500, quien: userIdOtro, t: tokenOtro });

      const puestos = await prisma.raceResult.findMany({
        where: { registration: { marathonId } },
        orderBy: { overallRank: 'asc' },
        select: { overallRank: true, registration: { select: { bibNumber: true } } },
      });

      expect(puestos.map((p) => p.registration.bibNumber)).toEqual(['C-001', 'C-002']);
      expect(puestos.map((p) => p.overallRank)).toEqual([1, 2]);
    });
  });

  describe('mis carreras', () => {
    it('resume distancia corrida y dinero gastado', async () => {
      const registrationId = await inscribir(userId, 'D-001');
      await correr(registrationId, { metros: 5000, segundos: 1000 });

      const res = await http().get('/api/v1/races/me/summary').set(auth()).expect(200);
      const { data } = res.body as Envelope<{
        racesCompleted: number;
        totalDistanceMeters: number;
        totalSpentCents: number;
        currency: string;
        nextRace: Carrera | null;
      }>;

      expect(data.racesCompleted).toBe(1);
      expect(data.totalDistanceMeters).toBeGreaterThan(4900);
      expect(data.totalSpentCents).toBe(22_000);
      expect(data.currency).toBe('BOB');
      // La maraton del test ya se corrio: no hay proxima.
      expect(data.nextRace).toBeNull();
    });

    it('no suma un pago reembolsado', async () => {
      const registrationId = await inscribir(userId, 'D-002');
      await prisma.payment.updateMany({ where: { registrationId }, data: { status: 'refunded' } });

      const res = await http().get('/api/v1/races/me/summary').set(auth()).expect(200);
      const { data } = res.body as Envelope<{ totalSpentCents: number }>;

      expect(data.totalSpentCents).toBe(0);
    });

    it('filtra pasadas y proximas por la hora de largada', async () => {
      await inscribir(userId, 'E-001');

      const pasadas = await http().get('/api/v1/races/me?status=completed').set(auth()).expect(200);
      const proximas = await http().get('/api/v1/races/me?status=upcoming').set(auth()).expect(200);

      expect((pasadas.body as Envelope<Carrera[]>).data).toHaveLength(1);
      expect((pasadas.body as Envelope<Carrera[]>).data[0]!.status).toBe('completed');
      expect((pasadas.body as Envelope<Carrera[]>).data[0]!.paymentStatus).toBe('paid');
      expect((proximas.body as Envelope<Carrera[]>).data).toHaveLength(0);
    });

    it('una carrera sin resultado se lista igual, con result en null', async () => {
      const registrationId = await inscribir(userId, 'E-002');

      const res = await http().get(`/api/v1/races/${registrationId}`).set(auth()).expect(200);
      const { data } = res.body as Envelope<Detalle>;

      expect(data.result).toBeNull();
      expect(data.bibNumber).toBe('E-002');
      expect(data.routeGeoJson).toBeNull();
    });
  });

  describe('autorizacion y estados', () => {
    it('la carrera de otro devuelve 404, no 403', async () => {
      const registrationId = await inscribir(userId, 'F-001');
      await correr(registrationId, { metros: 5000, segundos: 1000 });

      const res = await http()
        .get(`/api/v1/races/${registrationId}`)
        .set(auth(tokenOtro))
        .expect(404);

      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('pedir splits sin resultado responde RESULT_NOT_AVAILABLE', async () => {
      const registrationId = await inscribir(userId, 'F-002');

      const res = await http()
        .get(`/api/v1/races/${registrationId}/splits`)
        .set(auth())
        .expect(409);

      expect((res.body as ErrorBody).error.code).toBe('RESULT_NOT_AVAILABLE');
    });

    it('pedir el comprobante sin pago cobrado responde RECEIPT_NOT_AVAILABLE', async () => {
      const registrationId = await inscribir(userId, 'F-003', { pagada: false });

      const res = await http()
        .get(`/api/v1/races/${registrationId}/receipt`)
        .set(auth())
        .expect(409);

      expect((res.body as ErrorBody).error.code).toBe('RECEIPT_NOT_AVAILABLE');
    });

    it('devuelve el comprobante del pago cobrado', async () => {
      const registrationId = await inscribir(userId, 'F-004');

      const res = await http()
        .get(`/api/v1/races/${registrationId}/receipt`)
        .set(auth())
        .expect(200);

      expect((res.body as Envelope<{ url: string }>).data.url).toContain('.pdf');
    });
  });

  describe('tarjeta para compartir', () => {
    it('genera un PNG y lo deja en el resultado', async () => {
      const registrationId = await inscribir(userId, 'G-001');
      await correr(registrationId, { metros: 5000, segundos: 1000 });

      const res = await http()
        .post(`/api/v1/races/${registrationId}/share-card`)
        .set(auth())
        .expect(200);

      const { data } = res.body as Envelope<{ url: string }>;
      expect(data.url).toMatch(/\/uploads\/races\/cards\/.+\.png$/);

      const detalle = await http().get(`/api/v1/races/${registrationId}`).set(auth()).expect(200);
      expect((detalle.body as Envelope<Detalle>).data.result!.shareCardUrl).toBe(data.url);
    });
  });
});
