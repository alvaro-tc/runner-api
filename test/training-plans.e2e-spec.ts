import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}
interface ErrorBody {
  error: { code: string; message: string; details: unknown[] };
}

interface Plan {
  id: string;
  name: string;
  marathonId: string | null;
  totalWeeks: number;
  startDate: string;
  endDate: string;
  paceBasisSecPerKm: number;
  status: string;
  isActive: boolean;
  totalSessions: number;
  completedSessions: number;
  paceBasisSource?: string;
}

interface Sesion {
  id: string;
  week: number;
  weekday: number;
  scheduledDate: string;
  type: string;
  paceMinSecPerKm: number | null;
  paceMaxSecPerKm: number | null;
  status: string;
  rescheduledFromDate: string | null;
  workoutId: string | null;
}

interface Sugerencia {
  template: { id: string; slug: string; totalWeeks: number };
  weeksAvailable: number;
  fits: boolean;
  effectiveWeeks: number;
}

const enDias = (dias: number) => new Date(Date.now() + dias * 86_400_000);

/**
 * Planes de entrenamiento contra Postgres real.
 *
 * El foco esta en lo que no se ve mirando una fila: el anclaje a la semana de
 * la carrera, el recorte cuando el plan no entra, la regla de un solo plan
 * activo y que nadie toque las sesiones de otro.
 */
