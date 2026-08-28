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

interface Registro {
  id: string;
  marathon: { id: string; slug: string; name: string };
  status: string;
  step: number;
  bibNumber: string | null;
  categoryId: string | null;
  extras: { extraId: string; name: string; quantity: number; priceCents: number }[];
  items: { type: string; refId: string | null; amountCents: number }[];
  subtotalCents: number;
  serviceFee: { label: string; amountCents: number } | null;
  totalCents: number;
  termsAcceptedAt: string | null;
  registeredAt: string | null;
  cancelledAt: string | null;
}

interface Checkout {
  payment: { id: string; status: string; amountCents: number };
  registration: Registro;
}

const enDias = (dias: number) => new Date(Date.now() + dias * 86_400_000);

/** Tarjeta que el mock aprueba siempre. El paso 3 se prueba en payments.e2e-spec.ts. */
const TARJETA_OK = {
  number: '4242424242424242',
  holder: 'ALVARO QUISPE',
  expMonth: 12,
  expYear: 2030,
  cvv: '123',
};

const DATOS = {
  fullName: 'Alvaro Quispe',
  docId: '1234567 LP',
  phone: '+591 70000000',
  // Las dos preguntas del CAM son obligatorias en el alta: sin ellas el paso 1
  // responde 400 y ningun test de este archivo llega a su assert.
  knowsCam: true,
  acceptsDonorCall: false,
  emergencyContactName: 'Maria Quispe',
  emergencyContactPhone: '+591 70000001',
};

/**
 * Flujo de inscripcion de tres pasos contra Postgres real.
 *
 * Lo que mas importa aqui es la seccion de cupos: que dos personas peleando el
 * ultimo lugar no entren las dos, y que cancelar devuelva lo que tomo.
 */
