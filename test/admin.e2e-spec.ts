import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
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

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Panel de administración, contra Postgres real.
 *
 * Lo que importa: que un corredor normal no toque nada, que las acciones no
 * reimplementen reglas de otros módulos (confirmar una transferencia emite
 * dorsal) y que el CSV salga escapado y como archivo.
 */
describe('Admin (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `adtest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let adminToken = '';
  let runnerToken = '';
  let runnerId = '';
  let marathonId = '';
  let feeGlobalPrevio: { id: string; enabled: boolean } | null = null;

  const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

  async function registrar(sufijo: string): Promise<{ token: string; id: string }> {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `${marca}-${sufijo}@test.com`,
        password: 'Test1234!',
        name: `Usuario ${sufijo}`,
        deviceId: `${marca}-${sufijo}`,
      })
      .expect(201);

    const { data } = res.body as Envelope<{ accessToken: string; user: { id: string } }>;
    return { token: data.accessToken, id: data.user.id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'ready', { path: 'admin', method: RequestMethod.GET }],
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    const runner = await registrar('runner');
    runnerToken = runner.token;
    runnerId = runner.id;

    // El rol se asciende en la base: no hay —ni debe haber— un endpoint que
    // convierta a alguien en admin.
    const admin = await registrar('admin');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'admin' } });
    const entrada = await http()
      .post('/api/v1/auth/login')
      .send({
        email: `${marca}-admin@test.com`,
        password: 'Test1234!',
        deviceId: `${marca}-admin`,
      })
      .expect(200);

    adminToken = (entrada.body as Envelope<{ accessToken: string }>).data.accessToken;

    marathonId = (
      await prisma.marathon.create({
        data: {
          slug: `${marca}-maraton`,
          name: 'Maraton del panel',
          city: 'Cochabamba',
          // En el futuro: confirmar una inscripcion de una carrera ya corrida
          // esta prohibido, y con razon.
          startsAt: new Date(Date.now() + 30 * DIA_MS),
          distanceMeters: 21_097,
          capacity: 100,
          priceCents: 20_000,
        },
      })
    ).id;

    feeGlobalPrevio = await prisma.serviceFeeConfig.findFirst({ where: { scope: 'global' } });
  });

  afterAll(async () => {
    await prisma.raceCheckpoint.deleteMany({
      where: { raceResult: { registration: { marathonId } } },
    });
    await prisma.raceResult.deleteMany({ where: { registration: { marathonId } } });
    await prisma.payment.deleteMany({ where: { registration: { marathonId } } });
    await prisma.registration.deleteMany({ where: { marathonId } });
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.serviceFeeConfig.deleteMany({
      where: { scope: 'marathon', marathons: { none: {} }, label: { startsWith: marca } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  afterEach(async () => {
    await prisma.payment.deleteMany({ where: { registration: { marathonId } } });
    await prisma.raceCheckpoint.deleteMany({
      where: { raceResult: { registration: { marathonId } } },
    });
    await prisma.raceResult.deleteMany({ where: { registration: { marathonId } } });
    await prisma.registration.deleteMany({ where: { marathonId } });

    // La maratón vuelve a su estado de partida: cada test la deja como quiere.
    await prisma.marathon.update({
      where: { id: marathonId },
      data: {
        publishedAt: null,
        registrationStatus: 'open',
        slotsTaken: 0,
        serviceFeeConfigId: null,
      },
    });
  });

  /** Inscripción con un pago por transferencia esperando confirmación. */
  async function conTransferenciaPendiente(): Promise<{
    registrationId: string;
    paymentId: string;
  }> {
    const registro = await prisma.registration.create({
      data: {
        userId: runnerId,
        marathonId,
        status: 'pending_payment',
        step: 3,
        personalData: { fullName: 'Ana, "La Rápida"', docId: '=1234567', phone: '77712345' },
        subtotalCents: 20_000,
        totalCents: 20_000,
        termsAcceptedAt: new Date(),
      },
    });

    const pago = await prisma.payment.create({
      data: {
        registrationId: registro.id,
        method: 'bank_transfer',
        status: 'pending',
        amountCents: 20_000,
        idempotencyKey: `${marca}-${registro.id}`,
      },
    });

    return { registrationId: registro.id, paymentId: pago.id };
  }

  // ─────────────────────────────────────────────────────────────────────────

  describe('acceso', () => {
    it('un corredor normal no entra en el panel', async () => {
      const res = await http().get('/api/v1/admin/marathons').set(auth(runnerToken)).expect(403);

      expect((res.body as ErrorBody).error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('sin token tampoco', async () => {
      await http().get('/api/v1/admin/marathons').expect(401);
    });

    it('la página del panel es pública, pero no lleva datos dentro', async () => {
      const res = await http().get('/admin').expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('PaceUp');
      // Lo que se sirve es el formulario; los datos llegan luego, con token.
      expect(res.text).toContain('Entrar como administrador');
    });
  });

  describe('maratones', () => {
    it('lista también las no publicadas, con estado declarado y resuelto', async () => {
      const res = await http().get('/api/v1/admin/marathons').set(auth()).expect(200);
      const { data } = res.body as Envelope<
        { id: string; published: boolean; intent: string; resolved: string }[]
      >;

      const mia = data.find((m) => m.id === marathonId);
      expect(mia).toBeDefined();
      expect(mia!.published).toBe(false);
      expect(mia!.intent).toBe('open');
      expect(mia!.resolved).toBe('open');
    });

    it('publica y despublica sin tocar las inscripciones', async () => {
      const { registrationId } = await conTransferenciaPendiente();

      await http().post(`/api/v1/admin/marathons/${marathonId}/publish`).set(auth()).expect(200);
      let fila = await prisma.marathon.findUniqueOrThrow({ where: { id: marathonId } });
      expect(fila.publishedAt).not.toBeNull();

      await http().post(`/api/v1/admin/marathons/${marathonId}/unpublish`).set(auth()).expect(200);
      fila = await prisma.marathon.findUniqueOrThrow({ where: { id: marathonId } });
      expect(fila.publishedAt).toBeNull();

      // La inscripción sigue ahí: despublicar no cancela nada.
      expect(await prisma.registration.count({ where: { id: registrationId } })).toBe(1);
    });

    it('cerrar inscripciones guarda la intención y devuelve el estado resuelto', async () => {
      const res = await http()
        .post(`/api/v1/admin/marathons/${marathonId}/close-registrations`)
        .set(auth())
        .expect(200);

      const { data } = res.body as Envelope<{ intent: string; resolved: string }>;
      expect(data.intent).toBe('closed');
      expect(data.resolved).toBe('closed');

      const reabierta = await http()
        .post(`/api/v1/admin/marathons/${marathonId}/reopen-registrations`)
        .set(auth())
        .expect(200);

      expect((reabierta.body as Envelope<{ intent: string }>).data.intent).toBe('open');
    });
  });

  describe('exportacion a CSV', () => {
    it('sale como archivo, con BOM y con las celdas escapadas', async () => {
      await conTransferenciaPendiente();

      const res = await http()
        .get(`/api/v1/admin/marathons/${marathonId}/registrants.csv`)
        .set(auth())
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text.startsWith('\ufeff')).toBe(true);
      expect(res.text).toContain('Dorsal,Nombre,Documento');

      // La coma y las comillas del nombre no parten la fila...
      expect(res.text).toContain('"Ana, ""La Rápida"""');
      // ...y el documento que empieza por `=` no se ejecuta al abrirlo.
      expect(res.text).toContain("'=1234567");
    });
  });

  describe('cargo por servicio', () => {
    it('la vista previa usa la misma cuenta que el cobro real', async () => {
      await http()
        .put('/api/v1/admin/service-fee')
        .set(auth())
        .send({ enabled: true, type: 'percent', percentBps: 1000, minCents: 500 })
        .expect(200);

      const res = await http()
        .get('/api/v1/admin/service-fee/preview?subtotalCents=20000')
        .set(auth())
        .expect(200);

      const { data } = res.body as Envelope<{
        serviceFeeCents: number | null;
        totalCents: number;
        source: string;
      }>;

      expect(data.serviceFeeCents).toBe(2000);
      expect(data.totalCents).toBe(22_000);
      expect(data.source).toBe('global');
    });

    it('apagado, el cargo viaja como ausencia y no como cero', async () => {
      await http()
        .put('/api/v1/admin/service-fee')
        .set(auth())
        .send({ enabled: false, type: 'percent', percentBps: 1000 })
        .expect(200);

      const res = await http().get('/api/v1/admin/service-fee/preview').set(auth()).expect(200);
      const { data } = res.body as Envelope<{ serviceFeeCents: number | null; totalCents: number }>;

      expect(data.serviceFeeCents).toBeNull();
      expect(data.totalCents).toBe(20_000);
    });

    it('el override de una maratón manda aunque venga apagado', async () => {
      await http()
        .put('/api/v1/admin/service-fee')
        .set(auth())
        .send({ enabled: true, type: 'percent', percentBps: 1000 })
        .expect(200);

      await http()
        .put(`/api/v1/admin/marathons/${marathonId}/service-fee`)
        .set(auth())
        .send({ enabled: false, type: 'percent', label: `${marca} exenta` })
        .expect(200);

      const res = await http()
        .get(`/api/v1/admin/service-fee/preview?marathonId=${marathonId}`)
        .set(auth())
        .expect(200);

      // Con el global activo, esta carrera sigue sin cobrar cargo.
      expect(
        (res.body as Envelope<{ serviceFeeCents: number | null }>).data.serviceFeeCents,
      ).toBeNull();

      await http()
        .delete(`/api/v1/admin/marathons/${marathonId}/service-fee`)
        .set(auth())
        .expect(200);

      const vuelta = await http()
        .get(`/api/v1/admin/service-fee/preview?marathonId=${marathonId}`)
        .set(auth())
        .expect(200);

      expect(
        (vuelta.body as Envelope<{ serviceFeeCents: number | null }>).data.serviceFeeCents,
      ).toBe(2000);
    });

    afterAll(async () => {
      // Se deja la config global como estaba: otras suites cotizan con ella.
      if (feeGlobalPrevio) {
        await prisma.serviceFeeConfig.update({
          where: { id: feeGlobalPrevio.id },
          data: { enabled: feeGlobalPrevio.enabled },
        });
      }
    });
  });

  describe('transferencias', () => {
    it('confirmar toma el cupo y emite el dorsal, como un cobro normal', async () => {
      const { registrationId, paymentId } = await conTransferenciaPendiente();

      const pendientes = await http()
        .get('/api/v1/admin/payments/pending-transfers')
        .set(auth())
        .expect(200);

      expect((pendientes.body as Envelope<{ id: string }[]>).data.map((p) => p.id)).toContain(
        paymentId,
      );

      await http()
        .post(`/api/v1/admin/payments/${paymentId}/confirm-transfer`)
        .set(auth())
        .send({ reference: 'BNB-88213' })
        .expect(200);

      const registro = await prisma.registration.findUniqueOrThrow({
        where: { id: registrationId },
      });
      const maraton = await prisma.marathon.findUniqueOrThrow({ where: { id: marathonId } });

      expect(registro.status).toBe('confirmed');
      expect(registro.bibNumber).not.toBeNull();
      expect(maraton.slotsTaken).toBe(1);
    });

    it('no se confirma dos veces', async () => {
      const { paymentId } = await conTransferenciaPendiente();

      await http()
        .post(`/api/v1/admin/payments/${paymentId}/confirm-transfer`)
        .set(auth())
        .send({})
        .expect(200);

      const segunda = await http()
        .post(`/api/v1/admin/payments/${paymentId}/confirm-transfer`)
        .set(auth())
        .send({})
        .expect(409);

      expect((segunda.body as ErrorBody).error.code).toBe('PAYMENT_ALREADY_SETTLED');
    });

    it('una tarjeta rechazada no se arregla declarándola pagada', async () => {
      const { registrationId } = await conTransferenciaPendiente();
      const tarjeta = await prisma.payment.create({
        data: {
          registrationId,
          method: 'card',
          status: 'pending',
          amountCents: 20_000,
          idempotencyKey: `${marca}-card-${registrationId}`,
        },
      });

      const res = await http()
        .post(`/api/v1/admin/payments/${tarjeta.id}/confirm-transfer`)
        .set(auth())
        .send({})
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('PAYMENT_METHOD_NOT_SUPPORTED');
    });
  });

  describe('resultados', () => {
    /** Dos inscripciones confirmadas con dorsal, listas para recibir tiempos. */
    async function dosInscritos() {
      for (const bib of ['P-001', 'P-002']) {
        await prisma.registration.create({
          data: {
            userId: runnerId,
            marathonId,
            status: 'confirmed',
            step: 3,
            bibNumber: bib,
            totalCents: 20_000,
            registeredAt: new Date(),
          },
        });
      }
    }

    it('carga por dorsal, recalcula puestos y avisa de los desconocidos', async () => {
      await dosInscritos();

      const res = await http()
        .post(`/api/v1/admin/marathons/${marathonId}/results`)
        .set(auth())
        .send({
          results: [
            { bibNumber: 'P-002', finishTimeSeconds: 7200 },
            { bibNumber: 'P-001', finishTimeSeconds: 6900, chipTimeSeconds: 6880 },
            { bibNumber: 'NO-EXISTE', finishTimeSeconds: 6000 },
          ],
        })
        .expect(200);

      const { data } = res.body as Envelope<{
        imported: number;
        skipped: number;
        unknownBibs: string[];
      }>;

      expect(data.imported).toBe(2);
      expect(data.skipped).toBe(1);
      expect(data.unknownBibs).toEqual(['NO-EXISTE']);

      const puestos = await prisma.raceResult.findMany({
        where: { registration: { marathonId } },
        orderBy: { overallRank: 'asc' },
        select: { overallRank: true, registration: { select: { bibNumber: true } } },
      });

      expect(puestos.map((p) => p.registration.bibNumber)).toEqual(['P-001', 'P-002']);
      expect(puestos.map((p) => p.overallRank)).toEqual([1, 2]);
    });

    it('reimportar el mismo archivo no duplica ni cambia nada', async () => {
      await dosInscritos();
      const cuerpo = { results: [{ bibNumber: 'P-001', finishTimeSeconds: 6900 }] };

      await http()
        .post(`/api/v1/admin/marathons/${marathonId}/results`)
        .set(auth())
        .send(cuerpo)
        .expect(200);
      await http()
        .post(`/api/v1/admin/marathons/${marathonId}/results`)
        .set(auth())
        .send(cuerpo)
        .expect(200);

      expect(await prisma.raceResult.count({ where: { registration: { marathonId } } })).toBe(1);
    });
  });

  describe('usuarios', () => {
    it('no devuelve nada sensible', async () => {
      const res = await http().get(`/api/v1/admin/users?q=${marca}-runner`).set(auth()).expect(200);

      const { data } = res.body as Envelope<Record<string, unknown>[]>;

      expect(data).toHaveLength(1);
      expect(Object.keys(data[0]!).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'name',
        'registrations',
        'role',
        'verified',
        'workouts',
      ]);
      expect(JSON.stringify(data)).not.toContain('passwordHash');
    });
  });
});
