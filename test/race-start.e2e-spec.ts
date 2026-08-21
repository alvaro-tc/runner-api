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
  error: { code: string; message: string; details: { status?: string }[] };
}

interface Registro {
  id: string;
  status: string;
  bibNumber: string | null;
  totalCents: number;
}

interface SesionArrancada {
  session: { id: string; status: string };
  workout: { id: string };
  ingestToken: string;
}

const enDias = (dias: number) => new Date(Date.now() + dias * 86_400_000);

const DATOS = { fullName: 'Alvaro Quispe', docId: '1234567 LP', phone: '+591 70000000' };

const TARJETA_QUE_APRUEBA = {
  number: '4242424242424242',
  holder: 'ALVARO QUISPE',
  expMonth: 12,
  expYear: 2030,
  cvv: '123',
};

/**
 * El camino completo que recorre un corredor: inscribirse, pagar, largar la
 * maraton, mandar posiciones y cerrar con resultado.
 *
 * Existe porque cada pieza ya tenia su test y aun asi el recorrido entero no
 * estaba probado en ningun sitio: es justo donde aparecen los huecos, como
 * poder largar una carrera sin haberla pagado.
 */
describe('Race start (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `rstest-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  let token = '';
  let userId = '';
  let marathonId = '';
  let routeId = '';

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  let secuencia = 0;
  const nuevaClave = () => `${marca}-key-${(secuencia += 1)}`;

  /** Recta hacia el norte desde el ecuador: `n` vertices cada `metros`. */
  const GRADO_LAT = 111_195;
  const recta = (n: number, metros: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [0, Number(((i * metros) / GRADO_LAT).toFixed(6))]);

  /** Deja una inscripcion en borrador, lista para cobrar. */
  async function borrador(): Promise<string> {
    const res = await http()
      .post('/api/v1/registrations')
      .set(auth())
      .send({ marathonId, personalData: DATOS })
      .expect(201);

    return (res.body as Envelope<Registro>).data.id;
  }

  async function pagar(registrationId: string): Promise<Registro> {
    const res = await http()
      .post(`/api/v1/registrations/${registrationId}/checkout`)
      .set({ ...auth(), 'Idempotency-Key': nuevaClave() })
      .send({ termsAccepted: true, method: 'card', card: TARJETA_QUE_APRUEBA })
      .expect(200);

    return (res.body as Envelope<{ registration: Registro }>).data.registration;
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
        email: `${marca}-runner@test.com`,
        password: 'Test1234!',
        name: 'Corredor',
        deviceId: `${marca}-runner`,
      })
      .expect(201);

    const datos = (registro.body as Envelope<{ accessToken: string; user: { id: string } }>).data;
    token = datos.accessToken;
    userId = datos.user.id;

    // La maraton nace de un recorrido preestablecido, igual que desde el panel.
    const ruta = await prisma.route.create({
      data: {
        slug: `${marca}-circuito`,
        name: 'Circuito de la prueba',
        city: 'Ciudad Prueba',
        distanceMeters: 10_000,
        startLat: 0,
        startLng: 0,
        geoJson: { type: 'LineString', coordinates: recta(11, 1000) },
      },
    });
    routeId = ruta.id;

    const maraton = await prisma.marathon.create({
      data: {
        slug: `${marca}-maraton`,
        name: 'Maraton de la prueba',
        city: 'Ciudad Prueba',
        // Larga dentro de media hora: con la fecha pasada las inscripciones ya
        // estarian cerradas y no se podria ni llegar al pago.
        startsAt: enDias(0.02),
        distanceMeters: ruta.distanceMeters,
        capacity: 100,
        priceCents: 15_000,
        publishedAt: new Date(),
        routeId: ruta.id,
        routeGeoJson: ruta.geoJson as object,
      },
    });
    marathonId = maraton.id;
  });

  afterAll(async () => {
    await prisma.position.deleteMany({ where: { userId } });
    await prisma.marathon.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.route.deleteMany({ where: { slug: { startsWith: marca } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: marca } } });
    await app?.close();
  });

  afterEach(async () => {
    // Una sola sesion abierta por usuario: dejar una colgada rompe el siguiente
    // test por un motivo que no tiene nada que ver con lo que prueba.
    const abierta = await prisma.trackingSession.findFirst({
      where: { userId, status: { in: ['active', 'paused'] } },
      select: { id: true },
    });
    if (abierta) {
      await http().delete(`/api/v1/workouts/sessions/${abierta.id}`).set(auth());
    }
  });

  // ─── La puerta ───────────────────────────────────────────────────────────

  describe('largar sin haber pagado', () => {
    it('no deja arrancar la carrera con la inscripcion en borrador', async () => {
      const registrationId = await borrador();

      const res = await http()
        .post('/api/v1/workouts/sessions')
        .set(auth())
        .send({ clientUuid: crypto.randomUUID(), type: 'race', registrationId })
        .expect(409);

      const error = (res.body as ErrorBody).error;
      expect(error.code).toBe('REGISTRATION_NOT_CONFIRMED');
      expect(error.details[0]?.status).toBe('draft');
    });

    it('tampoco con la inscripcion de otra persona', async () => {
      const otro = await http()
        .post('/api/v1/auth/register')
        .send({
          email: `${marca}-otro@test.com`,
          password: 'Test1234!',
          name: 'Otro',
          deviceId: `${marca}-otro`,
        })
        .expect(201);

      const tokenOtro = (otro.body as Envelope<{ accessToken: string }>).data.accessToken;
      const registrationId = await borrador();

      // 404 y no 403: una inscripcion ajena no existe para quien no es su dueno.
      await http()
        .post('/api/v1/workouts/sessions')
        .set(auth(tokenOtro))
        .send({ clientUuid: crypto.randomUUID(), type: 'race', registrationId })
        .expect(404);
    });
  });

  // ─── El camino completo ──────────────────────────────────────────────────

  describe('inscribirse, pagar y correr', () => {
    it('recorre inscripcion, pago, largada, posiciones y resultado', async () => {
      const registrationId = await borrador();
      const inscripcion = await pagar(registrationId);

      expect(inscripcion.status).toBe('confirmed');
      // El dorsal sale del mismo paso que el cobro: sin el, la app pinta
      // "pagado" y "sin dorsal" a la vez.
      expect(inscripcion.bibNumber).toBeTruthy();

      // Cinco minutos de carrera a un punto cada 30 s, avanzando hacia el norte.
      // La sesion se abre fechada en la largada y no "ahora": la app manda el
      // primer lote cuando ya lleva un rato corriendo, y la ingesta descarta
      // todo punto anterior al arranque de la sesion.
      const arranco = Date.now() - 5 * 60_000;

      const arranque = await http()
        .post('/api/v1/workouts/sessions')
        .set(auth())
        .send({
          clientUuid: crypto.randomUUID(),
          type: 'race',
          registrationId,
          startedAt: new Date(arranco).toISOString(),
        })
        .expect(201);

      const { session, ingestToken } = (arranque.body as Envelope<SesionArrancada>).data;
      expect(session.status).toBe('active');

      // La sesion queda atada a la maraton: es lo que lee la ingesta para
      // decidir si el punto va al mapa de espectadores.
      const enBase = await prisma.trackingSession.findUnique({
        where: { id: session.id },
        select: { marathonId: true },
      });
      expect(enBase?.marathonId).toBe(marathonId);

      const points = Array.from({ length: 11 }, (_, i) => ({
        clientPointId: `${marca}-p${i}`,
        recordedAt: new Date(arranco + i * 30_000).toISOString(),
        lat: Number(((i * 100) / GRADO_LAT).toFixed(6)),
        lng: 0,
        accuracy: 6,
      }));

      const ingesta = await http()
        .post(`/api/v1/tracking/sessions/${session.id}/positions`)
        .set({ Authorization: `Bearer ${ingestToken}` })
        .send({ points })
        .expect(202);

      expect((ingesta.body as Envelope<{ accepted: number }>).data.accepted).toBe(points.length);

      // Reenviar el mismo lote es seguro: es lo que hace un movil que perdio la
      // respuesta en un tunel.
      const reenvio = await http()
        .post(`/api/v1/tracking/sessions/${session.id}/positions`)
        .set({ Authorization: `Bearer ${ingestToken}` })
        .send({ points })
        .expect(202);

      expect((reenvio.body as Envelope<{ duplicated: number }>).data.duplicated).toBe(points.length);

      const cierre = await http()
        .post(`/api/v1/workouts/sessions/${session.id}/finish`)
        .set(auth())
        .send({ feeling: 4 })
        .expect(200);

      const workout = (cierre.body as Envelope<{ workout: { distanceMeters: number } }>).data
        .workout;

      // Diez tramos de cien metros: la distancia sale de las posiciones, no de
      // lo que diga el telefono.
      expect(workout.distanceMeters).toBeGreaterThan(900);
      expect(workout.distanceMeters).toBeLessThan(1_100);

      // Y de un entrenamiento con inscripcion sale el resultado oficial.
      const resultado = await prisma.raceResult.findUnique({ where: { registrationId } });
      expect(resultado).not.toBeNull();
      expect(resultado!.distanceMeters).toBe(workout.distanceMeters);
    });

    it('la carrera aparece en `GET /races/me` con su dorsal', async () => {
      const res = await http().get('/api/v1/races/me').set(auth()).expect(200);
      const carreras = (res.body as Envelope<{ marathon: { id: string }; bibNumber: string }[]>)
        .data;

      const mia = carreras.find((c) => c.marathon.id === marathonId);
      expect(mia).toBeDefined();
      expect(mia!.bibNumber).toBeTruthy();
    });

    it('la maraton expone el recorrido que copio del preestablecido', async () => {
      const res = await http().get(`/api/v1/marathons/${marca}-maraton`).expect(200);
      const detalle = (res.body as Envelope<{ routeGeoJson: { type: string } }>).data;

      expect(detalle.routeGeoJson.type).toBe('LineString');
      expect(routeId).toBeTruthy();
    });
  });
});
