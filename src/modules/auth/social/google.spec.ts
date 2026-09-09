import { AuthService } from '../auth.service';
import { GoogleVerifier } from './google.verifier';
import { AppException } from '../../../common/errors/app.exception';
import type { PrismaService } from '../../../database/prisma.service';
import type { TokenService } from '../token.service';
import type { MailService } from '../../mail/mail.service';
import type { AppConfigService } from '../../../config/app-config.service';

/**
 * Lo que aqui se prueba no es que Prisma escriba —eso lo cubren los e2e— sino
 * las tres decisiones del login con Google: crear cuenta cuando el correo es
 * nuevo, entrar en la existente cuando ya lo tenia, y no dejar pasar una cuenta
 * borrada. Prisma y el verificador estan simulados.
 */
describe('AuthService.loginWithGoogle', () => {
  const DEVICE = { deviceId: 'dev-1' };
  const IDENTIDAD = { email: 'ana@gmail.com', name: 'Ana Perez' };

  function crear(existente: unknown) {
    const create = jest
      .fn<Promise<Record<string, unknown>>, [{ data: Record<string, unknown> }]>()
      .mockImplementation((args) =>
        Promise.resolve({ id: 'u_nuevo', role: 'runner', preferences: {}, ...args.data }),
      );
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(existente), create },
    } as unknown as PrismaService;

    const emitir = jest
      .fn()
      .mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
    const tokens = { issueForNewSession: emitir } as unknown as TokenService;

    const google = { verify: jest.fn().mockResolvedValue(IDENTIDAD) } as unknown as GoogleVerifier;

    const service = new AuthService(
      prisma,
      tokens,
      {} as MailService,
      {} as AppConfigService,
      google,
    );

    return { service, create, emitir };
  }

  it('crea la cuenta cuando el correo no tenia ninguna', async () => {
    const { service, create } = crear(null);

    const res = await service.loginWithGoogle('id-token', DEVICE);

    expect(create).toHaveBeenCalledTimes(1);
    const datos = create.mock.calls[0]![0].data;
    expect(datos['email']).toBe('ana@gmail.com');
    expect(datos['name']).toBe('Ana Perez');
    // Sin esto la cuenta nueva quedaria encerrada en la pantalla de cambio de
    // contrasena, pidiendo una que nunca existio.
    expect(datos['mustChangePassword']).toBe(false);
    // Nulo, no un hash falso: la cuenta no tiene contrasena y tiene que poder
    // decirlo. Un hash aleatorio dejaria `hasPassword` mintiendo y a estas
    // cuentas atrapadas en "la contrasena actual no es correcta".
    expect(datos['passwordHash']).toBeNull();
    expect(res.user.email).toBe('ana@gmail.com');
    expect(res.user.hasPassword).toBe(false);
  });

  it('entra en la cuenta existente sin crear otra', async () => {
    const { service, create } = crear({
      id: 'u_1',
      email: 'ana@gmail.com',
      ci: null,
      name: 'Ana',
      role: 'runner',
      mustChangePassword: false,
      deletedAt: null,
      preferences: { onboardingSeenAt: null },
    });

    const res = await service.loginWithGoogle('id-token', DEVICE);

    expect(create).not.toHaveBeenCalled();
    expect(res.user.id).toBe('u_1');
  });

  it('rechaza una cuenta borrada en vez de resucitarla', async () => {
    const { service, emitir } = crear({
      id: 'u_1',
      email: 'ana@gmail.com',
      deletedAt: new Date(),
      preferences: null,
    });

    await expect(service.loginWithGoogle('id-token', DEVICE)).rejects.toBeInstanceOf(AppException);
    expect(emitir).not.toHaveBeenCalled();
  });
});

/**
 * El `audience` es lo unico que separa "un token de Google" de "un token de
 * Google para NOSOTROS". Si algun refactor lo deja vacio o en undefined, la API
 * pasa a aceptar el ID token de cualquier aplicacion del mundo y cualquiera
 * entra como quien quiera. Por eso se comprueba aqui y no solo en revision.
 */
describe('GoogleVerifier — audience', () => {
  function crear(ids: string[]) {
    return new GoogleVerifier({ get: () => ids } as unknown as AppConfigService);
  }

  it('sin IDs configurados no verifica nada: responde 503', async () => {
    const verifier = crear([]);

    expect(verifier.enabled).toBe(false);
    await expect(verifier.verify('lo-que-sea')).rejects.toBeInstanceOf(AppException);
  });

  it('pasa TODOS los IDs configurados como audience', async () => {
    const ids = ['web.apps.googleusercontent.com', 'android.apps.googleusercontent.com'];
    const verifier = crear(ids);
    const verifyIdToken = jest
      .fn()
      .mockResolvedValue({ getPayload: () => ({ email: 'ana@gmail.com', email_verified: true }) });
    (verifier as unknown as { client: unknown }).client = { verifyIdToken };

    await verifier.verify('id-token');

    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'id-token', audience: ids });
  });

  it('rechaza un correo que Google no ha verificado', async () => {
    const verifier = crear(['web.apps.googleusercontent.com']);
    (verifier as unknown as { client: unknown }).client = {
      verifyIdToken: jest
        .fn()
        .mockResolvedValue({ getPayload: () => ({ email: 'ana@corp.com', email_verified: false }) }),
    };

    await expect(verifier.verify('id-token')).rejects.toBeInstanceOf(AppException);
  });
});