describe('Registrations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `rtest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let userId = '';
  let tokenOtro = '';

  let marathonId = '';
  let categoriaId = '';
  let otraCategoriaId = '';
  let extraId = '';
  let extraLimitadoId = '';
  let sinCategoriasId = '';
  let cerradaId = '';

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

  /** Crea el borrador del paso 1 para el usuario principal. */
  const crearBorrador = (id = marathonId, t = token) =>
    http().post('/api/v1/registrations').set(auth(t)).send({ marathonId: id, personalData: DATOS });

  /**
   * Paga y confirma. El paso 3 se prueba a fondo en `payments.e2e-spec.ts`;
   * aca solo hace falta para llegar a una inscripcion confirmada.
   */
  let secuencia = 0;
  const confirmar = (regId: string, t = token) =>
    http()
      .post(`/api/v1/registrations/${regId}/checkout`)
      .set(auth(t))
      .set('Idempotency-Key', `${marca}-${(secuencia += 1)}`)
      .send({ termsAccepted: true, method: 'card', card: TARJETA_OK });

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

    const maraton = await prisma.marathon.create({
      data: {
        slug: `${marca}-carrera`,
        name: 'Maraton La Paz Prueba',
        city: 'La Paz',
        startsAt: enDias(60),
        distanceMeters: 42_195,
        capacity: 100,
        priceCents: 20_000,
        publishedAt: new Date(),
        // TEMPORAL — sin texto de QR el checkout `qr_manual` responde
        // QR_NOT_CONFIGURED. Ver `docs/pago-qr-manual.md`.
        paymentQrPayload: 'PACEUP-COBRO|test',
        categories: {
          create: [
            { name: 'General', extraPriceCents: 0 },
            { name: 'Elite', extraPriceCents: 5_000 },
          ],
        },
        extras: {
          create: [
            { name: 'Remera', priceCents: 10_000, stock: null },
            { name: 'Transporte', priceCents: 3_000, stock: 2 },
          ],
        },
      },
      include: { categories: true, extras: true },
    });

    marathonId = maraton.id;
    categoriaId = maraton.categories.find((c) => c.name === 'General')!.id;
    otraCategoriaId = maraton.categories.find((c) => c.name === 'Elite')!.id;
    extraId = maraton.extras.find((e) => e.name === 'Remera')!.id;
    extraLimitadoId = maraton.extras.find((e) => e.name === 'Transporte')!.id;

    const sinCategorias = await prisma.marathon.create({
      data: {
        slug: `${marca}-sin-categorias`,
        name: 'Nocturna Sucre Prueba',
        city: 'Sucre',
        startsAt: enDias(50),
        distanceMeters: 5_000,
        capacity: 100,
        priceCents: 8_000,
        publishedAt: new Date(),
      },
    });
    sinCategoriasId = sinCategorias.id;

    const cerrada = await prisma.marathon.create({
      data: {
        slug: `${marca}-cerrada`,
        name: 'Cerrada Prueba',
        city: 'La Paz',
        startsAt: enDias(40),
        distanceMeters: 10_000,
        capacity: 100,
        priceCents: 10_000,
        publishedAt: new Date(),
        registrationStatus: 'closed',
      },
    });
    cerradaId = cerrada.id;
  });

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { marathon: { slug: { startsWith: marca } } } });
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  /** Deja al usuario principal sin inscripciones y la maraton con el cupo intacto. */
  async function limpiarInscripciones(): Promise<void> {
    await prisma.registration.deleteMany({ where: { marathon: { slug: { startsWith: marca } } } });
    await prisma.marathon.updateMany({
      where: { slug: { startsWith: marca } },
      data: { slotsTaken: 0 },
    });
    await prisma.marathonExtra.updateMany({ where: { id: extraLimitadoId }, data: { stock: 2 } });
  }

  // ─── Paso 1 ──────────────────────────────────────────────────────────────

  describe('paso 1: POST /registrations', () => {
    afterEach(limpiarInscripciones);

    it('exige token', async () => {
      await http()
        .post('/api/v1/registrations')
        .send({ marathonId, personalData: DATOS })
        .expect(401);
    });

    it('crea el borrador en el paso 1, ya cotizado', async () => {
      const res = await crearBorrador().expect(201);
      const { data } = res.body as Envelope<Registro>;

      expect(data.status).toBe('draft');
      expect(data.step).toBe(1);
      expect(data.bibNumber).toBeNull();
      expect(data.subtotalCents).toBe(20_000);
      expect(data.totalCents).toBe(20_000);
    });

    it('volver a empezar devuelve el mismo borrador, no crea otro', async () => {
      const primera = await crearBorrador().expect(201);
      const segunda = await crearBorrador().expect(201);

      expect((segunda.body as Envelope<Registro>).data.id).toBe(
        (primera.body as Envelope<Registro>).data.id,
      );

      const cuantas = await prisma.registration.count({ where: { userId, marathonId } });
      expect(cuantas).toBe(1);
    });

    it('rechaza datos personales incompletos', async () => {
      const res = await http()
        .post('/api/v1/registrations')
        .set(auth())
        .send({ marathonId, personalData: { fullName: 'Solo el nombre' } })
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('no deja inscribirse en una maraton con inscripciones cerradas', async () => {
      const res = await crearBorrador(cerradaId).expect(409);
      expect((res.body as ErrorBody).error.code).toBe('REGISTRATION_CLOSED');
    });

    it('404 si la maraton no existe', async () => {
      const res = await crearBorrador('no-existe').expect(404);
      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });
  });

  // ─── Paso 2 ──────────────────────────────────────────────────────────────

  describe('paso 2: PATCH /registrations/:id/category-extras', () => {
    let id = '';

    beforeEach(async () => {
      await limpiarInscripciones();
      const res = await crearBorrador().expect(201);
      id = (res.body as Envelope<Registro>).data.id;
    });

    afterAll(limpiarInscripciones);

    const paso2 = (body: object) =>
      http().patch(`/api/v1/registrations/${id}/category-extras`).set(auth()).send(body);

    it('suma categoria y extras al total y avanza al paso 2', async () => {
      const res = await paso2({
        categoryId: otraCategoriaId,
        extras: [{ extraId, quantity: 2 }],
      }).expect(200);

      const { data } = res.body as Envelope<Registro>;
      expect(data.step).toBe(2);
      expect(data.categoryId).toBe(otraCategoriaId);
      expect(data.subtotalCents).toBe(45_000); // 20000 + 5000 + 2*10000
    });

    it('la lista de extras reemplaza, no suma', async () => {
      await paso2({ extras: [{ extraId, quantity: 2 }] }).expect(200);
      const res = await paso2({ extras: [] }).expect(200);

      expect((res.body as Envelope<Registro>).data.subtotalCents).toBe(20_000);
    });

    it('deja quitar la categoria con null', async () => {
      await paso2({ categoryId: otraCategoriaId }).expect(200);
      const res = await paso2({ categoryId: null }).expect(200);

      expect((res.body as Envelope<Registro>).data.categoryId).toBeNull();
    });

    it('rechaza una categoria de otra maraton', async () => {
      const otra = await prisma.marathonCategory.create({
        data: { marathonId: sinCategoriasId, name: 'Ajena' },
      });

      const res = await paso2({ categoryId: otra.id }).expect(400);
      expect((res.body as ErrorBody).error.code).toBe('INVALID_CATEGORY');

      await prisma.marathonCategory.delete({ where: { id: otra.id } });
    });

    it('avisa si se piden mas unidades de las que quedan', async () => {
      const res = await paso2({ extras: [{ extraId: extraLimitadoId, quantity: 3 }] }).expect(409);
      expect((res.body as ErrorBody).error.code).toBe('EXTRA_OUT_OF_STOCK');
    });

    it('el quote en vivo coincide con el total de la inscripcion', async () => {
      await paso2({ categoryId: otraCategoriaId, extras: [{ extraId, quantity: 1 }] }).expect(200);

      const res = await http().get(`/api/v1/registrations/${id}/quote`).set(auth()).expect(200);
      const quote = (res.body as Envelope<{ totalCents: number; items: unknown[] }>).data;

      expect(quote.totalCents).toBe(35_000);
      expect(quote.items).toHaveLength(3);
    });

    it('un borrador se recotiza con los precios de hoy', async () => {
      await prisma.marathon.update({ where: { id: marathonId }, data: { priceCents: 30_000 } });

      const res = await http().get(`/api/v1/registrations/${id}`).set(auth()).expect(200);
      expect((res.body as Envelope<Registro>).data.subtotalCents).toBe(30_000);

      await prisma.marathon.update({ where: { id: marathonId }, data: { priceCents: 20_000 } });
    });

    it('no deja tocar la inscripcion de otro', async () => {
      const res = await http()
        .patch(`/api/v1/registrations/${id}/category-extras`)
        .set(auth(tokenOtro))
        .send({ categoryId: categoriaId })
        .expect(404);

      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });
  });

  // ─── Cancelacion ─────────────────────────────────────────────────────────

  describe('DELETE /registrations/:id', () => {
    let id = '';

    beforeEach(async () => {
      await limpiarInscripciones();
      const res = await crearBorrador().expect(201);
      id = (res.body as Envelope<Registro>).data.id;
      await http()
        .patch(`/api/v1/registrations/${id}/category-extras`)
        .set(auth())
        .send({ categoryId: categoriaId, extras: [{ extraId: extraLimitadoId, quantity: 1 }] })
        .expect(200);
      await confirmar(id).expect(200);
    });

    afterAll(limpiarInscripciones);

    it('libera el cupo y devuelve el stock', async () => {
      const res = await http().delete(`/api/v1/registrations/${id}`).set(auth()).expect(200);
      const { data } = res.body as Envelope<Registro>;

      expect(data.status).toBe('cancelled');
      expect(data.cancelledAt).not.toBeNull();

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);

      const extra = await prisma.marathonExtra.findUnique({ where: { id: extraLimitadoId } });
      expect(extra?.stock).toBe(2);
    });

    it('conserva el dorsal, y el siguiente correlativo no lo reutiliza', async () => {
      const antes = await http().get(`/api/v1/registrations/${id}`).set(auth()).expect(200);
      const dorsal = (antes.body as Envelope<Registro>).data.bibNumber;

      await http().delete(`/api/v1/registrations/${id}`).set(auth()).expect(200);

      const despues = await http().get(`/api/v1/registrations/${id}`).set(auth()).expect(200);
      expect((despues.body as Envelope<Registro>).data.bibNumber).toBe(dorsal);

      // El siguiente que se inscribe recibe el 0002, no el 0001 liberado.
      const otro = await crearBorrador(marathonId, tokenOtro).expect(201);
      const otroId = (otro.body as Envelope<Registro>).data.id;
      await http()
        .patch(`/api/v1/registrations/${otroId}/category-extras`)
        .set(auth(tokenOtro))
        .send({ categoryId: categoriaId })
        .expect(200);
      const nueva = await confirmar(otroId, tokenOtro).expect(200);

      expect((nueva.body as Envelope<Checkout>).data.registration.bibNumber).toBe('MLP-0002');
    });

    it('es idempotente', async () => {
      await http().delete(`/api/v1/registrations/${id}`).set(auth()).expect(200);
      await http().delete(`/api/v1/registrations/${id}`).set(auth()).expect(200);

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);
    });

    it('cancelar cierra el cobro por QR que quedo abierto', async () => {
      // Otra inscripcion, esta pagando por QR: queda `pending_payment` con un
      // cobro vivo, que es el caso que importa.
      await limpiarInscripciones();
      const borrador = await crearBorrador(marathonId, tokenOtro).expect(201);
      const regId = (borrador.body as Envelope<Registro>).data.id;

      await http()
        .patch(`/api/v1/registrations/${regId}/category-extras`)
        .set(auth(tokenOtro))
        .send({ categoryId: categoriaId })
        .expect(200);

      const cobro = await http()
        .post(`/api/v1/registrations/${regId}/checkout`)
        .set(auth(tokenOtro))
        .set('Idempotency-Key', `${marca}-qr-${(secuencia += 1)}`)
        .send({ termsAccepted: true, method: 'qr_manual' })
        .expect(200);

      const pagoId = (cobro.body as Envelope<Checkout>).data.payment.id;
      expect((cobro.body as Envelope<Checkout>).data.payment.status).toBe('pending');

      await http().delete(`/api/v1/registrations/${regId}`).set(auth(tokenOtro)).expect(200);

      // Sin esto el cobro sigue `pending`: el corredor podria subir un
      // comprobante y un organizador aprobarlo, y aprobar reserva cupo y emite
      // dorsal — la inscripcion cancelada volveria sola a confirmada.
      const pago = await prisma.payment.findUnique({ where: { id: pagoId } });
      expect(pago?.status).toBe('failed');
      expect(pago?.failureReason).toBe('cancelled_by_user');

      // Y el camino que eso cierra, comprobado de verdad y no por deduccion.
      await http()
        .post(`/api/v1/payments/${pagoId}/proof`)
        .set(auth(tokenOtro))
        .attach('file', Buffer.from('no importa el contenido'), 'captura.jpg')
        .expect(409);
    });

    it('cancelar libera el bloqueo para volver a inscribirse', async () => {
      await http().delete(`/api/v1/registrations/${id}`).set(auth()).expect(200);

      await crearBorrador().expect(201);
    });

    it('no se puede cancelar una carrera que ya ocurrio', async () => {
      await prisma.marathon.update({
        where: { id: marathonId },
        data: { startsAt: enDias(-1) },
      });

      const res = await http().delete(`/api/v1/registrations/${id}`).set(auth()).expect(409);
      expect((res.body as ErrorBody).error.code).toBe('CANCELLATION_NOT_ALLOWED');

      await prisma.marathon.update({ where: { id: marathonId }, data: { startsAt: enDias(60) } });
    });

    it('no deja cancelar la inscripcion de otro', async () => {
      await http().delete(`/api/v1/registrations/${id}`).set(auth(tokenOtro)).expect(404);
    });
  });

  // ─── Listado ─────────────────────────────────────────────────────────────

  describe('GET /registrations', () => {
    afterAll(limpiarInscripciones);

    it('solo devuelve las propias, y filtra por maraton para retomar el borrador', async () => {
      await limpiarInscripciones();
      await crearBorrador().expect(201);
      await crearBorrador(sinCategoriasId).expect(201);

      const todas = await http().get('/api/v1/registrations').set(auth()).expect(200);
      expect((todas.body as Envelope<Registro[]>).data).toHaveLength(2);

      const filtrada = await http()
        .get(`/api/v1/registrations?marathonId=${marca}-sin-categorias`)
        .set(auth())
        .expect(200);
      const { data } = filtrada.body as Envelope<Registro[]>;
      expect(data).toHaveLength(1);
      expect(data[0]?.marathon.slug).toBe(`${marca}-sin-categorias`);

      const delOtro = await http().get('/api/v1/registrations').set(auth(tokenOtro)).expect(200);
      expect((delOtro.body as Envelope<Registro[]>).data).toHaveLength(0);
    });
  });
});
