import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { QuoteService } from '../src/modules/pricing/quote.service';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}
interface ErrorBody {
  error: { code: string; message: string; details: unknown[] };
}

interface Quote {
  marathonId: string;
  currency: string;
  items: {
    type: string;
    refId: string | null;
    label: string;
    quantity: number;
    amountCents: number;
  }[];
  subtotalCents: number;
  serviceFee: { label: string; amountCents: number } | null;
  totalCents: number;
}

const enDias = (dias: number) => new Date(Date.now() + dias * 86_400_000);

/**
 * Cotizacion contra Postgres real.
 *
 * El foco esta en la cadena de resolucion del cargo por servicio —override de
 * la maraton, global, apagado— porque es la unica parte con estados que no se
 * ven mirando una sola fila.
 */
describe('Pricing (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let quotes: QuoteService;

  const marca = `ptest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let marathonId = '';
  let marathonConOverrideId = '';
  let categoriaConRecargoId = '';
  let categoriaGratisId = '';
  let extraId = '';
  let extraSinStockId = '';
  let extraLimitadoId = '';
  let globalId = '';

  const cotizar = (body: object) => http().post('/api/v1/pricing/quote').send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    quotes = app.get(QuoteService);

    // La config global la crea el seed. Si no corrio, se crea aca apagada, que
    // es el estado por defecto del producto.
    const global =
      (await prisma.serviceFeeConfig.findFirst({ where: { scope: 'global' } })) ??
      (await prisma.serviceFeeConfig.create({
        data: { scope: 'global', enabled: false, type: 'percent', percentBps: 1000, minCents: 500 },
      }));
    globalId = global.id;

    const maraton = await prisma.marathon.create({
      data: {
        slug: `${marca}-carrera`,
        name: 'Carrera de precios',
        city: 'Ciudad Prueba',
        startsAt: enDias(60),
        distanceMeters: 21_097,
        capacity: 500,
        priceCents: 20_000,
        publishedAt: new Date(),
        categories: {
          create: [
            { name: 'General', extraPriceCents: 0 },
            { name: 'Elite', extraPriceCents: 5_000 },
          ],
        },
        extras: {
          create: [
            { name: 'Remera', priceCents: 10_000, stock: null },
            { name: 'Agotado', priceCents: 3_000, stock: 0 },
            { name: 'Ultimas dos', priceCents: 4_000, stock: 2 },
          ],
        },
      },
      include: { categories: true, extras: true },
    });

    marathonId = maraton.id;
    categoriaGratisId = maraton.categories.find((c) => c.name === 'General')!.id;
    categoriaConRecargoId = maraton.categories.find((c) => c.name === 'Elite')!.id;
    extraId = maraton.extras.find((e) => e.name === 'Remera')!.id;
    extraSinStockId = maraton.extras.find((e) => e.name === 'Agotado')!.id;
    extraLimitadoId = maraton.extras.find((e) => e.name === 'Ultimas dos')!.id;

    // Segunda maraton, con override propio del cargo.
    const override = await prisma.serviceFeeConfig.create({
      data: {
        scope: 'marathon',
        enabled: true,
        type: 'fixed',
        fixedCents: 1_500,
        label: 'Gestion del organizador',
      },
    });

    const conOverride = await prisma.marathon.create({
      data: {
        slug: `${marca}-con-override`,
        name: 'Carrera con override',
        city: 'Ciudad Prueba',
        startsAt: enDias(61),
        distanceMeters: 10_000,
        capacity: 300,
        priceCents: 20_000,
        publishedAt: new Date(),
        serviceFeeConfigId: override.id,
      },
    });
    marathonConOverrideId = conOverride.id;
  });

  afterAll(async () => {
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.serviceFeeConfig.deleteMany({ where: { label: 'Gestion del organizador' } });
    // Se deja la global como estaba: apagada.
    await prisma.serviceFeeConfig.update({
      where: { id: globalId },
      data: { enabled: false, type: 'percent', percentBps: 1000, minCents: 500, maxCents: null },
    });
    await app?.close();
  });

  /** Enciende o apaga la config global entre pruebas. */
  const configurarGlobal = (data: Record<string, unknown>) =>
    prisma.serviceFeeConfig.update({ where: { id: globalId }, data });

  // ─── Desglose ────────────────────────────────────────────────────────────

  describe('desglose', () => {
    it('es publico: cotizar no exige token', async () => {
      await cotizar({ marathonId }).expect(200);
    });

    it('solo la cuota base cuando no se eligio nada', async () => {
      const res = await cotizar({ marathonId }).expect(200);
      const { data } = res.body as Envelope<Quote>;

      expect(data.items).toHaveLength(1);
      expect(data.items[0]?.type).toBe('base');
      expect(data.subtotalCents).toBe(20_000);
      expect(data.totalCents).toBe(20_000);
      expect(data.currency).toBe('BOB');
    });

    it('suma el recargo de la categoria', async () => {
      const res = await cotizar({ marathonId, categoryId: categoriaConRecargoId }).expect(200);
      const { data } = res.body as Envelope<Quote>;

      expect(data.items.map((i) => i.type)).toEqual(['base', 'category']);
      expect(data.subtotalCents).toBe(25_000);
    });

    it('una categoria sin recargo aparece igual, en cero', async () => {
      const res = await cotizar({ marathonId, categoryId: categoriaGratisId }).expect(200);
      const { data } = res.body as Envelope<Quote>;

      // La linea existe para que la UI pueda mostrar que categoria eligio.
      expect(data.items[1]?.amountCents).toBe(0);
      expect(data.subtotalCents).toBe(20_000);
    });

    it('multiplica los extras por su cantidad', async () => {
      const res = await cotizar({
        marathonId,
        extras: [{ extraId, quantity: 3 }],
      }).expect(200);

      const { data } = res.body as Envelope<Quote>;
      const linea = data.items.find((i) => i.type === 'extra');

      expect(linea?.quantity).toBe(3);
      expect(linea?.amountCents).toBe(30_000);
      expect(data.subtotalCents).toBe(50_000);
    });

    it('agrupa el mismo extra pedido dos veces', async () => {
      const res = await cotizar({
        marathonId,
        extras: [
          { extraId, quantity: 1 },
          { extraId, quantity: 2 },
        ],
      }).expect(200);

      const { data } = res.body as Envelope<Quote>;
      const lineas = data.items.filter((i) => i.type === 'extra');

      expect(lineas).toHaveLength(1);
      expect(lineas[0]?.quantity).toBe(3);
    });
  });

  // ─── Validaciones ────────────────────────────────────────────────────────

  describe('validaciones', () => {
    it('404 si la maraton no existe o no esta publicada', async () => {
      const res = await cotizar({ marathonId: 'no-existe' }).expect(404);
      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('rechaza una categoria de otra maraton', async () => {
      const res = await cotizar({
        marathonId: marathonConOverrideId,
        categoryId: categoriaConRecargoId,
      }).expect(400);

      expect((res.body as ErrorBody).error.code).toBe('INVALID_CATEGORY');
    });

    it('rechaza un extra de otra maraton', async () => {
      const res = await cotizar({
        marathonId: marathonConOverrideId,
        extras: [{ extraId, quantity: 1 }],
      }).expect(400);

      expect((res.body as ErrorBody).error.code).toBe('INVALID_EXTRA');
    });

    it('avisa cuando un extra esta agotado', async () => {
      const res = await cotizar({
        marathonId,
        extras: [{ extraId: extraSinStockId, quantity: 1 }],
      }).expect(409);

      expect((res.body as ErrorBody).error.code).toBe('EXTRA_OUT_OF_STOCK');
    });

    it('avisa cuando se piden mas unidades de las que quedan', async () => {
      const res = await cotizar({
        marathonId,
        extras: [{ extraId: extraLimitadoId, quantity: 3 }],
      }).expect(409);

      expect((res.body as ErrorBody).error.message).toContain('Solo quedan 2');
    });

    it('deja pedir justo las que quedan', async () => {
      await cotizar({ marathonId, extras: [{ extraId: extraLimitadoId, quantity: 2 }] }).expect(
        200,
      );
    });

    it('stock null es sin limite, no agotado', async () => {
      await cotizar({ marathonId, extras: [{ extraId, quantity: 10 }] }).expect(200);
    });

    it('rechaza cantidades absurdas en la validacion del DTO', async () => {
      const res = await cotizar({
        marathonId,
        extras: [{ extraId, quantity: 999 }],
      }).expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─── Cargo por servicio ──────────────────────────────────────────────────

  describe('cargo por servicio', () => {
    it('apagado: serviceFee es null y el total es el subtotal', async () => {
      await configurarGlobal({ enabled: false });

      const res = await cotizar({ marathonId }).expect(200);
      const { data } = res.body as Envelope<Quote>;

      expect(data.serviceFee).toBeNull();
      expect(data.totalCents).toBe(data.subtotalCents);
    });

    it('encendido: aplica el porcentaje global', async () => {
      await configurarGlobal({ enabled: true, type: 'percent', percentBps: 1000, minCents: null });

      const res = await cotizar({ marathonId }).expect(200);
      const { data } = res.body as Envelope<Quote>;

      expect(data.serviceFee?.amountCents).toBe(2_000);
      expect(data.totalCents).toBe(22_000);
    });

    it('el minimo levanta un porcentaje que quedo corto', async () => {
      await configurarGlobal({ enabled: true, type: 'percent', percentBps: 100, minCents: 500 });

      const res = await cotizar({ marathonId }).expect(200);
      // 20000 * 1% = 200, pero el minimo es 500.
      expect((res.body as Envelope<Quote>).data.serviceFee?.amountCents).toBe(500);
    });

    it('el maximo corta un porcentaje que se disparo', async () => {
      await configurarGlobal({
        enabled: true,
        type: 'percent',
        percentBps: 5000,
        minCents: null,
        maxCents: 1_000,
      });

      const res = await cotizar({ marathonId }).expect(200);
      expect((res.body as Envelope<Quote>).data.serviceFee?.amountCents).toBe(1_000);
    });

    it('el override de la maraton gana sobre la global', async () => {
      await configurarGlobal({ enabled: true, type: 'percent', percentBps: 1000, maxCents: null });

      const res = await cotizar({ marathonId: marathonConOverrideId }).expect(200);
      const { data } = res.body as Envelope<Quote>;

      // Fijo de Bs 15, no el 10% que dice la global.
      expect(data.serviceFee?.label).toBe('Gestion del organizador');
      expect(data.serviceFee?.amountCents).toBe(1_500);
    });

    it('un override APAGADO exime a esa carrera, no cae a la global', async () => {
      await configurarGlobal({ enabled: true, type: 'percent', percentBps: 1000 });
      await prisma.serviceFeeConfig.updateMany({
        where: { label: 'Gestion del organizador' },
        data: { enabled: false },
      });

      const conOverride = await cotizar({ marathonId: marathonConOverrideId }).expect(200);
      const sinOverride = await cotizar({ marathonId }).expect(200);

      expect((conOverride.body as Envelope<Quote>).data.serviceFee).toBeNull();
      // La otra maraton sigue pagando el cargo global: el apagado es local.
      expect((sinOverride.body as Envelope<Quote>).data.serviceFee).not.toBeNull();

      await prisma.serviceFeeConfig.updateMany({
        where: { label: 'Gestion del organizador' },
        data: { enabled: true },
      });
    });

    it('el cargo se calcula sobre el subtotal completo, extras incluidos', async () => {
      await configurarGlobal({
        enabled: true,
        type: 'percent',
        percentBps: 1000,
        minCents: null,
        maxCents: null,
      });

      const res = await cotizar({
        marathonId,
        categoryId: categoriaConRecargoId,
        extras: [{ extraId, quantity: 1 }],
      }).expect(200);

      const { data } = res.body as Envelope<Quote>;
      expect(data.subtotalCents).toBe(35_000); // 20000 + 5000 + 10000
      expect(data.serviceFee?.amountCents).toBe(3_500);
      expect(data.totalCents).toBe(38_500);
    });

    it('el snapshot no viaja al cliente, pero el servicio si lo devuelve', async () => {
      await configurarGlobal({ enabled: true, type: 'percent', percentBps: 1000 });

      const res = await cotizar({ marathonId }).expect(200);
      expect(res.body).not.toHaveProperty('data.serviceFeeSnapshot');

      const interno = await quotes.cotizar({ marathonId });
      expect(interno.serviceFeeSnapshot).toMatchObject({
        scope: 'global',
        type: 'percent',
        percentBps: 1000,
        subtotalCents: 20_000,
        amountCents: interno.serviceFee?.amountCents,
      });
    });

    it('cambiar la config despues no altera un snapshot ya tomado', async () => {
      await configurarGlobal({
        enabled: true,
        type: 'percent',
        percentBps: 1000,
        minCents: null,
        maxCents: null,
      });
      const antes = await quotes.cotizar({ marathonId });

      await configurarGlobal({ percentBps: 3000 });
      const despues = await quotes.cotizar({ marathonId });

      // El snapshot viejo sigue diciendo lo que se aplico ese dia.
      expect(antes.serviceFeeSnapshot?.percentBps).toBe(1000);
      expect(antes.serviceFeeSnapshot?.amountCents).toBe(2_000);
      expect(despues.serviceFeeSnapshot?.percentBps).toBe(3000);
      expect(despues.serviceFeeSnapshot?.amountCents).toBe(6_000);
    });
  });
});
