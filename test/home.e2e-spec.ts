import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { fechaLocal, lunesDe } from '../src/modules/training-plans/plan-schedule';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}

interface Prediccion {
  finishTimeSeconds: number | null;
  paceSecPerKm: number | null;
  confidence: string | null;
  basedOn: { workouts: number; avgWeeklyDistanceMeters: number } | null;
  reason: string | null;
}

interface Dia {
  weekday: number;
  startsAt: string;
  distanceMeters: number;
  workouts: number;
  plannedDistanceMeters: number | null;
  sessionId: string | null;
  sessionStatus: string | null;
}

interface Resumen {
  featuredMarathon:
    | (Record<string, unknown> & {
        id: string;
        distanceMeters: number;
        registrationId: string | null;
        bibNumber: string | null;
        isRegistered: boolean;
      })
    | null;
  prediction: Prediccion | null;
  plan: { id: string; currentWeek: number | null; totalWeeks: number } | null;
  planWeek: { week: number; sessions: { id: string; scheduledDate: string }[] } | null;
  todaySession: { id: string; scheduledDate: string } | null;
  week: {
    weekStartsAt: string;
    timezone: string;
    distanceMeters: number;
    workouts: number;
    days: Dia[];
  };
}

const ZONA = 'America/La_Paz';
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * El home agregado, contra Postgres real.
 *
 * Lo que importa: que una sola llamada traiga las cinco piezas, que la maratón
 * propia gane a la del catálogo, que la predicción diga "no hay datos" en vez de
 * fallar, y que la tira Mon–Sun cruce lo corrido con lo planificado por fecha.
 */
