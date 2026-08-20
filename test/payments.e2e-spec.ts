import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { CABECERA_DE_FIRMA, firmar } from '../src/modules/payments/webhook/signature';

/** El mismo que fija `setup-env.ts`. */
const SECRETO_WEBHOOK = 'secreto-de-webhook-para-los-tests-e2e';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}
interface ErrorBody {
  error: { code: string; message: string; details: { paymentId?: string; reason?: string }[] };
}

interface Registro {
  id: string;
  status: string;
  step: number;
  bibNumber: string | null;
  items: { type: string; refId: string | null; amountCents: number }[];
  totalCents: number;
  termsAcceptedAt: string | null;
  registeredAt: string | null;
}

interface Pago {
  id: string;
  registrationId: string;
  method: string;
  status: string;
  amountCents: number;
  currency: string;
  methodDetails: {
    brand?: string;
    last4?: string;
    holder?: string;
    qr?: { imageUrl: string; payload: string };
    bank?: {
      bankName: string;
      accountNumber: string;
      accountType: string;
      holder: string;
      nit: string;
      reference: string;
    };
  };
  failureReason: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  refundedAt: string | null;
}

interface Checkout {
  payment: Pago;
  registration: Registro;
}

const enDias = (dias: number) => new Date(Date.now() + dias * 86_400_000);

const DATOS = {
  fullName: 'Alvaro Quispe',
  docId: '1234567 LP',
  phone: '+591 70000000',
};

const tarjeta = (number: string) => ({
  number,
  holder: 'ALVARO QUISPE',
  expMonth: 12,
  expYear: 2030,
  cvv: '123',
});

const APRUEBA = tarjeta('4242424242424242');
const RECHAZA = tarjeta('4000000000000002');
const VENCIDA = tarjeta('4000000000000069');

/**
 * Paso 3 completo contra Postgres real: cobro, confirmacion, dorsal y cupo.
 *
 * Lo que mas importa aqui son tres cosas: que nadie pague dos veces por tocar
 * "pagar" dos veces (idempotencia), que un rechazo no consuma cupo ni dorsal, y
 * que dos personas peleando el ultimo lugar no entren las dos.
 */
