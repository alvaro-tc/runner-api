import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

interface Envelope<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}
interface ErrorBody {
  error: { code: string; message: string; details: unknown[] };
}

interface Me {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
  profile: {
    avatarUrl: string | null;
    city: string | null;
    country: string;
    birthDate: string | null;
    gender: string;
    weightGrams: number | null;
    heightCm: number | null;
    defaultBibNumber: string | null;
  };
}

interface Shoe {
  id: string;
  brand: string;
  model: string;
  distanceMeters: number;
  isPrimary: boolean;
  retiredAt: string | null;
  wearRatio: number;
  wearAlert: boolean;
}

/**
 * Perfil, preferencias, avatar, zapatillas, salud y highlights contra Postgres
 * real. El avatar se prueba con una imagen generada al vuelo por sharp: nada de
 * fixtures binarios en el repo.
 */
describe('Users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let userId: string;

  const marca = `users-${Date.now()}`;
  const email = `${marca}@test.com`;
  const password = 'Test1234!';

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Corredor Perfil', deviceId: `${marca}-dev` })
      .expect(201);

    const { data } = res.body as Envelope<{ accessToken: string; user: { id: string } }>;
    token = data.accessToken;
    userId = data.user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  // ─── Perfil ──────────────────────────────────────────────────────────────

  describe('GET/PATCH /users/me', () => {
    it('sin token responde 401', async () => {
      await http().get('/api/v1/users/me').expect(401);
    });

    it('devuelve el perfil creado junto con la cuenta, con los valores por defecto', async () => {
      const res = await http().get('/api/v1/users/me').set(auth()).expect(200);

      const { data } = res.body as Envelope<Me>;
      expect(data.id).toBe(userId);
      expect(data.email).toBe(email);
      expect(data.profile.country).toBe('BO');
      expect(data.profile.gender).toBe('unspecified');
      expect(data.profile.avatarUrl).toBeNull();
    });

    it('actualiza datos personales repartidos entre users y user_profiles', async () => {
      const res = await http()
        .patch('/api/v1/users/me')
        .set(auth())
        .send({
          name: 'Alvaro Quispe',
          city: 'La Paz',
          birthDate: '1995-04-17',
          gender: 'male',
          weightGrams: 72000,
          heightCm: 174,
        })
        .expect(200);

      const { data } = res.body as Envelope<Me>;
      expect(data.name).toBe('Alvaro Quispe');
      expect(data.profile.city).toBe('La Paz');
      // Columna `date`: se devuelve sin hora, no como medianoche UTC.
      expect(data.profile.birthDate).toBe('1995-04-17');
      expect(data.profile.weightGrams).toBe(72000);
    });

    it('distingue "no lo mando" de "quiero borrarlo"', async () => {
      // Un PATCH que no menciona city no la toca...
      const sinTocar = await http()
        .patch('/api/v1/users/me')
        .set(auth())
        .send({ heightCm: 175 })
        .expect(200);
      expect((sinTocar.body as Envelope<Me>).data.profile.city).toBe('La Paz');

      // ...pero mandarla en null la vacia.
      const borrada = await http()
        .patch('/api/v1/users/me')
        .set(auth())
        .send({ city: null })
        .expect(200);
      expect((borrada.body as Envelope<Me>).data.profile.city).toBeNull();
    });

    it('rechaza valores imposibles con VALIDATION_ERROR', async () => {
      const res = await http()
        .patch('/api/v1/users/me')
        .set(auth())
        .send({ weightGrams: 5 })
        .expect(400);

      expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    });

    it('no deja quedarse con el email de otra cuenta', async () => {
      const otro = `${marca}-otro@test.com`;
      await http()
        .post('/api/v1/auth/register')
        .send({ email: otro, password, name: 'Otro', deviceId: `${marca}-dev2` })
        .expect(201);

      const res = await http()
        .patch('/api/v1/users/me')
        .set(auth())
        .send({ email: otro })
        .expect(409);

      expect((res.body as ErrorBody).error.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('cambiar el email desverifica la cuenta', async () => {
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });

      const res = await http()
        .patch('/api/v1/users/me')
        .set(auth())
        .send({ email: `${marca}-nuevo@test.com` })
        .expect(200);

      const { data } = res.body as Envelope<Me>;
      expect(data.email).toBe(`${marca}-nuevo@test.com`);
      expect(data.emailVerifiedAt).toBeNull();
    });
  });

  // ─── Avatar ──────────────────────────────────────────────────────────────

  describe('POST /users/me/avatar', () => {
    it('acepta un PNG, lo recorta a cuadrado y lo guarda como WebP', async () => {
      const png = await sharp({
        create: { width: 1200, height: 600, channels: 3, background: '#2f6f4f' },
      })
        .png()
        .toBuffer();

      const res = await http()
        .post('/api/v1/users/me/avatar')
        .set(auth())
        .attach('file', png, 'foto.png')
        .expect(201);

      const { data } = res.body as Envelope<{ avatarUrl: string }>;
      expect(data.avatarUrl).toMatch(/\/uploads\/avatars\/.+\.webp$/);

      // La URL sale del perfil tambien en GET /users/me.
      const me = await http().get('/api/v1/users/me').set(auth()).expect(200);
      expect((me.body as Envelope<Me>).data.profile.avatarUrl).toBe(data.avatarUrl);

      // En la BD vive la clave, no la URL: mudar de dominio no rompe nada.
      const perfil = await prisma.userProfile.findUnique({ where: { userId } });
      expect(perfil?.avatarUrl).toMatch(/^avatars\//);
      expect(perfil?.avatarUrl).not.toContain('http');
    });

    it('rechaza un archivo que no es una imagen', async () => {
      const res = await http()
        .post('/api/v1/users/me/avatar')
        .set(auth())
        .attach('file', Buffer.from('esto no es una imagen'), 'trampa.png')
        .expect(415);

      expect((res.body as ErrorBody).error.code).toBe('INVALID_IMAGE');
    });

    it('borra el avatar y responde ok aunque no hubiera', async () => {
      await http().delete('/api/v1/users/me/avatar').set(auth()).expect(200);
      await http().delete('/api/v1/users/me/avatar').set(auth()).expect(200);

      const me = await http().get('/api/v1/users/me').set(auth()).expect(200);
      expect((me.body as Envelope<Me>).data.profile.avatarUrl).toBeNull();
    });
  });

  // ─── Preferencias ────────────────────────────────────────────────────────

  describe('GET/PATCH /users/me/preferences', () => {
    it('devuelve los valores por defecto del registro', async () => {
      const res = await http().get('/api/v1/users/me/preferences').set(auth()).expect(200);

      const { data } = res.body as Envelope<{
        units: string;
        theme: string;
        locale: string;
        onboardingSeenAt: string | null;
      }>;
      expect(data.units).toBe('metric');
      expect(data.theme).toBe('system');
      expect(data.locale).toBe('es-BO');
      expect(data.onboardingSeenAt).toBeNull();
    });

    it('mezcla las banderas en vez de reemplazar el objeto entero', async () => {
      await http()
        .patch('/api/v1/users/me/preferences')
        .set(auth())
        .send({ notifications: { push: true, raceReminders: true } })
        .expect(200);

      const res = await http()
        .patch('/api/v1/users/me/preferences')
        .set(auth())
        .send({ theme: 'dark', notifications: { push: false } })
        .expect(200);

      const { data } = res.body as Envelope<{
        theme: string;
        notifications: Record<string, unknown>;
      }>;
      expect(data.theme).toBe('dark');
      expect(data.notifications).toEqual({ push: false, raceReminders: true });
    });

    it('marca el onboarding como visto y no mueve la fecha al repetirlo', async () => {
      const primera = await http()
        .patch('/api/v1/users/me/preferences')
        .set(auth())
        .send({ onboardingSeen: true })
        .expect(200);

      const visto = (primera.body as Envelope<{ onboardingSeenAt: string | null }>).data
        .onboardingSeenAt;
      expect(visto).not.toBeNull();

      const segunda = await http()
        .patch('/api/v1/users/me/preferences')
        .set(auth())
        .send({ onboardingSeen: true })
        .expect(200);

      expect((segunda.body as Envelope<{ onboardingSeenAt: string }>).data.onboardingSeenAt).toBe(
        visto,
      );
    });
  });

  // ─── Salud ───────────────────────────────────────────────────────────────

  describe('GET/PATCH /users/me/health', () => {
    it('guarda lesiones, sueno e hidratacion', async () => {
      const res = await http()
        .patch('/api/v1/users/me/health')
        .set(auth())
        .send({
          injuryFlags: [{ zone: 'rodilla_derecha', since: '2026-03-01', notes: 'Al bajar' }],
          avgSleepMinutes: 420,
          hydrationHabit: 'alta',
        })
        .expect(200);

      const { data } = res.body as Envelope<{
        injuryFlags: { zone: string }[];
        avgSleepMinutes: number | null;
      }>;
      expect(data.injuryFlags).toHaveLength(1);
      expect(data.injuryFlags[0]?.zone).toBe('rodilla_derecha');
      expect(data.avgSleepMinutes).toBe(420);
    });

    it('reemplaza la lista de lesiones entera', async () => {
      const res = await http()
        .patch('/api/v1/users/me/health')
        .set(auth())
        .send({ injuryFlags: [] })
        .expect(200);

      expect((res.body as Envelope<{ injuryFlags: unknown[] }>).data.injuryFlags).toEqual([]);
    });

    it('los datos de salud no viajan en GET /users/me', async () => {
      const res = await http().get('/api/v1/users/me').set(auth()).expect(200);

      expect((res.body as Envelope<Me>).data.profile).not.toHaveProperty('injuryFlags');
    });
  });

  // ─── Zapatillas ──────────────────────────────────────────────────────────

  describe('/users/me/shoes', () => {
    let primeraId: string;
    let segundaId: string;

    it('la primera zapatilla queda como principal sola', async () => {
      const res = await http()
        .post('/api/v1/users/me/shoes')
        .set(auth())
        .send({ brand: 'Asics', model: 'Nimbus 26' })
        .expect(201);

      const { data } = res.body as Envelope<Shoe>;
      primeraId = data.id;
      expect(data.isPrimary).toBe(true);
      expect(data.distanceMeters).toBe(0);
      expect(data.wearAlert).toBe(false);
    });

    it('la segunda no roba el puesto si no se pide', async () => {
      const res = await http()
        .post('/api/v1/users/me/shoes')
        .set(auth())
        .send({ brand: 'Nike', model: 'Pegasus 41', distanceMeters: 120000 })
        .expect(201);

      const { data } = res.body as Envelope<Shoe>;
      segundaId = data.id;
      expect(data.isPrimary).toBe(false);
      expect(data.wearRatio).toBe(0.15);
    });

    it('marcar principal desmarca la anterior', async () => {
      await http()
        .patch(`/api/v1/users/me/shoes/${segundaId}`)
        .set(auth())
        .send({ isPrimary: true })
        .expect(200);

      const res = await http().get('/api/v1/users/me/shoes').set(auth()).expect(200);
      const { data } = res.body as Envelope<Shoe[]>;

      expect(data.filter((z) => z.isPrimary)).toHaveLength(1);
      expect(data[0]?.id).toBe(segundaId);
    });

    it('retirar oculta del listado y saca de principal', async () => {
      await http()
        .patch(`/api/v1/users/me/shoes/${segundaId}`)
        .set(auth())
        .send({ retired: true })
        .expect(200);

      const enUso = await http().get('/api/v1/users/me/shoes').set(auth()).expect(200);
      expect((enUso.body as Envelope<Shoe[]>).data.map((z) => z.id)).toEqual([primeraId]);

      const todas = await http()
        .get('/api/v1/users/me/shoes?includeRetired=true')
        .set(auth())
        .expect(200);
      const retirada = (todas.body as Envelope<Shoe[]>).data.find((z) => z.id === segundaId);
      expect(retirada?.retiredAt).not.toBeNull();
      expect(retirada?.isPrimary).toBe(false);
    });

    it('avisa del desgaste al pasar el umbral', async () => {
      const res = await http()
        .patch(`/api/v1/users/me/shoes/${primeraId}`)
        .set(auth())
        .send({ distanceMeters: 810000 })
        .expect(200);

      expect((res.body as Envelope<Shoe>).data.wearAlert).toBe(true);
    });

    it('no deja tocar las zapatillas de otro usuario', async () => {
      const otro = await http()
        .post('/api/v1/auth/register')
        .send({
          email: `${marca}-ajeno@test.com`,
          password,
          name: 'Ajeno',
          deviceId: `${marca}-dev3`,
        })
        .expect(201);

      const tokenAjeno = (otro.body as Envelope<{ accessToken: string }>).data.accessToken;

      const res = await http()
        .patch(`/api/v1/users/me/shoes/${primeraId}`)
        .set({ Authorization: `Bearer ${tokenAjeno}` })
        .send({ brand: 'Robada' })
        .expect(404);

      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('borra el par', async () => {
      await http().delete(`/api/v1/users/me/shoes/${primeraId}`).set(auth()).expect(200);
      await http().delete(`/api/v1/users/me/shoes/${primeraId}`).set(auth()).expect(404);
    });
  });

  // ─── Highlights ──────────────────────────────────────────────────────────

  describe('GET /users/me/highlights', () => {
    it('devuelve ceros y null cuando no hay entrenamientos', async () => {
      const res = await http().get('/api/v1/users/me/highlights').set(auth()).expect(200);

      const { data } = res.body as Envelope<{
        weekDistanceMeters: number;
        totalWorkouts: number;
        longestWorkout: unknown;
        weekStartsAt: string;
        weekEndsAt: string;
      }>;
      expect(data.weekDistanceMeters).toBe(0);
      expect(data.totalWorkouts).toBe(0);
      expect(data.longestWorkout).toBeNull();

      // La semana es de lunes a lunes, exactamente 7 dias.
      const dias =
        (new Date(data.weekEndsAt).getTime() - new Date(data.weekStartsAt).getTime()) / 86_400_000;
      expect(dias).toBe(7);
    });

    it('suma solo lo de esta semana y saca la carrera mas larga del historial', async () => {
      const ahora = new Date();
      const haceDosMeses = new Date(ahora.getTime() - 60 * 86_400_000);

      await prisma.workout.createMany({
        data: [
          {
            userId,
            clientUuid: `${marca}-w1`,
            startedAt: ahora,
            distanceMeters: 10_000,
            durationSeconds: 3000,
          },
          {
            userId,
            clientUuid: `${marca}-w2`,
            startedAt: ahora,
            distanceMeters: 5_000,
            durationSeconds: 1500,
          },
          {
            userId,
            clientUuid: `${marca}-w3`,
            startedAt: haceDosMeses,
            distanceMeters: 42_195,
            durationSeconds: 15_000,
          },
        ],
      });

      const res = await http().get('/api/v1/users/me/highlights').set(auth()).expect(200);
      const { data } = res.body as Envelope<{
        weekDistanceMeters: number;
        weekWorkouts: number;
        totalDistanceMeters: number;
        totalWorkouts: number;
        longestWorkout: { distanceMeters: number } | null;
      }>;

      expect(data.weekDistanceMeters).toBe(15_000);
      expect(data.weekWorkouts).toBe(2);
      expect(data.totalDistanceMeters).toBe(57_195);
      expect(data.totalWorkouts).toBe(3);
      // La maraton es de hace dos meses: cuenta como la mas larga igual.
      expect(data.longestWorkout?.distanceMeters).toBe(42_195);
    });

    it('ignora los entrenamientos borrados', async () => {
      await prisma.workout.updateMany({
        where: { clientUuid: `${marca}-w3` },
        data: { deletedAt: new Date() },
      });

      const res = await http().get('/api/v1/users/me/highlights').set(auth()).expect(200);
      const { data } = res.body as Envelope<{
        totalWorkouts: number;
        longestWorkout: { distanceMeters: number } | null;
      }>;

      expect(data.totalWorkouts).toBe(2);
      expect(data.longestWorkout?.distanceMeters).toBe(10_000);
    });
  });
  // ─── Borrado de cuenta ───────────────────────────────────────────────────

  describe('DELETE /users/me/data', () => {
    /** Usuario aparte: borrar el de arriba dejaria sin token al resto del archivo. */
    async function cuentaDesechable() {
      const suEmail = `${marca}-borrable-${Math.random().toString(36).slice(2, 8)}@test.com`;
      const res = await http()
        .post('/api/v1/auth/register')
        .send({ email: suEmail, password, name: 'Se Va', deviceId: `${marca}-dev-borrable` })
        .expect(201);

      const { data } = res.body as Envelope<{ accessToken: string; user: { id: string } }>;

      return { token: data.accessToken, id: data.user.id };
    }

    it('borra el usuario y todo lo que cuelga de el', async () => {
      const cuenta = await cuentaDesechable();

      await prisma.shoe.create({
        data: { userId: cuenta.id, brand: 'Nike', model: 'Pegasus', isPrimary: true },
      });
      await prisma.workout.create({
        data: {
          userId: cuenta.id,
          clientUuid: `${marca}-borrable-w1`,
          type: 'free_run',
          startedAt: new Date('2026-05-01T10:00:00Z'),
          endedAt: new Date('2026-05-01T11:00:00Z'),
          durationSeconds: 3600,
          movingSeconds: 3600,
          distanceMeters: 10_000,
        },
      });

      await request(app.getHttpServer())
        .delete('/api/v1/users/me/data')
        .set({ Authorization: `Bearer ${cuenta.token}` })
        .expect(200);

      // La cascada la hace Postgres: si alguna relacion perdiera su
      // `onDelete: Cascade`, el propio DELETE fallaria y esto no llegaria aqui.
      expect(await prisma.user.findUnique({ where: { id: cuenta.id } })).toBeNull();
      expect(await prisma.shoe.count({ where: { userId: cuenta.id } })).toBe(0);
      expect(await prisma.workout.count({ where: { userId: cuenta.id } })).toBe(0);
      expect(await prisma.authSession.count({ where: { userId: cuenta.id } })).toBe(0);
    });

    it('el token que quedo en la calle ya no resuelve a nadie', async () => {
      const cuenta = await cuentaDesechable();

      await request(app.getHttpServer())
        .delete('/api/v1/users/me/data')
        .set({ Authorization: `Bearer ${cuenta.token}` })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set({ Authorization: `Bearer ${cuenta.token}` })
        .expect(404);

      expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('sin token no borra nada', async () => {
      await http().delete('/api/v1/users/me/data').expect(401);
    });
  });
});
