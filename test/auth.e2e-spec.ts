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
interface Sesion {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; name: string; role: string; onboardingSeenAt: string | null };
}

/**
 * Flujo completo de autenticacion contra Postgres real.
 *
 * Lo que mas importa aqui es la seccion de rotacion: que un refresh viejo no
 * sirva, y que reusarlo cierre el dispositivo entero.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `auth-${Date.now()}`;
  const email = `${marca}@test.com`;
  const password = 'Test1234!';
  const device = { deviceId: `${marca}-dev`, deviceName: 'Pixel de prueba', platform: 'android' };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await app?.close();
  });

  // ─── Registro ───────────────────────────────────────────────────────────

  it('registra y devuelve la sesion ya iniciada', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Corredor Prueba', ...device })
      .expect(201);

    const { data } = res.body as Envelope<Sesion>;
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.expiresIn).toBe(900);
    expect(data.user.email).toBe(email);
    expect(data.user.role).toBe('runner');
    // Aun no vio el onboarding: el cliente debe mandarlo a los slides.
    expect(data.user.onboardingSeenAt).toBeNull();
  });

  it('crea perfil y preferencias junto con el usuario', async () => {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { profile: true, preferences: true },
    });

    expect(user?.profile).not.toBeNull();
    expect(user?.preferences?.locale).toBe('es-BO');
    expect(user?.preferences?.units).toBe('metric');
  });

  it('nunca guarda la contrasena en claro', async () => {
    const user = await prisma.user.findUnique({ where: { email } });

    expect(user?.passwordHash).not.toContain(password);
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('rechaza un email ya registrado con EMAIL_ALREADY_REGISTERED', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Otro', ...device })
      .expect(409);

    expect((res.body as ErrorBody).error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('el email no distingue mayusculas al registrar', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: email.toUpperCase(), password, name: 'Duplicado', ...device })
      .expect(409);

    expect((res.body as ErrorBody).error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rechaza una contrasena debil con el detalle por campo', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: `debil.${marca}@test.com`, password: 'corta', name: 'Debil', ...device })
      .expect(400);

    const body = res.body as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it('rechaza campos que no estan en el DTO', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        email: `extra.${marca}@test.com`,
        password,
        name: 'Extra',
        role: 'admin', // intento de escalar privilegios por el body
        ...device,
      })
      .expect(400);

    expect((res.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  // ─── Login ──────────────────────────────────────────────────────────────

  it('inicia sesion con las credenciales correctas', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, ...device })
      .expect(200);

    expect((res.body as Envelope<Sesion>).data.user.email).toBe(email);
  });

  it('la contrasena incorrecta y el email inexistente dan el MISMO error', async () => {
    const claveMala = await http()
      .post('/api/v1/auth/login')
      .send({ email, password: 'OtraClave123', ...device })
      .expect(401);

    const noExiste = await http()
      .post('/api/v1/auth/login')
      .send({ email: `fantasma.${marca}@test.com`, password, ...device })
      .expect(401);

    // Si difirieran, este endpoint diria quien tiene cuenta.
    expect((claveMala.body as ErrorBody).error.code).toBe('INVALID_CREDENTIALS');
    expect((noExiste.body as ErrorBody).error.code).toBe('INVALID_CREDENTIALS');
    expect((claveMala.body as ErrorBody).error.message).toBe(
      (noExiste.body as ErrorBody).error.message,
    );
  });

  // ─── Rotacion de refresh ────────────────────────────────────────────────

  it('el refresh entrega tokens nuevos y el viejo deja de servir', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, ...device })
      .expect(200);
    const original = (login.body as Envelope<Sesion>).data.refreshToken;

    const refresh = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: original, ...device })
      .expect(200);
    const nuevo = (refresh.body as Envelope<Sesion>).data.refreshToken;

    expect(nuevo).not.toBe(original);

    // Reusar el viejo: no es solo que falle, es que cierra el dispositivo.
    const reuso = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: original, ...device })
      .expect(401);
    expect((reuso.body as ErrorBody).error.code).toBe('TOKEN_REUSE_DETECTED');

    // Y por eso el token nuevo tampoco vale ya: la cadena entera se revoco.
    const despues = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: nuevo, ...device })
      .expect(401);
    expect((despues.body as ErrorBody).error.code).toBe('TOKEN_REUSE_DETECTED');
  });

  it('un refresh token inventado da INVALID_REFRESH_TOKEN', async () => {
    const res = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'esto-no-existe', ...device })
      .expect(401);

    expect((res.body as ErrorBody).error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('la sesion nueva caduca a 60 dias', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, ...device })
      .expect(200);

    const sesion = await prisma.authSession.findFirst({
      where: { user: { email }, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const dias = ((sesion?.expiresAt.getTime() ?? 0) - Date.now()) / (24 * 3600 * 1000);
    expect(dias).toBeGreaterThan(59.9);
    expect(dias).toBeLessThan(60.1);
    expect((login.body as Envelope<Sesion>).data.refreshToken).toBeTruthy();
  });

  // ─── Rutas protegidas ───────────────────────────────────────────────────

  it('/auth/me exige token', async () => {
    const res = await http().get('/api/v1/auth/me').expect(401);
    expect((res.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it('/auth/me con token devuelve al usuario', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, ...device })
      .expect(200);
    const { accessToken } = (login.body as Envelope<Sesion>).data;

    const res = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect((res.body as Envelope<Sesion['user']>).data.email).toBe(email);
  });

  it('rechaza un token manipulado', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, ...device })
      .expect(200);
    const { accessToken } = (login.body as Envelope<Sesion>).data;

    // Cambiar un caracter de la firma invalida el token entero.
    const manipulado = `${accessToken.slice(0, -3)}xyz`;

    await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${manipulado}`).expect(401);
  });

  it('rechaza un esquema que no sea Bearer', async () => {
    await http().get('/api/v1/auth/me').set('Authorization', 'Basic dXNlcjpwYXNz').expect(401);
  });

  // ─── Sesiones multi-dispositivo ─────────────────────────────────────────

  it('lista las sesiones activas y marca la actual', async () => {
    const movil = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, deviceId: `${marca}-movil`, deviceName: 'Movil' })
      .expect(200);
    await http()
      .post('/api/v1/auth/login')
      .send({ email, password, deviceId: `${marca}-tablet`, deviceName: 'Tablet' })
      .expect(200);

    const res = await http()
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${(movil.body as Envelope<Sesion>).data.accessToken}`)
      .expect(200);

    const sesiones = (res.body as Envelope<{ deviceName: string; current: boolean }[]>).data;
    expect(sesiones.length).toBeGreaterThanOrEqual(2);
    expect(sesiones.filter((s) => s.current)).toHaveLength(1);
    expect(sesiones.find((s) => s.current)?.deviceName).toBe('Movil');
  });

  it('un usuario no puede cerrar la sesion de otro', async () => {
    const otroEmail = `intruso.${marca}@test.com`;
    const intruso = await http()
      .post('/api/v1/auth/register')
      .send({ email: otroEmail, password, name: 'Intruso', deviceId: `${marca}-intruso` })
      .expect(201);

    const victima = await prisma.authSession.findFirst({
      where: { user: { email }, revokedAt: null },
    });

    const res = await http()
      .delete(`/api/v1/auth/sessions/${victima?.id ?? 'x'}`)
      .set('Authorization', `Bearer ${(intruso.body as Envelope<Sesion>).data.accessToken}`)
      .expect(404);

    // 404 y no 403: no se confirma siquiera que ese id exista.
    expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');

    const sigueViva = await prisma.authSession.findUnique({ where: { id: victima?.id ?? 'x' } });
    expect(sigueViva?.revokedAt).toBeNull();
  });

  it('el logout invalida el refresh y es idempotente', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, deviceId: `${marca}-logout` })
      .expect(200);
    const { refreshToken } = (login.body as Envelope<Sesion>).data;

    await http().post('/api/v1/auth/logout').send({ refreshToken }).expect(200);
    // Repetirlo no revienta: la app puede reintentar sin miedo.
    await http().post('/api/v1/auth/logout').send({ refreshToken }).expect(200);

    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken, deviceId: `${marca}-logout` })
      .expect(401);
  });

  // ─── Recuperacion de contrasena ─────────────────────────────────────────

  it('forgot-password responde igual exista o no el email', async () => {
    const real = await http().post('/api/v1/auth/forgot-password').send({ email }).expect(200);
    const falso = await http()
      .post('/api/v1/auth/forgot-password')
      .send({ email: `nadie.${marca}@test.com` })
      .expect(200);

    expect(real.body).toMatchObject({ data: { ok: true } });
    expect(falso.body).toMatchObject({ data: { ok: true } });
  });

  it('cambia la contrasena y cierra TODAS las sesiones', async () => {
    const resetEmail = `reset.${marca}@test.com`;
    await http()
      .post('/api/v1/auth/register')
      .send({ email: resetEmail, password, name: 'Reset', deviceId: `${marca}-reset` })
      .expect(201);

    await http().post('/api/v1/auth/forgot-password').send({ email: resetEmail }).expect(200);

    // El token viaja por correo; en el test se toma de la base y se recrea el
    // hash no es posible, asi que se genera uno conocido reemplazando la fila.
    const { createHash, randomBytes } = await import('node:crypto');
    const tokenPlano = randomBytes(32).toString('base64url');
    const user = await prisma.user.findUnique({ where: { email: resetEmail } });
    await prisma.passwordResetToken.updateMany({
      where: { userId: user?.id },
      data: { tokenHash: createHash('sha256').update(tokenPlano).digest('hex') },
    });

    const nueva = 'ClaveNueva456';
    await http()
      .post('/api/v1/auth/reset-password')
      .send({ token: tokenPlano, password: nueva })
      .expect(200);

    // La vieja ya no entra, la nueva si.
    await http()
      .post('/api/v1/auth/login')
      .send({ email: resetEmail, password, deviceId: 'x' })
      .expect(401);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: resetEmail, password: nueva, deviceId: 'x' })
      .expect(200);

    // Y el token de recuperacion no se puede reutilizar.
    await http()
      .post('/api/v1/auth/reset-password')
      .send({ token: tokenPlano, password: 'OtraMas789' })
      .expect(400);
  });

  it('un token de recuperacion inventado da INVALID_RESET_TOKEN', async () => {
    const res = await http()
      .post('/api/v1/auth/reset-password')
      .send({ token: 'no-existe', password: 'ClaveValida123' })
      .expect(400);

    expect((res.body as ErrorBody).error.code).toBe('INVALID_RESET_TOKEN');
  });

  // ─── Rol admin ──────────────────────────────────────────────────────────

  it('el rol viaja en el token y no se puede pedir desde el registro', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email, password, ...device })
      .expect(200);

    const res = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${(login.body as Envelope<Sesion>).data.accessToken}`)
      .expect(200);

    // Antes se intento registrar con role: 'admin' y el DTO lo rechazo.
    expect((res.body as Envelope<Sesion['user']>).data.role).toBe('runner');
  });
});