describe('Home (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `htest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let userId = '';
  let marathonId = '';
  let plantillaId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const hoy = () => fechaLocal(new Date(), ZONA);
  const comoFecha = (d: Date) => d.toISOString().slice(0, 10);

  const summary = async (): Promise<Resumen> => {
    const res = await http().get('/api/v1/home/summary').set(auth()).expect(200);
    return (res.body as Envelope<Resumen>).data;
  };

  /** Un entrenamiento ya consolidado, sin pasar por el tracking. */
  async function sembrarWorkout(
    distanceMeters: number,
    durationSeconds: number,
    diasAtras: number,
  ) {
    const startedAt = new Date(Date.now() - diasAtras * DIA_MS);

    return prisma.workout.create({
      data: {
        userId,
        clientUuid: randomUUID(),
        source: 'manual',
        startedAt,
        endedAt: new Date(startedAt.getTime() + durationSeconds * 1000),
        durationSeconds,
        movingSeconds: durationSeconds,
        distanceMeters,
        avgPaceSecPerKm: Math.round((durationSeconds * 1000) / distanceMeters),
        isSynced: true,
      },
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

    const registro = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `${marca}@test.com`,
        password: 'Test1234!',
        name: 'Corredor home',
        deviceId: marca,
      })
      .expect(201);

    const { data } = registro.body as Envelope<{ accessToken: string; user: { id: string } }>;
    token = data.accessToken;
    userId = data.user.id;

    const maraton = await prisma.marathon.create({
      data: {
        slug: `${marca}-maraton`,
        name: 'Maraton del home',
        city: 'La Paz',
        startsAt: new Date(Date.now() + 60 * DIA_MS),
        distanceMeters: 21_097,
        capacity: 100,
        priceCents: 20_000,
        publishedAt: new Date(),
      },
    });
    marathonId = maraton.id;

    plantillaId = (
      await prisma.trainingPlanTemplate.create({
        data: {
          slug: `${marca}-plan`,
          name: 'Plan del home',
          goalDistanceMeters: 21_097,
          level: 'beginner',
          totalWeeks: 8,
          weeklySessions: 2,
          avgWeeklyDistanceMeters: 20_000,
          sessions: {
            create: Array.from({ length: 8 }, (_, i) => i + 1).flatMap((week) => [
              {
                week,
                weekday: 2,
                type: 'easy' as const,
                targetDistanceMeters: 8000,
                paceFactor: 1.15,
              },
              {
                week,
                weekday: 7,
                type: 'long' as const,
                targetDistanceMeters: 14_000,
                paceFactor: 1.2,
              },
            ]),
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await limpiar();
    await prisma.trainingPlanTemplate.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  async function limpiar(): Promise<void> {
    if (!userId) return;

    await prisma.workoutSplit.deleteMany({ where: { workout: { userId } } });
    await prisma.workout.deleteMany({ where: { userId } });
    await prisma.trainingPlanSession.deleteMany({ where: { plan: { userId } } });
    await prisma.trainingPlan.deleteMany({ where: { userId } });
    await prisma.payment.deleteMany({ where: { registration: { userId } } });
    await prisma.registration.deleteMany({ where: { userId } });
  }

  afterEach(limpiar);

  // ─────────────────────────────────────────────────────────────────────────

  describe('cuenta recien creada', () => {
    it('trae las cinco piezas sin un solo dato del usuario', async () => {
      const data = await summary();

      // Sin inscripción, la destacada es la invitación del catálogo.
      expect(data.featuredMarathon?.id).toBe(marathonId);
      expect(data.featuredMarathon?.isRegistered).toBe(false);
      expect(data.featuredMarathon?.registrationId).toBeNull();

      expect(data.plan).toBeNull();
      expect(data.planWeek).toBeNull();
      expect(data.todaySession).toBeNull();

      expect(data.week.days).toHaveLength(7);
      expect(data.week.days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(data.week.distanceMeters).toBe(0);
      expect(data.week.timezone).toBe(ZONA);
    });

    it('la predicción dice insufficient_data en vez de fallar', async () => {
      const data = await summary();

      expect(data.prediction?.finishTimeSeconds).toBeNull();
      expect(data.prediction?.reason).toBe('insufficient_data');
    });
  });

  describe('predicción', () => {
    it('predice a partir de tres entrenamientos', async () => {
      // 10 km en 50 min, tres veces: 5:00/km proyectado a media maratón.
      await sembrarWorkout(10_000, 3000, 3);
      await sembrarWorkout(10_000, 3100, 10);
      await sembrarWorkout(10_000, 3200, 17);

      const data = await summary();

      expect(data.prediction?.reason).toBeNull();
      expect(data.prediction?.basedOn?.workouts).toBe(3);
      // Media maratón a algo más de 5:00/km: entre 1h45 y 2h15.
      expect(data.prediction!.finishTimeSeconds!).toBeGreaterThan(6300);
      expect(data.prediction!.finishTimeSeconds!).toBeLessThan(8100);
    });

    it('ignora los entrenamientos fuera de la ventana de 12 semanas', async () => {
      await sembrarWorkout(10_000, 3000, 3);
      await sembrarWorkout(10_000, 3000, 10);
      await sembrarWorkout(10_000, 3000, 200);

      const data = await summary();

      expect(data.prediction?.reason).toBe('insufficient_data');
    });

    it('ignora los entrenamientos borrados', async () => {
      const uno = await sembrarWorkout(10_000, 3000, 3);
      await sembrarWorkout(10_000, 3000, 10);
      await sembrarWorkout(10_000, 3000, 17);
      await prisma.workout.update({ where: { id: uno.id }, data: { deletedAt: new Date() } });

      const data = await summary();

      expect(data.prediction?.reason).toBe('insufficient_data');
    });
  });

  describe('maraton destacada', () => {
    it('la carrera pagada gana a la del catalogo', async () => {
      const otra = await prisma.marathon.create({
        data: {
          slug: `${marca}-mia`,
          name: 'La mia',
          city: 'Sucre',
          // Más lejos en el tiempo: aun así manda, porque es suya.
          startsAt: new Date(Date.now() + 90 * DIA_MS),
          distanceMeters: 42_195,
          capacity: 100,
          priceCents: 30_000,
          publishedAt: new Date(),
        },
      });

      const inscripcion = await prisma.registration.create({
        data: {
          userId,
          marathonId: otra.id,
          status: 'confirmed',
          step: 3,
          bibNumber: 'H-001',
          totalCents: 30_000,
          registeredAt: new Date(),
        },
      });

      const data = await summary();

      expect(data.featuredMarathon?.id).toBe(otra.id);
      expect(data.featuredMarathon?.isRegistered).toBe(true);
      expect(data.featuredMarathon?.registrationId).toBe(inscripcion.id);
      expect(data.featuredMarathon?.bibNumber).toBe('H-001');

      await prisma.marathon.delete({ where: { id: otra.id } });
    });
  });

  describe('plan activo', () => {
    /** Crea el plan y lo desplaza para que su semana 1 sea la de hoy. */
    async function planEnCurso(): Promise<{ planId: string; sesionDeHoy: string }> {
      const creado = await http()
        .post('/api/v1/training-plans')
        .set(auth())
        .send({ templateId: plantillaId })
        .expect(201);

      const planId = (creado.body as Envelope<{ id: string }>).data.id;
      const lunes = lunesDe(hoy());

      await prisma.trainingPlan.update({
        where: { id: planId },
        data: { startDate: lunes, endDate: new Date(lunes.getTime() + 8 * 7 * DIA_MS) },
      });

      const sesiones = await prisma.trainingPlanSession.findMany({
        where: { planId, week: 1 },
        orderBy: { weekday: 'asc' },
      });

      // La primera cae hoy; la otra, pasado mañana.
      await prisma.trainingPlanSession.update({
        where: { id: sesiones[0]!.id },
        data: { scheduledDate: hoy() },
      });
      await prisma.trainingPlanSession.update({
        where: { id: sesiones[1]!.id },
        data: { scheduledDate: new Date(hoy().getTime() + 2 * DIA_MS) },
      });

      return { planId, sesionDeHoy: sesiones[0]!.id };
    }

    it('devuelve el plan, su semana en curso y la sesion de hoy', async () => {
      const { planId, sesionDeHoy } = await planEnCurso();

      const data = await summary();

      expect(data.plan?.id).toBe(planId);
      expect(data.plan?.currentWeek).toBe(1);
      expect(data.planWeek?.week).toBe(1);
      expect(data.planWeek?.sessions).toHaveLength(2);
      expect(data.todaySession?.id).toBe(sesionDeHoy);
      expect(data.todaySession?.scheduledDate).toBe(comoFecha(hoy()));
    });

    it('la tira cruza lo planificado con lo corrido, casilla a casilla', async () => {
      const { sesionDeHoy } = await planEnCurso();
      await sembrarWorkout(6000, 1800, 0);

      const data = await summary();
      const casillaDeHoy = data.week.days.find((d) => d.sessionId === sesionDeHoy);

      expect(casillaDeHoy).toBeDefined();
      expect(casillaDeHoy!.plannedDistanceMeters).toBe(8000);
      expect(casillaDeHoy!.sessionStatus).toBe('pending');
      expect(casillaDeHoy!.distanceMeters).toBe(6000);
      expect(casillaDeHoy!.workouts).toBe(1);

      // Los días sin sesión ni entrenamiento vienen igual, en blanco.
      const vacios = data.week.days.filter((d) => d.sessionId === null);
      expect(vacios).toHaveLength(5);
      expect(vacios.every((d) => d.plannedDistanceMeters === null)).toBe(true);
    });

    it('un plan que ya termino no pinta sus sesiones sobre la semana de hoy', async () => {
      const { planId } = await planEnCurso();

      // El plan entero, cuatro meses atrás: su "semana actual" es la última.
      const viejo = new Date(hoy().getTime() - 120 * DIA_MS);
      await prisma.trainingPlan.update({
        where: { id: planId },
        data: { startDate: viejo, endDate: new Date(viejo.getTime() + 8 * 7 * DIA_MS) },
      });
      await prisma.trainingPlanSession.updateMany({
        where: { planId },
        data: { scheduledDate: viejo },
      });

      const data = await summary();

      expect(data.plan?.currentWeek).toBeNull();
      expect(data.todaySession).toBeNull();
      expect(data.week.days.every((d) => d.plannedDistanceMeters === null)).toBe(true);
    });
  });
});
