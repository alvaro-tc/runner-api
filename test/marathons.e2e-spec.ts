import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string; nextCursor?: string | null };
}
interface ErrorBody {
  error: { code: string; message: string; details: unknown[] };
}

interface Resumen {
  id: string;
  slug: string;
  name: string;
  startsAt: string;
  city: string;
  registrationStatus: string;
  capacity: number;
  slotsTaken: number;
  slotsAvailable: number;
}

interface Detalle extends Resumen {
  description: string | null;
  schedule: unknown;
  includes: unknown;
  categories: { id: string; name: string; gender: string | null; extraPriceCents: number }[];
  extras: { id: string; name: string; stock: number | null; available: boolean }[];
}

const MS_POR_DIA = 86_400_000;
const enDias = (dias: number) => new Date(Date.now() + dias * MS_POR_DIA);

/**
 * Catalogo de maratones contra Postgres real.
 *
 * Los datos los crea el propio test —no depende del seed— y se identifican por
 * una marca de tiempo en el slug, para que dos corridas no se pisen.
 */
describe('Marathons (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `mtest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  /** Base de una maraton publicada, abierta y con cupo de sobra. */
  const base = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug: `${marca}-${slug}`,
    name: `Carrera ${slug}`,
    city: 'Ciudad Prueba',
    startsAt: enDias(60),
    distanceMeters: 10_000,
    capacity: 1000,
    slotsTaken: 10,
    priceCents: 12_000,
    publishedAt: new Date(),
    ...extra,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.marathon.create({
      data: {
        ...base('abierta', { startsAt: enDias(60) }),
        description: 'Una carrera de prueba',
        schedule: [{ time: '07:00', title: 'Largada' }],
        includes: ['remera', 'medalla'],
        categories: {
          create: [
            { name: 'General', extraPriceCents: 0 },
            { name: 'Elite femenino', gender: 'female', minAge: 18, extraPriceCents: 5000 },
          ],
        },
        extras: {
          create: [
            { name: 'Remera extra', priceCents: 10_000, stock: 5 },
            { name: 'Foto', priceCents: 8_000, stock: null },
            { name: 'Agotado', priceCents: 1_000, stock: 0 },
          ],
        },
      },
    });

    await prisma.marathon.createMany({
      data: [
        // Poco cupo: closing_soon aunque falten dos meses.
        base('poco-cupo', { slotsTaken: 950, startsAt: enDias(61) }),
        // Poco tiempo: closing_soon aunque sobre cupo.
        base('poco-tiempo', { startsAt: enDias(3) }),
        // Cupo agotado.
        base('llena', { slotsTaken: 1000, startsAt: enDias(62) }),
        // Cerrada a mano por el organizador, con cupo y tiempo de sobra.
        base('cerrada-a-mano', { registrationStatus: 'closed', startsAt: enDias(63) }),
        // Ya corrida.
        base('pasada', { startsAt: enDias(-10) }),
        // Cargada pero sin publicar: no la ve nadie.
        base('borrador', { publishedAt: null, startsAt: enDias(64) }),
        // Publicacion programada para dentro de una semana: tampoco se ve aun.
        base('embargada', { publishedAt: enDias(7), startsAt: enDias(65) }),
        // Otra ciudad, para el filtro.
        base('otra-ciudad', { city: 'Ciudad Lejana', startsAt: enDias(66) }),
      ],
    });
  });

  afterAll(async () => {
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await app?.close();
  });

  /** Solo las maratones de este test, ignorando lo que haya sembrado. */
  const mias = (items: Resumen[]) => items.filter((m) => m.slug.startsWith(marca));

  // ─── Catalogo ────────────────────────────────────────────────────────────

  describe('GET /marathons', () => {
    it('es publico: no exige token', async () => {
      await http().get('/api/v1/marathons').expect(200);
    });

    it('no muestra borradores ni publicaciones programadas', async () => {
      const res = await http().get('/api/v1/marathons?limit=50').expect(200);
      const slugs = mias((res.body as Envelope<Resumen[]>).data).map((m) => m.slug);

      expect(slugs).not.toContain(`${marca}-borrador`);
      expect(slugs).not.toContain(`${marca}-embargada`);
      expect(slugs).toContain(`${marca}-abierta`);
    });

    it('ordena por fecha de largada, de la mas proxima a la mas lejana', async () => {
      const res = await http().get('/api/v1/marathons?limit=50').expect(200);
      const fechas = mias((res.body as Envelope<Resumen[]>).data).map((m) =>
        new Date(m.startsAt).getTime(),
      );

      expect(fechas).toEqual([...fechas].sort((a, b) => a - b));
    });

    it('filtra por ciudad sin distinguir mayusculas', async () => {
      const res = await http().get('/api/v1/marathons?city=ciudad+lejana&limit=50').expect(200);
      const slugs = mias((res.body as Envelope<Resumen[]>).data).map((m) => m.slug);

      expect(slugs).toEqual([`${marca}-otra-ciudad`]);
    });

    it('filtra por rango de fechas', async () => {
      const res = await http()
        .get(`/api/v1/marathons?from=${enDias(1).toISOString()}&to=${enDias(10).toISOString()}`)
        .expect(200);

      const slugs = mias((res.body as Envelope<Resumen[]>).data).map((m) => m.slug);
      expect(slugs).toEqual([`${marca}-poco-tiempo`]);
    });

    it('rechaza un limit fuera de rango', async () => {
      const res = await http().get('/api/v1/marathons?limit=500').expect(400);
      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─── Estado derivado ─────────────────────────────────────────────────────

  describe('estado de inscripcion derivado', () => {
    async function estadoDe(slug: string): Promise<string> {
      const res = await http().get(`/api/v1/marathons/${marca}-${slug}`).expect(200);
      return (res.body as Envelope<Detalle>).data.registrationStatus;
    }

    it('abierta cuando sobra cupo y tiempo', async () => {
      expect(await estadoDe('abierta')).toBe('open');
    });

    it('por cerrar cuando queda menos del 10% del cupo', async () => {
      expect(await estadoDe('poco-cupo')).toBe('closing_soon');
    });

    it('por cerrar cuando faltan menos de 7 dias', async () => {
      expect(await estadoDe('poco-tiempo')).toBe('closing_soon');
    });

    it('llena cuando se agoto el cupo', async () => {
      expect(await estadoDe('llena')).toBe('full');
    });

    it('cerrada por decision del organizador, con cupo y tiempo de sobra', async () => {
      expect(await estadoDe('cerrada-a-mano')).toBe('closed');
    });

    it('cerrada cuando la carrera ya paso', async () => {
      expect(await estadoDe('pasada')).toBe('closed');
    });

    it('el estado sale resuelto aunque la columna diga otra cosa', async () => {
      // La columna sigue en `open`: lo que cambia es lo que responde la API.
      const fila = await prisma.marathon.findUnique({ where: { slug: `${marca}-llena` } });
      expect(fila?.registrationStatus).toBe('open');
      expect(await estadoDe('llena')).toBe('full');
    });

    it('filtra el catalogo por el estado resuelto', async () => {
      const res = await http().get('/api/v1/marathons?status=full&limit=50').expect(200);
      const slugs = mias((res.body as Envelope<Resumen[]>).data).map((m) => m.slug);

      expect(slugs).toContain(`${marca}-llena`);
      expect(slugs).not.toContain(`${marca}-abierta`);
    });
  });

  // ─── Paginacion ──────────────────────────────────────────────────────────

  describe('paginacion por cursor', () => {
    it('recorre el catalogo sin repetir ni saltarse nada', async () => {
      const vistos: string[] = [];
      let cursor: string | null | undefined;
      let vueltas = 0;

      do {
        const url = `/api/v1/marathons?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await http().get(url).expect(200);
        const { data, meta } = res.body as Envelope<Resumen[]>;

        expect(data.length).toBeLessThanOrEqual(2);
        vistos.push(...data.map((m) => m.slug));
        cursor = meta.nextCursor;
        vueltas++;
      } while (cursor && vueltas < 30);

      const propios = vistos.filter((s) => s.startsWith(marca));
      expect(new Set(propios).size).toBe(propios.length);
      expect(propios).toHaveLength(7); // las 9 creadas menos borrador y embargada
    });

    it('un cursor invalido empieza desde el principio en vez de romper', async () => {
      const res = await http().get('/api/v1/marathons?limit=2&cursor=basura-total').expect(200);

      expect((res.body as Envelope<Resumen[]>).data.length).toBeGreaterThan(0);
    });
  });

  // ─── Detalle, categorias y extras ────────────────────────────────────────

  describe('GET /marathons/:slug', () => {
    it('trae el detalle con categorias y extras embebidos', async () => {
      const res = await http().get(`/api/v1/marathons/${marca}-abierta`).expect(200);
      const { data } = res.body as Envelope<Detalle>;

      expect(data.description).toBe('Una carrera de prueba');
      expect(data.includes).toEqual(['remera', 'medalla']);
      expect(data.categories).toHaveLength(2);
      expect(data.extras).toHaveLength(3);
      expect(data.slotsAvailable).toBe(990);
    });

    it('acepta tambien el id', async () => {
      const porSlug = await http().get(`/api/v1/marathons/${marca}-abierta`).expect(200);
      const { id } = (porSlug.body as Envelope<Detalle>).data;

      const porId = await http().get(`/api/v1/marathons/${id}`).expect(200);
      expect((porId.body as Envelope<Detalle>).data.slug).toBe(`${marca}-abierta`);
    });

    it('404 para una maraton que no existe', async () => {
      const res = await http().get('/api/v1/marathons/no-existe-esta').expect(404);
      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('404 para un borrador: no se filtra por url adivinada', async () => {
      await http().get(`/api/v1/marathons/${marca}-borrador`).expect(404);
      await http().get(`/api/v1/marathons/${marca}-embargada`).expect(404);
    });
  });

  describe('GET /marathons/:id/categories y /extras', () => {
    it('devuelve las categorias ordenadas por recargo', async () => {
      const res = await http().get(`/api/v1/marathons/${marca}-abierta/categories`).expect(200);

      const { data } = res.body as Envelope<Detalle['categories']>;
      expect(data.map((c) => c.extraPriceCents)).toEqual([0, 5000]);
      expect(data[0]?.gender).toBeNull();
    });

    it('distingue "sin limite de stock" de "agotado"', async () => {
      const res = await http().get(`/api/v1/marathons/${marca}-abierta/extras`).expect(200);
      const { data } = res.body as Envelope<Detalle['extras']>;

      const sinLimite = data.find((e) => e.name === 'Foto');
      const agotado = data.find((e) => e.name === 'Agotado');

      expect(sinLimite?.stock).toBeNull();
      expect(sinLimite?.available).toBe(true);
      expect(agotado?.stock).toBe(0);
      expect(agotado?.available).toBe(false);
    });

    it('404 cuando la maraton no es visible', async () => {
      await http().get(`/api/v1/marathons/${marca}-borrador/categories`).expect(404);
    });
  });

  // ─── Upcoming ────────────────────────────────────────────────────────────

  describe('GET /marathons/upcoming', () => {
    it('no confunde "upcoming" con un slug', async () => {
      const res = await http().get('/api/v1/marathons/upcoming?limit=3').expect(200);
      expect(Array.isArray((res.body as Envelope<Resumen[]>).data)).toBe(true);
    });

    it('deja fuera las que ya se corrieron', async () => {
      const res = await http().get('/api/v1/marathons/upcoming?limit=50').expect(200);
      const slugs = mias((res.body as Envelope<Resumen[]>).data).map((m) => m.slug);

      expect(slugs).not.toContain(`${marca}-pasada`);
      expect(slugs).toContain(`${marca}-poco-tiempo`);
    });

    it('respeta el limite', async () => {
      const res = await http().get('/api/v1/marathons/upcoming?limit=2').expect(200);
      expect((res.body as Envelope<Resumen[]>).data).toHaveLength(2);
    });
  });
});