describe('Payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `ptest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let tokenOtro = '';

  let marathonId = '';
  let categoriaId = '';
  let extraLimitadoId = '';
  let sinCategoriasId = '';

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  let secuencia = 0;
  const nuevaClave = () => `${marca}-key-${(secuencia += 1)}`;

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

  /** Deja una inscripcion en el paso 2, lista para cobrar. */
  async function borradorListo(t = token, maraton = marathonId): Promise<string> {
    const res = await http()
      .post('/api/v1/registrations')
      .set(auth(t))
      .send({ marathonId: maraton, personalData: DATOS })
      .expect(201);

    const id = (res.body as Envelope<Registro>).data.id;

    if (maraton === marathonId) {
      await http()
        .patch(`/api/v1/registrations/${id}/category-extras`)
        .set(auth(t))
        .send({ categoryId: categoriaId })
        .expect(200);
    }

    return id;
  }

  const checkout = (
    regId: string,
    opciones: { t?: string; card?: unknown; method?: string; clave?: string } = {},
  ) => {
    const peticion = http()
      .post(`/api/v1/registrations/${regId}/checkout`)
      .set(auth(opciones.t ?? token));

    const clave = opciones.clave ?? nuevaClave();
    if (clave) peticion.set('Idempotency-Key', clave);

    return peticion.send({
      termsAccepted: true,
      method: opciones.method ?? 'card',
      ...(opciones.card === null ? {} : { card: opciones.card ?? APRUEBA }),
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // `rawBody` igual que en `bootstrap()`: sin el, la firma del webhook se
    // verificaria contra un cuerpo reserializado y nunca cuadraria.
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    token = await registrarUsuario('uno');
    tokenOtro = await registrarUsuario('dos');

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
        categories: { create: [{ name: 'General', extraPriceCents: 0 }] },
        extras: { create: [{ name: 'Transporte', priceCents: 3_000, stock: 2 }] },
      },
      include: { categories: true, extras: true },
    });

    marathonId = maraton.id;
    categoriaId = maraton.categories[0]!.id;
    extraLimitadoId = maraton.extras[0]!.id;

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
  });

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { marathon: { slug: { startsWith: marca } } } });
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  async function limpiar(): Promise<void> {
    await prisma.registration.deleteMany({ where: { marathon: { slug: { startsWith: marca } } } });
    await prisma.marathon.updateMany({
      where: { slug: { startsWith: marca } },
      data: { slotsTaken: 0, capacity: 100 },
    });
    await prisma.marathonExtra.updateMany({ where: { id: extraLimitadoId }, data: { stock: 2 } });
  }

  // ─── Cobro con tarjeta ───────────────────────────────────────────────────

  describe('POST /registrations/:id/checkout con tarjeta', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    it('exige token', async () => {
      await http()
        .post('/api/v1/registrations/cualquiera/checkout')
        .set('Idempotency-Key', nuevaClave())
        .send({ termsAccepted: true, method: 'card', card: APRUEBA })
        .expect(401);
    });

    it('cobra, confirma, asigna dorsal y toma el cupo', async () => {
      const id = await borradorListo();
      const res = await checkout(id).expect(200);
      const { payment, registration } = (res.body as Envelope<Checkout>).data;

      expect(payment.status).toBe('paid');
      expect(payment.method).toBe('card');
      expect(payment.amountCents).toBe(20_000);
      expect(payment.currency).toBe('BOB');
      expect(payment.paidAt).not.toBeNull();

      expect(registration.status).toBe('confirmed');
      expect(registration.step).toBe(3);
      expect(registration.bibNumber).toMatch(/^MLP-\d{4}$/);
      expect(registration.registeredAt).not.toBeNull();
      expect(registration.termsAcceptedAt).not.toBeNull();

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);
    });

    it('del numero de tarjeta solo sobreviven marca y ultimos cuatro', async () => {
      const id = await borradorListo();
      const res = await checkout(id).expect(200);
      const { payment } = (res.body as Envelope<Checkout>).data;

      expect(payment.methodDetails).toEqual({
        brand: 'visa',
        last4: '4242',
        holder: 'ALVARO QUISPE',
      });

      // Y tampoco esta en la base, por si a alguien se le ocurriera guardarlo.
      const fila = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(JSON.stringify(fila)).not.toContain('4242424242424242');
    });

    it('la 4000...0002 se rechaza con card_declined y no consume cupo', async () => {
      const id = await borradorListo();
      const res = await checkout(id, { card: RECHAZA }).expect(402);
      const { error } = res.body as ErrorBody;

      expect(error.code).toBe('PAYMENT_DECLINED');
      expect(error.details[0]?.reason).toBe('card_declined');

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);

      // Queda en pending_payment, sin dorsal, y se puede reintentar.
      const detalle = await http().get(`/api/v1/registrations/${id}`).set(auth()).expect(200);
      const registro = (detalle.body as Envelope<Registro>).data;
      expect(registro.status).toBe('pending_payment');
      expect(registro.bibNumber).toBeNull();
    });

    it('la 4000...0069 responde expired_card', async () => {
      const id = await borradorListo();
      const res = await checkout(id, { card: VENCIDA }).expect(402);

      expect((res.body as ErrorBody).error.details[0]?.reason).toBe('expired_card');
    });

    it('un rechazo no impide reintentar con otra tarjeta', async () => {
      const id = await borradorListo();
      await checkout(id, { card: RECHAZA }).expect(402);

      const res = await checkout(id).expect(200);
      expect((res.body as Envelope<Checkout>).data.registration.status).toBe('confirmed');
    });

    it('el rechazo queda en el historial de la inscripcion', async () => {
      const id = await borradorListo();
      await checkout(id, { card: RECHAZA }).expect(402);
      await checkout(id).expect(200);

      const res = await http().get(`/api/v1/registrations/${id}/payments`).set(auth()).expect(200);
      const pagos = (res.body as Envelope<Pago[]>).data;

      expect(pagos).toHaveLength(2);
      expect(pagos.map((p) => p.status).sort()).toEqual(['failed', 'paid']);
    });

    it('sin aceptar terminos no hay cobro', async () => {
      const id = await borradorListo();
      const res = await http()
        .post(`/api/v1/registrations/${id}/checkout`)
        .set(auth())
        .set('Idempotency-Key', nuevaClave())
        .send({ termsAccepted: false, method: 'card', card: APRUEBA })
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('exige categoria si la maraton tiene categorias', async () => {
      const id = await borradorListo();
      await http()
        .patch(`/api/v1/registrations/${id}/category-extras`)
        .set(auth())
        .send({ categoryId: null })
        .expect(200);

      const res = await checkout(id).expect(400);
      expect((res.body as ErrorBody).error.code).toBe('CATEGORY_REQUIRED');
    });

    it('no exige categoria si la maraton no tiene ninguna', async () => {
      const id = await borradorListo(token, sinCategoriasId);

      await checkout(id).expect(200);
    });

    it('descuenta el stock de los extras comprados', async () => {
      const id = await borradorListo();
      await http()
        .patch(`/api/v1/registrations/${id}/category-extras`)
        .set(auth())
        .send({ categoryId: categoriaId, extras: [{ extraId: extraLimitadoId, quantity: 2 }] })
        .expect(200);

      await checkout(id).expect(200);

      const extra = await prisma.marathonExtra.findUnique({ where: { id: extraLimitadoId } });
      expect(extra?.stock).toBe(0);
    });

    it('recalcula el precio al cobrar: no confia en lo que vio el cliente', async () => {
      const id = await borradorListo();
      await prisma.marathon.update({ where: { id: marathonId }, data: { priceCents: 33_000 } });

      const res = await checkout(id).expect(200);
      const { payment, registration } = (res.body as Envelope<Checkout>).data;

      expect(payment.amountCents).toBe(33_000);
      expect(registration.totalCents).toBe(33_000);

      await prisma.marathon.update({ where: { id: marathonId }, data: { priceCents: 20_000 } });
    });

    it('el total queda congelado: un cambio de precio posterior no lo mueve', async () => {
      const id = await borradorListo();
      const cobrado = (await checkout(id).expect(200)).body as Envelope<Checkout>;

      await prisma.marathon.update({ where: { id: marathonId }, data: { priceCents: 99_000 } });

      const res = await http().get(`/api/v1/registrations/${id}`).set(auth()).expect(200);
      const { data } = res.body as Envelope<Registro>;

      expect(data.totalCents).toBe(cobrado.data.payment.amountCents);
      expect(data.items[0]?.amountCents).toBe(20_000);

      await prisma.marathon.update({ where: { id: marathonId }, data: { priceCents: 20_000 } });
    });

    it('no cobra cuando ya no quedan cupos', async () => {
      const id = await borradorListo();
      await prisma.marathon.update({
        where: { id: marathonId },
        data: { capacity: 100, slotsTaken: 100 },
      });

      const res = await checkout(id).expect(409);
      expect((res.body as ErrorBody).error.code).toBe('MARATHON_FULL');

      // Y no se creo ningun cobro: nadie paga por una carrera llena.
      const pagos = await prisma.payment.count({ where: { registrationId: id } });
      expect(pagos).toBe(0);
    });

    it('no se puede volver a cobrar una inscripcion ya confirmada', async () => {
      const id = await borradorListo();
      await checkout(id).expect(200);

      const res = await checkout(id).expect(409);
      expect((res.body as ErrorBody).error.code).toBe('REGISTRATION_NOT_EDITABLE');
    });

    it('los dorsales son correlativos por maraton', async () => {
      const primero = await borradorListo();
      await checkout(primero).expect(200);

      const segundo = await borradorListo(tokenOtro);
      const res = await checkout(segundo, { t: tokenOtro }).expect(200);

      expect((res.body as Envelope<Checkout>).data.registration.bibNumber).toBe('MLP-0002');
    });
  });

  // ─── Idempotencia ────────────────────────────────────────────────────────

  describe('Idempotency-Key', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    it('sin la cabecera no se cobra', async () => {
      const id = await borradorListo();
      const res = await checkout(id, { clave: '' }).expect(400);

      expect((res.body as ErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('rechaza una clave demasiado corta para ser unica', async () => {
      const id = await borradorListo();
      const res = await checkout(id, { clave: 'corta' }).expect(400);

      expect((res.body as ErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('reintentar con la misma clave devuelve el mismo cobro sin cobrar dos veces', async () => {
      const id = await borradorListo();
      const clave = nuevaClave();

      const primera = await checkout(id, { clave }).expect(200);
      const segunda = await checkout(id, { clave }).expect(200);

      const uno = (primera.body as Envelope<Checkout>).data;
      const dos = (segunda.body as Envelope<Checkout>).data;

      expect(dos.payment.id).toBe(uno.payment.id);
      expect(dos.registration.bibNumber).toBe(uno.registration.bibNumber);

      // Un solo cobro, un solo cupo.
      const pagos = await prisma.payment.count({ where: { registrationId: id } });
      expect(pagos).toBe(1);

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);
    });

    it('reintentar un rechazo con la misma clave devuelve el mismo rechazo', async () => {
      const id = await borradorListo();
      const clave = nuevaClave();

      const primera = await checkout(id, { clave, card: RECHAZA }).expect(402);
      const segunda = await checkout(id, { clave, card: APRUEBA }).expect(402);

      // Cambiar de tarjeta reusando la clave NO reabre el cobro: para reintentar
      // hay que generar una clave nueva, que es lo que hace la app.
      expect((segunda.body as ErrorBody).error.details[0]?.paymentId).toBe(
        (primera.body as ErrorBody).error.details[0]?.paymentId,
      );

      const pagos = await prisma.payment.count({ where: { registrationId: id } });
      expect(pagos).toBe(1);
    });

    it('la misma clave para otra inscripcion es un conflicto', async () => {
      const primero = await borradorListo();
      const clave = nuevaClave();
      await checkout(primero, { clave }).expect(200);

      const segundo = await borradorListo(token, sinCategoriasId);
      const res = await checkout(segundo, { clave }).expect(409);

      expect((res.body as ErrorBody).error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('la clave de otro usuario no sirve para leer su cobro', async () => {
      const mio = await borradorListo();
      const clave = nuevaClave();
      await checkout(mio, { clave }).expect(200);

      const ajeno = await borradorListo(tokenOtro);
      const res = await checkout(ajeno, { clave, t: tokenOtro }).expect(409);

      expect((res.body as ErrorBody).error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });
  });

  // ─── Metodos todavia no disponibles ──────────────────────────────────────

  describe('metodos de pago', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    it('un metodo inventado no pasa la validacion del DTO', async () => {
      const id = await borradorListo();
      const res = await checkout(id, { method: 'efectivo', card: null }).expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('card sin datos de tarjeta no cobra', async () => {
      const id = await borradorListo();
      const res = await checkout(id, { card: null }).expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─── Autorizacion ────────────────────────────────────────────────────────

  describe('autorizacion por recurso', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    it('no se puede pagar la inscripcion de otro', async () => {
      const ajena = await borradorListo();

      const res = await checkout(ajena, { t: tokenOtro }).expect(404);
      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('no se puede leer el pago de otro', async () => {
      const mia = await borradorListo();
      const cobro = await checkout(mia).expect(200);
      const pagoId = (cobro.body as Envelope<Checkout>).data.payment.id;

      await http().get(`/api/v1/payments/${pagoId}`).set(auth()).expect(200);

      const res = await http().get(`/api/v1/payments/${pagoId}`).set(auth(tokenOtro)).expect(404);
      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('no se puede listar los pagos de una inscripcion ajena', async () => {
      const mia = await borradorListo();
      await checkout(mia).expect(200);

      await http().get(`/api/v1/registrations/${mia}/payments`).set(auth(tokenOtro)).expect(404);
    });
  });

  // ─── QR ──────────────────────────────────────────────────────────────────

  describe('metodo qr', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    /** Deja un cobro por QR abierto y devuelve el pago y la inscripcion. */
    async function abrirQr(t = token): Promise<{ pago: Pago; registrationId: string }> {
      const registrationId = await borradorListo(t);
      const res = await checkout(registrationId, { t, method: 'qr', card: null }).expect(200);

      return { pago: (res.body as Envelope<Checkout>).data.payment, registrationId };
    }

    it('devuelve un QR pendiente sin tomar el cupo', async () => {
      const { pago, registrationId } = await abrirQr();

      expect(pago.status).toBe('pending');
      expect(pago.method).toBe('qr');
      expect(pago.amountCents).toBe(20_000);
      expect(pago.paidAt).toBeNull();
      expect(pago.expiresAt).not.toBeNull();
      expect(pago.methodDetails.qr?.imageUrl).toMatch(/\.png$/);
      expect(pago.methodDetails.qr?.payload).toContain('PACEUP-QR');

      // La inscripcion espera: sin dorsal y sin cupo tomado.
      const detalle = await http()
        .get(`/api/v1/registrations/${registrationId}`)
        .set(auth())
        .expect(200);
      const registro = (detalle.body as Envelope<Registro>).data;
      expect(registro.status).toBe('pending_payment');
      expect(registro.bibNumber).toBeNull();

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);
    });

    it('el PNG del QR existe y es una imagen real', async () => {
      const { pago } = await abrirQr();

      // Se comprueba en disco y no por HTTP porque el estatico de `/uploads` lo
      // monta `bootstrap()`, que el modulo de test no ejecuta. Lo que importa
      // de este checkpoint es que el binario este donde dice la URL.
      const ruta = new URL(pago.methodDetails.qr!.imageUrl).pathname;
      const clave = ruta.replace(/^\/uploads\//, '');
      const archivo = join(resolve(process.env.UPLOADS_DIR ?? './uploads'), clave);

      const bytes = await readFile(archivo);

      // Firma PNG: los bytes 1..3 son "PNG". Si esto pasa es una imagen de
      // verdad y no un placeholder que la camara nunca podria enfocar.
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(bytes.byteLength).toBeGreaterThan(500);
    });

    it('el polling lo da por pagado y confirma la inscripcion', async () => {
      const { pago, registrationId } = await abrirQr();

      const res = await http().get(`/api/v1/payments/${pago.id}`).set(auth()).expect(200);
      const cobrado = (res.body as Envelope<Pago>).data;

      expect(cobrado.status).toBe('paid');
      expect(cobrado.paidAt).not.toBeNull();

      const detalle = await http()
        .get(`/api/v1/registrations/${registrationId}`)
        .set(auth())
        .expect(200);
      const registro = (detalle.body as Envelope<Registro>).data;
      expect(registro.status).toBe('confirmed');
      expect(registro.bibNumber).toMatch(/^MLP-\d{4}$/);

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);
    });

    it('sondear tres veces a la vez no emite tres dorsales', async () => {
      const { pago, registrationId } = await abrirQr();

      await Promise.all([
        http().get(`/api/v1/payments/${pago.id}`).set(auth()),
        http().get(`/api/v1/payments/${pago.id}`).set(auth()),
        http().get(`/api/v1/payments/${pago.id}`).set(auth()),
      ]);

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);

      const registro = await prisma.registration.findUniqueOrThrow({
        where: { id: registrationId },
      });
      expect(registro.bibNumber).toBe('MLP-0001');
    });

    it('todavia no toca: el QR sigue pendiente', async () => {
      const { pago } = await abrirQr();

      // El reloj del auto-confirmado cuenta desde `createdAt`. Empujarlo al
      // futuro es la forma de probar la rama "aun no" con el temporizador en 0.
      await prisma.payment.update({
        where: { id: pago.id },
        data: { createdAt: new Date(Date.now() + 60_000) },
      });

      const res = await http().get(`/api/v1/payments/${pago.id}`).set(auth()).expect(200);

      expect((res.body as Envelope<Pago>).data.status).toBe('pending');
    });

    it('un QR vencido queda failed con qr_expired y no toma cupo', async () => {
      const { pago, registrationId } = await abrirQr();

      await prisma.payment.update({
        where: { id: pago.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const res = await http().get(`/api/v1/payments/${pago.id}`).set(auth()).expect(200);
      const vencido = (res.body as Envelope<Pago>).data;

      expect(vencido.status).toBe('failed');
      expect(vencido.failureReason).toBe('qr_expired');

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);

      // Y se puede reintentar: la inscripcion sigue viva.
      const otro = await checkout(registrationId).expect(200);
      expect((otro.body as Envelope<Checkout>).data.registration.status).toBe('confirmed');
    });

    it('reintentar el checkout con la misma clave no emite un segundo QR', async () => {
      const registrationId = await borradorListo();
      const clave = nuevaClave();

      const uno = await checkout(registrationId, { method: 'qr', card: null, clave }).expect(200);
      const dos = await checkout(registrationId, { method: 'qr', card: null, clave }).expect(200);

      const a = (uno.body as Envelope<Checkout>).data.payment;
      const b = (dos.body as Envelope<Checkout>).data.payment;

      expect(b.id).toBe(a.id);
      expect(b.methodDetails.qr?.payload).toBe(a.methodDetails.qr?.payload);

      const pagos = await prisma.payment.count({ where: { registrationId } });
      expect(pagos).toBe(1);
    });
  });

  // ─── Transferencia bancaria ──────────────────────────────────────────────

  describe('metodo bank_transfer', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    async function abrirTransferencia(): Promise<{ pago: Pago; registrationId: string }> {
      const registrationId = await borradorListo();
      const res = await checkout(registrationId, {
        method: 'bank_transfer',
        card: null,
      }).expect(200);

      return { pago: (res.body as Envelope<Checkout>).data.payment, registrationId };
    }

    it('devuelve los datos bancarios y una glosa para identificar el deposito', async () => {
      const { pago } = await abrirTransferencia();

      expect(pago.status).toBe('pending');
      expect(pago.method).toBe('bank_transfer');
      expect(pago.methodDetails.bank).toEqual({
        bankName: expect.any(String) as string,
        accountNumber: expect.any(String) as string,
        accountType: expect.any(String) as string,
        holder: expect.any(String) as string,
        nit: expect.any(String) as string,
        reference: expect.stringMatching(/^PACEUP-[A-Z0-9]{8}$/) as string,
      });
    });

    it('no caduca ni se paga sola: espera a una persona', async () => {
      const { pago } = await abrirTransferencia();

      expect(pago.expiresAt).toBeNull();

      // Un banco puede tardar un dia habil. Sondear no la resuelve.
      const res = await http().get(`/api/v1/payments/${pago.id}`).set(auth()).expect(200);
      expect((res.body as Envelope<Pago>).data.status).toBe('pending');

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);
    });
  });

  // ─── Confirmacion forzada (solo desarrollo) ──────────────────────────────

  describe('POST /payments/:id/mock-confirm', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    it('cierra una transferencia pendiente y confirma la inscripcion', async () => {
      const registrationId = await borradorListo();
      const abierto = await checkout(registrationId, {
        method: 'bank_transfer',
        card: null,
      }).expect(200);
      const pagoId = (abierto.body as Envelope<Checkout>).data.payment.id;

      const res = await http()
        .post(`/api/v1/payments/${pagoId}/mock-confirm`)
        .set(auth())
        .expect(200);
      const { payment, registration } = (res.body as Envelope<Checkout>).data;

      expect(payment.status).toBe('paid');
      expect(registration.status).toBe('confirmed');
      expect(registration.bibNumber).toMatch(/^MLP-\d{4}$/);

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);
    });

    it('un cobro ya cerrado no se vuelve a confirmar', async () => {
      const registrationId = await borradorListo();
      const cobrado = await checkout(registrationId).expect(200);
      const pagoId = (cobrado.body as Envelope<Checkout>).data.payment.id;

      const res = await http()
        .post(`/api/v1/payments/${pagoId}/mock-confirm`)
        .set(auth())
        .expect(409);

      expect((res.body as ErrorBody).error.code).toBe('PAYMENT_ALREADY_SETTLED');
    });

    it('no sirve para confirmar el cobro de otro', async () => {
      const registrationId = await borradorListo();
      const abierto = await checkout(registrationId, {
        method: 'bank_transfer',
        card: null,
      }).expect(200);
      const pagoId = (abierto.body as Envelope<Checkout>).data.payment.id;

      await http().post(`/api/v1/payments/${pagoId}/mock-confirm`).set(auth(tokenOtro)).expect(404);
    });
  });

  // ─── Webhook del proveedor ───────────────────────────────────────────────

  describe('POST /payments/webhook', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    let contador = 0;

    const evento = (tipo: string, externalId: string, extra: Record<string, unknown> = {}) => ({
      id: `evt_${(contador += 1)}`,
      type: tipo,
      createdAt: new Date().toISOString(),
      data: { externalId, ...extra },
    });

    /** Manda el evento firmado como lo haria el proveedor. */
    const enviar = (cuerpo: unknown, opciones: { firma?: string; ahora?: Date } = {}) => {
      const crudo = JSON.stringify(cuerpo);

      return http()
        .post('/api/v1/payments/webhook')
        .set(CABECERA_DE_FIRMA, opciones.firma ?? firmar(crudo, SECRETO_WEBHOOK, opciones.ahora))
        .set('Content-Type', 'application/json')
        .send(crudo);
    };

    /** Deja un cobro por QR abierto, sin resolver, y devuelve sus ids. */
    async function qrPendiente(): Promise<{ pagoId: string; externalId: string; regId: string }> {
      const regId = await borradorListo();
      const res = await checkout(regId, { method: 'qr', card: null }).expect(200);
      const pagoId = (res.body as Envelope<Checkout>).data.payment.id;
      const fila = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });

      return { pagoId, externalId: fila.externalId!, regId };
    }

    it('con firma valida, payment.paid confirma la inscripcion', async () => {
      const { pagoId, externalId, regId } = await qrPendiente();

      const res = await enviar(evento('payment.paid', externalId)).expect(200);

      expect(res.body).toMatchObject({ data: { received: true, handled: true } });

      const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });
      expect(pago.status).toBe('paid');

      const registro = await prisma.registration.findUniqueOrThrow({ where: { id: regId } });
      expect(registro.status).toBe('confirmed');
      expect(registro.bibNumber).toMatch(/^MLP-\d{4}$/);

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);
    });

    it('sin cabecera de firma no se aplica nada', async () => {
      const { externalId } = await qrPendiente();

      const res = await http()
        .post('/api/v1/payments/webhook')
        .send(evento('payment.paid', externalId))
        .expect(401);

      expect((res.body as ErrorBody).error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('una firma hecha con otro secreto se rechaza', async () => {
      const { externalId } = await qrPendiente();
      const cuerpo = evento('payment.paid', externalId);

      const res = await enviar(cuerpo, {
        firma: firmar(JSON.stringify(cuerpo), 'no-es-el-secreto'),
      }).expect(401);

      expect((res.body as ErrorBody).error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('un webhook capturado y reenviado media hora despues se rechaza', async () => {
      const { externalId } = await qrPendiente();

      const res = await enviar(evento('payment.paid', externalId), {
        ahora: new Date(Date.now() - 30 * 60_000),
      }).expect(401);

      expect((res.body as ErrorBody).error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('manipular el cuerpo despues de firmar rompe la firma', async () => {
      const { externalId } = await qrPendiente();
      const original = evento('payment.paid', externalId);
      const firma = firmar(JSON.stringify(original), SECRETO_WEBHOOK);

      // Mismo evento, pero apuntando a otro cobro. La firma es la del original.
      const manipulado = { ...original, data: { externalId: 'mock_pi_de_otro' } };

      const res = await enviar(manipulado, { firma }).expect(401);
      expect((res.body as ErrorBody).error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('un cobro desconocido se acusa recibo pero no se aplica', async () => {
      // 200 y no 404: un proveedor que recibe un error reintenta para siempre.
      const res = await enviar(evento('payment.paid', 'mock_pi_inexistente')).expect(200);

      expect(res.body).toMatchObject({
        data: { received: true, handled: false, reason: 'unknown_payment' },
      });
    });

    it('reenviar el mismo pago no emite un segundo dorsal', async () => {
      const { externalId, regId } = await qrPendiente();

      await enviar(evento('payment.paid', externalId)).expect(200);
      const segunda = await enviar(evento('payment.paid', externalId)).expect(200);

      expect(segunda.body).toMatchObject({
        data: { received: true, handled: false, reason: 'already_settled' },
      });

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);

      const registro = await prisma.registration.findUniqueOrThrow({ where: { id: regId } });
      expect(registro.bibNumber).toBe('MLP-0001');
    });

    it('payment.failed cierra el cobro sin tomar cupo', async () => {
      const { pagoId, externalId, regId } = await qrPendiente();

      await enviar(evento('payment.failed', externalId, { failureReason: 'card_declined' })).expect(
        200,
      );

      const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });
      expect(pago.status).toBe('failed');
      expect(pago.failureReason).toBe('card_declined');

      const registro = await prisma.registration.findUniqueOrThrow({ where: { id: regId } });
      expect(registro.status).toBe('pending_payment');

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);
    });

    it('payment.refunded suelta el cupo y deja la inscripcion en refunded', async () => {
      const regId = await borradorListo();
      const cobrado = await checkout(regId).expect(200);
      const pagoId = (cobrado.body as Envelope<Checkout>).data.payment.id;
      const fila = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });

      const res = await enviar(evento('payment.refunded', fila.externalId!)).expect(200);
      expect(res.body).toMatchObject({ data: { handled: true } });

      const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });
      expect(pago.status).toBe('refunded');
      expect(pago.refundedAt).not.toBeNull();

      // `refunded` y no `cancelled`: el usuario no cancelo nada, y esa
      // diferencia es la que explica por que se quedo sin plaza.
      const registro = await prisma.registration.findUniqueOrThrow({ where: { id: regId } });
      expect(registro.status).toBe('refunded');
      expect(registro.bibNumber).not.toBeNull();

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);
    });

    it('un tipo de evento inventado no pasa la validacion', async () => {
      const { externalId } = await qrPendiente();

      await enviar(evento('payment.exploded', externalId)).expect(400);
    });
  });

  // ─── Comprobante ─────────────────────────────────────────────────────────

  describe('GET /payments/:id/receipt', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    async function pagar(): Promise<string> {
      const regId = await borradorListo();
      const res = await checkout(regId).expect(200);

      return (res.body as Envelope<Checkout>).data.payment.id;
    }

    it('genera un PDF de verdad con los datos del pago', async () => {
      const pagoId = await pagar();

      const res = await http().get(`/api/v1/payments/${pagoId}/receipt`).set(auth()).expect(200);
      const { url } = (res.body as Envelope<{ url: string }>).data;

      expect(url).toMatch(/\.pdf$/);

      const clave = new URL(url).pathname.replace(/^\/uploads\//, '');
      const bytes = await readFile(join(resolve(process.env.UPLOADS_DIR ?? './uploads'), clave));

      // Firma de un PDF. Si esto pasa, es un documento abrible y no un archivo
      // con la extension puesta a mano.
      expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      expect(bytes.byteLength).toBeGreaterThan(1_000);
    });

    it('la segunda llamada devuelve la misma URL, sin regenerar', async () => {
      const pagoId = await pagar();

      const uno = await http().get(`/api/v1/payments/${pagoId}/receipt`).set(auth()).expect(200);
      const dos = await http().get(`/api/v1/payments/${pagoId}/receipt`).set(auth()).expect(200);

      const a = (uno.body as Envelope<{ url: string }>).data.url;
      const b = (dos.body as Envelope<{ url: string }>).data.url;

      expect(b).toBe(a);

      const fila = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });
      expect(fila.receiptUrl).toBe(a);
    });

    it('no hay comprobante de un cobro que no se cobro', async () => {
      const regId = await borradorListo();
      const abierto = await checkout(regId, { method: 'bank_transfer', card: null }).expect(200);
      const pagoId = (abierto.body as Envelope<Checkout>).data.payment.id;

      const res = await http().get(`/api/v1/payments/${pagoId}/receipt`).set(auth()).expect(409);

      expect((res.body as ErrorBody).error.code).toBe('RECEIPT_NOT_AVAILABLE');
    });

    it('no se puede pedir el comprobante de otro', async () => {
      const pagoId = await pagar();

      await http().get(`/api/v1/payments/${pagoId}/receipt`).set(auth(tokenOtro)).expect(404);
    });
  });

  // ─── Reembolso al cancelar ───────────────────────────────────────────────

  describe('reembolso al cancelar la inscripcion', () => {
    beforeEach(limpiar);
    afterAll(limpiar);

    it('cancelar devuelve el dinero y libera el cupo', async () => {
      const regId = await borradorListo();
      const cobrado = await checkout(regId).expect(200);
      const pagoId = (cobrado.body as Envelope<Checkout>).data.payment.id;

      await http().delete(`/api/v1/registrations/${regId}`).set(auth()).expect(200);

      const pago = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });
      expect(pago.status).toBe('refunded');
      expect(pago.refundedAt).not.toBeNull();
      expect(pago.failureReason).toBe('cancelled_by_user');

      const registro = await prisma.registration.findUniqueOrThrow({ where: { id: regId } });
      expect(registro.status).toBe('cancelled');

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(0);
    });

    it('cancelar dos veces no reembolsa dos veces', async () => {
      const regId = await borradorListo();
      const cobrado = await checkout(regId).expect(200);
      const pagoId = (cobrado.body as Envelope<Checkout>).data.payment.id;

      await http().delete(`/api/v1/registrations/${regId}`).set(auth()).expect(200);
      const antes = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });

      await http().delete(`/api/v1/registrations/${regId}`).set(auth()).expect(200);
      const despues = await prisma.payment.findUniqueOrThrow({ where: { id: pagoId } });

      expect(despues.refundedAt?.getTime()).toBe(antes.refundedAt?.getTime());
    });

    it('cancelar un borrador sin cobros no falla', async () => {
      const regId = await borradorListo();

      await http().delete(`/api/v1/registrations/${regId}`).set(auth()).expect(200);

      const pagos = await prisma.payment.count({ where: { registrationId: regId } });
      expect(pagos).toBe(0);
    });
  });

  // ─── Concurrencia ────────────────────────────────────────────────────────

  describe('cupos transaccionales', () => {
    afterAll(limpiar);

    it('dos personas peleando el ultimo cupo: entra una sola', async () => {
      await limpiar();

      const ids = [await borradorListo(token), await borradorListo(tokenOtro)];

      // Un solo lugar libre, ya con los dos borradores listos.
      await prisma.marathon.update({
        where: { id: marathonId },
        data: { capacity: 1, slotsTaken: 0 },
      });

      // Los dos checkout salen a la vez.
      const respuestas = await Promise.all([
        checkout(ids[0]!, { t: token }),
        checkout(ids[1]!, { t: tokenOtro }),
      ]);

      const estados = respuestas.map((r) => r.status).sort();
      expect(estados).toEqual([200, 409]);

      const perdedor = respuestas.find((r) => r.status === 409)!;
      expect((perdedor.body as ErrorBody).error.code).toBe('MARATHON_FULL');

      const maraton = await prisma.marathon.findUnique({ where: { id: marathonId } });
      expect(maraton?.slotsTaken).toBe(1);

      // Y el que perdio no quedo cobrado: o no se le cobro, o se le reembolso.
      const pagos = await prisma.payment.findMany({
        where: { registration: { marathonId } },
      });
      expect(pagos.filter((p) => p.status === 'paid')).toHaveLength(1);
      expect(pagos.every((p) => p.status !== 'paid' || p.paidAt !== null)).toBe(true);
    });
  });
});
