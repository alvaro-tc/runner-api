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

interface Resumen {
  id: string;
  slug: string;
  name: string;
  city: string;
  distanceMeters: number;
  startLat: number;
  startLng: number;
  archived: boolean;
}

interface Detalle extends Resumen {
  geoJson: { type: string; coordinates: [number, number][] };
}

interface MaratonCreada {
  id: string;
  slug: string;
  distanceMeters: number;
  routeId: string | null;
  routeGeoJson: unknown;
}

const MS_POR_DIA = 86_400_000;
const enDias = (dias: number) => new Date(Date.now() + dias * MS_POR_DIA).toISOString();

/**
 * Recorridos preestablecidos y el alta de maratones a partir de ellos.
 *
 * Lo que importa aqui: que la distancia salga **de la geometria** y no del
 * formulario, que el catalogo publico se vea sin token pero solo el panel
 * escriba, y que un recorrido con carreras detras no se pueda borrar.
 */
describe('Routes (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `rtest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let adminToken = '';
  let runnerToken = '';
  let routeId = '';

  const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

  /**
   * Recta hacia el norte desde el ecuador: `n` vertices cada `metros`.
   * Un trazado de largo conocido es lo unico que deja comprobar que la API mide
   * en vez de creerse lo que le mandan.
   */
  const GRADO_LAT = 111_195;
  const recta = (n: number, metros: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [0, Number(((i * metros) / GRADO_LAT).toFixed(6))]);

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
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    runnerToken = (await registrar('runner')).token;

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
  });

  afterAll(async () => {
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.route.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: marca } } });
    await app?.close();
  });

  // ─── Alta ────────────────────────────────────────────────────────────────

  describe('POST /admin/routes', () => {
    it('mide la distancia sobre la geometria en vez de creerse un numero', async () => {
      const res = await http()
        .post('/api/v1/admin/routes')
        .set(auth())
        .send({
          slug: `${marca}-diez-k`,
          name: 'Circuito de prueba 10K',
          city: 'Ciudad Prueba',
          description: 'Once vertices, mil metros entre cada uno.',
          geoJson: { type: 'LineString', coordinates: recta(11, 1000) },
        })
        .expect(201);

      const ruta = (res.body as Envelope<Resumen>).data;
      routeId = ruta.id;

      expect(ruta.distanceMeters).toBeGreaterThan(9_900);
      expect(ruta.distanceMeters).toBeLessThan(10_100);
      // La largada se desnormaliza desde el primer vertice.
      expect(ruta.startLat).toBe(0);
      expect(ruta.startLng).toBe(0);
      expect(ruta.archived).toBe(false);
    });

    it('rechaza una geometria que no es un LineString utilizable', async () => {
      const res = await http()
        .post('/api/v1/admin/routes')
        .set(auth())
        .send({
          name: 'Circuito invalido',
          city: 'Ciudad Prueba',
          geoJson: { type: 'Polygon', coordinates: recta(11, 1000) },
        })
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('no lo puede cargar un corredor cualquiera', async () => {
      await http()
        .post('/api/v1/admin/routes')
        .set(auth(runnerToken))
        .send({
          name: 'Circuito colado',
          city: 'Ciudad Prueba',
          geoJson: { type: 'LineString', coordinates: recta(11, 1000) },
        })
        .expect(403);
    });
  });

  // ─── Catalogo publico ────────────────────────────────────────────────────

  describe('GET /routes', () => {
    it('es publico: no exige token', async () => {
      const res = await http().get('/api/v1/routes').expect(200);
      const slugs = (res.body as Envelope<Resumen[]>).data.map((r) => r.slug);

      expect(slugs).toContain(`${marca}-diez-k`);
    });

    it('devuelve el trazado simplificado, que es lo que dibuja el movil', async () => {
      const res = await http().get(`/api/v1/routes/${marca}-diez-k`).expect(200);
      const ruta = (res.body as Envelope<Detalle>).data;

      expect(ruta.geoJson.type).toBe('LineString');
      // Una recta se simplifica a sus dos extremos: es la prueba de que pasa
      // por el simplificador y no sale cruda.
      expect(ruta.geoJson.coordinates).toHaveLength(2);
    });

    it('con `full` devuelve la geometria tal como se cargo', async () => {
      const res = await http().get(`/api/v1/routes/${marca}-diez-k?full=true`).expect(200);

      expect((res.body as Envelope<Detalle>).data.geoJson.coordinates).toHaveLength(11);
    });

    it('responde 404 con un slug que no existe', async () => {
      const res = await http().get(`/api/v1/routes/${marca}-no-existe`).expect(404);

      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });
  });

  // ─── Crear una maraton eligiendo su recorrido ────────────────────────────

  describe('POST /admin/marathons con routeId', () => {
    it('copia trazado, distancia y largada del recorrido elegido', async () => {
      const res = await http()
        .post('/api/v1/admin/marathons')
        .set(auth())
        .send({
          slug: `${marca}-con-ruta`,
          name: 'Carrera con recorrido',
          city: 'Ciudad Prueba',
          startsAt: enDias(60),
          capacity: 500,
          priceCents: 15_000,
          routeId,
          published: true,
        })
        .expect(201);

      const maraton = (res.body as Envelope<MaratonCreada>).data;

      expect(maraton.routeId).toBe(routeId);
      expect(maraton.distanceMeters).toBeGreaterThan(9_900);
      expect(maraton.distanceMeters).toBeLessThan(10_100);
      expect(maraton.routeGeoJson).toMatchObject({ type: 'LineString' });
    });

    it('la distancia del recorrido manda sobre la que mande el formulario', async () => {
      const res = await http()
        .post('/api/v1/admin/marathons')
        .set(auth())
        .send({
          slug: `${marca}-distancia-mentirosa`,
          name: 'Carrera con distancia mentirosa',
          city: 'Ciudad Prueba',
          startsAt: enDias(61),
          capacity: 500,
          priceCents: 15_000,
          distanceMeters: 42_195,
          routeId,
        })
        .expect(201);

      expect((res.body as Envelope<MaratonCreada>).data.distanceMeters).toBeLessThan(11_000);
    });

    it('sin recorrido y sin distancia no se puede crear', async () => {
      const res = await http()
        .post('/api/v1/admin/marathons')
        .set(auth())
        .send({
          slug: `${marca}-sin-nada`,
          name: 'Carrera sin recorrido',
          city: 'Ciudad Prueba',
          startsAt: enDias(62),
          capacity: 500,
          priceCents: 15_000,
        })
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('un recorrido archivado no se puede elegir para una carrera nueva', async () => {
      const archivado = await http()
        .post('/api/v1/admin/routes')
        .set(auth())
        .send({
          slug: `${marca}-archivado`,
          name: 'Circuito retirado',
          city: 'Ciudad Prueba',
          geoJson: { type: 'LineString', coordinates: recta(11, 1000) },
        })
        .expect(201);

      const id = (archivado.body as Envelope<Resumen>).data.id;
      await http().put(`/api/v1/admin/routes/${id}`).set(auth()).send({ archived: true }).expect(200);

      const res = await http()
        .post('/api/v1/admin/marathons')
        .set(auth())
        .send({
          slug: `${marca}-con-archivado`,
          name: 'Carrera con recorrido retirado',
          city: 'Ciudad Prueba',
          startsAt: enDias(63),
          capacity: 500,
          priceCents: 15_000,
          routeId: id,
        })
        .expect(409);

      expect((res.body as ErrorBody).error.code).toBe('CONFLICT');
    });
  });

  // ─── Edicion y borrado ───────────────────────────────────────────────────

  describe('PUT / DELETE /admin/routes/:id', () => {
    it('editar la geometria no toca la maraton que ya lo copio', async () => {
      const antes = await prisma.marathon.findUnique({
        where: { slug: `${marca}-con-ruta` },
        select: { routeGeoJson: true, distanceMeters: true },
      });

      await http()
        .put(`/api/v1/admin/routes/${routeId}`)
        .set(auth())
        .send({ geoJson: { type: 'LineString', coordinates: recta(6, 1000) } })
        .expect(200);

      const despues = await prisma.marathon.findUnique({
        where: { slug: `${marca}-con-ruta` },
        select: { routeGeoJson: true, distanceMeters: true },
      });

      expect(despues).toEqual(antes);
    });

    it('no borra un recorrido del que salieron carreras', async () => {
      const res = await http().delete(`/api/v1/admin/routes/${routeId}`).set(auth()).expect(409);

      expect((res.body as ErrorBody).error.code).toBe('CONFLICT');
    });

    it('borra uno que no uso nadie', async () => {
      const suelto = await http()
        .post('/api/v1/admin/routes')
        .set(auth())
        .send({
          slug: `${marca}-suelto`,
          name: 'Circuito sin carreras',
          city: 'Ciudad Prueba',
          geoJson: { type: 'LineString', coordinates: recta(11, 1000) },
        })
        .expect(201);

      const id = (suelto.body as Envelope<Resumen>).data.id;
      await http().delete(`/api/v1/admin/routes/${id}`).set(auth()).expect(204);
      await http().get(`/api/v1/routes/${id}`).expect(404);
    });
  });
});