describe('Training plans (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `tptest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let tokenOtro = '';
  let plantillaCortaId = '';
  let plantillaLargaId = '';
  let marathonId = '';

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  async function registrarUsuario(sufijo: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `${marca}-${sufijo}@test.com`,
        password: 'Test1234!',
        name: `Corredor ${sufijo}`,
        deviceId: `${marca}-${sufijo}`,
      })
      .expect(201);

    return (res.body as Envelope<{ accessToken: string }>).data.accessToken;
  }

  /** Plantilla con una sesion facil de ubicar: martes y domingo de cada semana. */
  async function crearPlantilla(slug: string, totalWeeks: number) {
    return prisma.trainingPlanTemplate.create({
      data: {
        slug: `${marca}-${slug}`,
        name: `Plan ${slug}`,
        goalDistanceMeters: 21_097,
        level: 'beginner',
        totalWeeks,
        weeklySessions: 2,
        avgWeeklyDistanceMeters: 20_000,
        sessions: {
          create: Array.from({ length: totalWeeks }, (_, i) => i + 1).flatMap((week) => [
            {
              week,
              weekday: 2,
              type: 'easy' as const,
              targetDistanceMeters: 8_000,
              paceFactor: 1.15,
            },
            {
              week,
              weekday: 7,
              type: 'long' as const,
              targetDistanceMeters: 14_000,
              paceFactor: 1.2,
              isKeySession: true,
            },
          ]),
        },
      },
    });
  }

  const crearPlan = (body: object, t = token) =>
    http().post('/api/v1/training-plans').set(auth(t)).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    token = await registrarUsuario('uno');
    tokenOtro = await registrarUsuario('dos');

    plantillaCortaId = (await crearPlantilla('corta', 4)).id;
    plantillaLargaId = (await crearPlantilla('larga', 12)).id;

    const maraton = await prisma.marathon.create({
      data: {
        slug: `${marca}-media`,
        name: 'Media Cochabamba Prueba',
        city: 'Cochabamba',
        startsAt: enDias(120),
        distanceMeters: 21_097,
        capacity: 500,
        priceCents: 15_000,
        publishedAt: new Date(),
      },
    });
    marathonId = maraton.id;

    // A cinco semanas: el plan de 12 solo entra recortado; el de 4 entra entero.
    await prisma.marathon.create({
      data: {
        slug: `${marca}-cercana`,
        name: 'Media Tarija Prueba',
        city: 'Tarija',
        startsAt: enDias(35),
        distanceMeters: 21_097,
        capacity: 500,
        priceCents: 15_000,
        publishedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.trainingPlan.deleteMany({ where: { user: { email: { contains: marca } } } });
    await prisma.trainingPlanTemplate.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  /** Deja a los dos usuarios sin planes. */
  const limpiarPlanes = () =>
    prisma.trainingPlan.deleteMany({ where: { user: { email: { contains: marca } } } });

  // ─────────────────────────────────────────────────────────────────────────

  describe('catalogo', () => {
    it('es publico y filtra por distancia y nivel', async () => {
      const res = await http()
        .get('/api/v1/training-plans/templates?goalDistance=21097&level=beginner')
        .expect(200);

      const { data } = res.body as Envelope<{ slug: string }[]>;
      expect(data.some((t) => t.slug === `${marca}-corta`)).toBe(true);
    });

    it('el detalle trae las sesiones con paceFactor, sin ritmos concretos', async () => {
      const res = await http().get(`/api/v1/training-plans/templates/${marca}-corta`).expect(200);

      const { data } = res.body as Envelope<{ sessions: { paceFactor: number }[] }>;
      expect(data.sessions).toHaveLength(8);
      expect(data.sessions[0]!.paceFactor).toBeGreaterThan(0);
    });

    it('una plantilla inexistente es 404', async () => {
      const res = await http().get('/api/v1/training-plans/templates/no-existe').expect(404);
      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });
  });

  describe('sugerencias', () => {
    it('marca cuales entran enteras y cuales se recortan', async () => {
      const res = await http()
        .get(`/api/v1/training-plans/suggestions?marathonId=${marca}-media`)
        .expect(200);

      const { data } = res.body as Envelope<Sugerencia[]>;
      const corta = data.find((s) => s.template.slug === `${marca}-corta`)!;
      const larga = data.find((s) => s.template.slug === `${marca}-larga`)!;

      // A 120 dias caben las dos, y la mas larga va primero.
      expect(corta.fits).toBe(true);
      expect(larga.fits).toBe(true);
      expect(data.indexOf(larga)).toBeLessThan(data.indexOf(corta));
    });

    it('con la carrera encima devuelve el recorte, no una lista vacia', async () => {
      const res = await http()
        .get(`/api/v1/training-plans/suggestions?marathonId=${marca}-cercana`)
        .expect(200);

      const { data } = res.body as Envelope<Sugerencia[]>;
      const larga = data.find((s) => s.template.slug === `${marca}-larga`)!;

      expect(larga.fits).toBe(false);
      expect(larga.effectiveWeeks).toBeLessThan(12);
      expect(larga.effectiveWeeks).toBeGreaterThanOrEqual(3);
      expect(larga.effectiveWeeks).toBe(larga.weeksAvailable);
      // La de 4 semanas si entra entera, y por eso va primero.
      expect(data[0]!.template.slug).toBe(`${marca}-corta`);
    });
  });

  describe('instanciacion', () => {
    afterEach(limpiarPlanes);

    it('sin maraton arranca un lunes y materializa todas las sesiones', async () => {
      const res = await crearPlan({ templateId: plantillaCortaId }).expect(201);
      const { data } = res.body as Envelope<Plan>;

      expect(data.totalWeeks).toBe(4);
      expect(data.totalSessions).toBe(8);
      expect(new Date(`${data.startDate}T00:00:00Z`).getUTCDay()).toBe(1);
      // Sin historial de entrenamientos, el ritmo sale del nivel declarado.
      expect(data.paceBasisSource).toBe('declared_level');
      expect(data.paceBasisSecPerKm).toBe(420);
    });

    it('con maraton ancla el final a la semana de la carrera', async () => {
      const res = await crearPlan({
        templateId: plantillaLargaId,
        marathonId: marca + '-media',
      }).expect(201);
      const { data } = res.body as Envelope<Plan>;

      expect(data.marathonId).toBe(marathonId);
      expect(data.totalWeeks).toBe(12);

      const largada = enDias(120);
      const fin = new Date(`${data.endDate}T00:00:00Z`);
      // El plan termina el domingo de la semana de la carrera: la largada cae
      // dentro de la ultima semana, nunca despues del final.
      expect(fin.getTime()).toBeGreaterThanOrEqual(largada.getTime() - 7 * 86_400_000);
      expect(fin.getUTCDay()).toBe(0);
    });

    it('recorta desde el medio y conserva primera semana y tapering', async () => {
      const res = await crearPlan({
        templateId: plantillaLargaId,
        marathonId: marca + '-cercana',
      }).expect(201);
      const { data } = res.body as Envelope<Plan>;

      expect(data.totalWeeks).toBeLessThan(12);
      expect(data.totalWeeks).toBeGreaterThanOrEqual(3);
      expect(data.totalSessions).toBe(data.totalWeeks * 2);
    });

    it('las sesiones traen rango de ritmo derivado del paceFactor', async () => {
      await crearPlan({ templateId: plantillaCortaId }).expect(201);

      const res = await http()
        .get('/api/v1/training-plans/me/current?week=1')
        .set(auth())
        .expect(200);
      const { data } = res.body as Envelope<{ sessions: Sesion[] }>;

      const suave = data.sessions.find((s) => s.type === 'easy')!;
      // 420 x 1.15 = 483, +-4%.
      expect(suave.paceMinSecPerKm).toBe(464);
      expect(suave.paceMaxSecPerKm).toBe(502);
    });

    it('rechaza un segundo plan sin confirmacion, y lo acepta con replaceActive', async () => {
      const primero = await crearPlan({ templateId: plantillaCortaId }).expect(201);
      const primeroId = (primero.body as Envelope<Plan>).data.id;

      const conflicto = await crearPlan({ templateId: plantillaLargaId }).expect(409);
      expect((conflicto.body as ErrorBody).error.code).toBe('PLAN_ALREADY_ACTIVE');

      await crearPlan({ templateId: plantillaLargaId, replaceActive: true }).expect(201);

      const anterior = await prisma.trainingPlan.findUnique({ where: { id: primeroId } });
      expect(anterior?.status).toBe('abandoned');
      expect(anterior?.isActive).toBe(false);
    });

    it('falla si no queda tiempo ni para el minimo', async () => {
      const maratonManana = await prisma.marathon.create({
        data: {
          slug: `${marca}-manana`,
          name: 'Manana Prueba',
          city: 'La Paz',
          startsAt: enDias(2),
          distanceMeters: 21_097,
          capacity: 100,
          priceCents: 10_000,
          publishedAt: new Date(),
        },
      });

      const res = await crearPlan({
        templateId: plantillaLargaId,
        marathonId: maratonManana.id,
      }).expect(409);

      expect((res.body as ErrorBody).error.code).toBe('PLAN_DOES_NOT_FIT');
      await prisma.marathon.delete({ where: { id: maratonManana.id } });
    });
  });

  describe('sesiones', () => {
    let sesionId = '';
    let planId = '';
    let startDate = '';
    let endDate = '';

    beforeEach(async () => {
      await limpiarPlanes();
      const creado = await crearPlan({ templateId: plantillaCortaId }).expect(201);
      const plan = (creado.body as Envelope<Plan>).data;
      planId = plan.id;
      startDate = plan.startDate;
      endDate = plan.endDate;

      const semana = await http().get('/api/v1/training-plans/me/current?week=1').set(auth());
      sesionId = (semana.body as Envelope<{ sessions: Sesion[] }>).data.sessions[0]!.id;
    });

    afterAll(limpiarPlanes);

    it('completar suma al progreso del plan', async () => {
      const res = await http()
        .patch(`/api/v1/training-plans/sessions/${sesionId}/complete`)
        .set(auth())
        .send({})
        .expect(200);

      expect((res.body as Envelope<Sesion>).data.status).toBe('completed');

      const mios = await http().get('/api/v1/training-plans/me').set(auth()).expect(200);
      expect((mios.body as Envelope<{ active: Plan }>).data.active.completedSessions).toBe(1);
    });

    it('no se puede completar dos veces', async () => {
      const completar = () =>
        http().patch(`/api/v1/training-plans/sessions/${sesionId}/complete`).set(auth()).send({});

      await completar().expect(200);
      const res = await completar().expect(409);
      expect((res.body as ErrorBody).error.code).toBe('SESSION_NOT_PENDING');
    });

    it('reprogramar guarda la fecha original una sola vez', async () => {
      const original = new Date(`${startDate}T00:00:00Z`);
      const mover = (dias: number) =>
        http()
          .patch(`/api/v1/training-plans/sessions/${sesionId}/reschedule`)
          .set(auth())
          .send({
            scheduledDate: new Date(original.getTime() + dias * 86_400_000)
              .toISOString()
              .slice(0, 10),
          });

      const primera = await mover(3).expect(200);
      const origen = (primera.body as Envelope<Sesion>).data.rescheduledFromDate;
      expect(origen).not.toBeNull();

      const segunda = await mover(4).expect(200);
      expect((segunda.body as Envelope<Sesion>).data.rescheduledFromDate).toBe(origen);
    });

    it('no deja mover una sesion fuera del plan', async () => {
      const fuera = new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 7 * 86_400_000);
      const res = await http()
        .patch(`/api/v1/training-plans/sessions/${sesionId}/reschedule`)
        .set(auth())
        .send({ scheduledDate: fuera.toISOString().slice(0, 10) })
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('el plan se cierra solo cuando no queda ninguna sesion abierta', async () => {
      const sesiones = await prisma.trainingPlanSession.findMany({ where: { planId } });
      for (const s of sesiones) {
        await http()
          .patch(`/api/v1/training-plans/sessions/${s.id}/complete`)
          .set(auth())
          .send({ skipped: true })
          .expect(200);
      }

      const plan = await prisma.trainingPlan.findUnique({ where: { id: planId } });
      expect(plan?.status).toBe('completed');
      expect(plan?.isActive).toBe(false);
    });

    it('un usuario no ve ni toca las sesiones de otro', async () => {
      await http()
        .patch(`/api/v1/training-plans/sessions/${sesionId}/complete`)
        .set(auth(tokenOtro))
        .send({})
        .expect(404);

      await http()
        .patch(`/api/v1/training-plans/${planId}/abandon`)
        .set(auth(tokenOtro))
        .expect(404);
      await http().delete(`/api/v1/training-plans/${planId}`).set(auth(tokenOtro)).expect(404);
    });
  });

  describe('ciclo de vida', () => {
    afterEach(limpiarPlanes);

    it('abandonar libera el hueco para un plan nuevo sin confirmacion', async () => {
      const creado = await crearPlan({ templateId: plantillaCortaId }).expect(201);
      const planId = (creado.body as Envelope<Plan>).data.id;

      const res = await http()
        .patch(`/api/v1/training-plans/${planId}/abandon`)
        .set(auth())
        .expect(200);
      expect((res.body as Envelope<Plan>).data.status).toBe('abandoned');

      await crearPlan({ templateId: plantillaLargaId }).expect(201);
    });

    it('abandonar dos veces es conflicto', async () => {
      const creado = await crearPlan({ templateId: plantillaCortaId }).expect(201);
      const planId = (creado.body as Envelope<Plan>).data.id;

      await http().patch(`/api/v1/training-plans/${planId}/abandon`).set(auth()).expect(200);
      const res = await http()
        .patch(`/api/v1/training-plans/${planId}/abandon`)
        .set(auth())
        .expect(409);
      expect((res.body as ErrorBody).error.code).toBe('PLAN_NOT_ACTIVE');
    });

    it('reiniciar rehace las sesiones y borra el progreso', async () => {
      const creado = await crearPlan({ templateId: plantillaCortaId }).expect(201);
      const planId = (creado.body as Envelope<Plan>).data.id;

      const semana = await http().get('/api/v1/training-plans/me/current?week=1').set(auth());
      const sesionId = (semana.body as Envelope<{ sessions: Sesion[] }>).data.sessions[0]!.id;
      await http()
        .patch(`/api/v1/training-plans/sessions/${sesionId}/complete`)
        .set(auth())
        .send({})
        .expect(200);

      const res = await http()
        .post(`/api/v1/training-plans/${planId}/restart`)
        .set(auth())
        .send({})
        .expect(200);

      const { data } = res.body as Envelope<Plan>;
      expect(data.isActive).toBe(true);
      expect(data.completedSessions).toBe(0);
      expect(data.totalSessions).toBe(8);
      expect(await prisma.trainingPlanSession.count({ where: { id: sesionId } })).toBe(0);
    });

    it('borrar el plan lo borra de verdad', async () => {
      const creado = await crearPlan({ templateId: plantillaCortaId }).expect(201);
      const planId = (creado.body as Envelope<Plan>).data.id;

      await http().delete(`/api/v1/training-plans/${planId}`).set(auth()).expect(204);
      expect(await prisma.trainingPlan.count({ where: { id: planId } })).toBe(0);
    });

    it('sin plan activo, /me/current es 404 y /me viene vacio', async () => {
      const mios = await http().get('/api/v1/training-plans/me').set(auth()).expect(200);
      expect((mios.body as Envelope<{ active: Plan | null }>).data.active).toBeNull();

      await http().get('/api/v1/training-plans/me/current').set(auth()).expect(404);
    });

    it('lo del usuario exige token', async () => {
      await http().get('/api/v1/training-plans/me').expect(401);
      await http()
        .post('/api/v1/training-plans')
        .send({ templateId: plantillaCortaId })
        .expect(401);
    });
  });
});
