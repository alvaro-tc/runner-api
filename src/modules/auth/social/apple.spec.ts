import { generateKeyPairSync, sign, verify, type JsonWebKey } from 'node:crypto';
import { AuthService } from '../auth.service';
import { AppleVerifier } from './apple.verifier';
import { AppleClient } from './apple.client';
import { decodeJwt, sha256Hex } from './apple-jwt';
import { AppException } from '../../../common/errors/app.exception';
import type { PrismaService } from '../../../database/prisma.service';
import type { TokenService } from '../token.service';
import type { MailService } from '../../mail/mail.service';
import type { AppConfigService } from '../../../config/app-config.service';
import type { GoogleVerifier } from './google.verifier';

/**
 * Sign in with Apple, en las tres piezas que decide este servidor:
 *
 * - **Verificar** lo que firma Apple, como pide "Verifying a user": firma con
 *   su clave publica, `nonce`, `iss`, `aud` y `exp`. Se firma de verdad con una
 *   clave RSA generada aqui; lo unico simulado es la descarga de las claves.
 * - **Hablar con la API REST**: el `client_secret` firmado con ES256, el canje
 *   del codigo y la revocacion.
 * - **Decidir de quien es la cuenta**: por `sub`, por email verificado, o
 *   nueva.
 */

const BUNDLE = 'com.tumype.camrun';
const NONCE = 'nonce-sin-hashear-generado-por-la-app';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK: JsonWebKey & { kid: string } = {
  ...rsa.publicKey.export({ format: 'jwk' }),
  kid: 'clave-1',
  alg: 'RS256',
};

function b64(valor: unknown): string {
  return Buffer.from(JSON.stringify(valor)).toString('base64url');
}

/** Un JWT firmado como lo firma Apple. */
function firmar(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'clave-1' },
): string {
  const entrada = `${b64(header)}.${b64(claims)}`;
  const firma = sign('RSA-SHA256', Buffer.from(entrada), rsa.privateKey);
  return `${entrada}.${firma.toString('base64url')}`;
}

function claimsValidos(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ahora = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://appleid.apple.com',
    aud: BUNDLE,
    exp: ahora + 600,
    iat: ahora,
    sub: '001234.abcdef.1234',
    nonce: sha256Hex(NONCE),
    email: 'ana@icloud.com',
    email_verified: 'true',
    is_private_email: 'false',
    ...extra,
  };
}

function config(valores: Record<string, unknown>): AppConfigService {
  return { get: (clave: string) => valores[clave] } as unknown as AppConfigService;
}

class VerifierDePrueba extends AppleVerifier {
  descargas = 0;
  protected override fetchKeys() {
    this.descargas++;
    return Promise.resolve([JWK]);
  }
}

function verifier(ids: string[] = [BUNDLE]): VerifierDePrueba {
  return new VerifierDePrueba(config({ APPLE_CLIENT_IDS: ids }));
}

describe('AppleVerifier — identity token', () => {
  it('acepta un token valido y devuelve la identidad', async () => {
    const identidad = await verifier().verifyIdentityToken(firmar(claimsValidos()), NONCE);

    expect(identidad).toEqual({
      sub: '001234.abcdef.1234',
      email: 'ana@icloud.com',
      emailVerified: true,
      isPrivateEmail: false,
      clientId: BUNDLE,
    });
  });

  it('rechaza un nonce que no es el de esta app: es un token reutilizado', async () => {
    await expect(
      verifier().verifyIdentityToken(firmar(claimsValidos()), 'otro-nonce'),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('rechaza un token emitido para otra app', async () => {
    const token = firmar(claimsValidos({ aud: 'com.otra.app' }));
    await expect(verifier().verifyIdentityToken(token, NONCE)).rejects.toBeInstanceOf(AppException);
  });

  it('rechaza un emisor que no es Apple', async () => {
    const token = firmar(claimsValidos({ iss: 'https://evil.example' }));
    await expect(verifier().verifyIdentityToken(token, NONCE)).rejects.toBeInstanceOf(AppException);
  });

  it('rechaza un token caducado', async () => {
    const token = firmar(claimsValidos({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    await expect(verifier().verifyIdentityToken(token, NONCE)).rejects.toBeInstanceOf(AppException);
  });

  it('rechaza una firma que no es de Apple', async () => {
    const otra = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const entrada = `${b64({ alg: 'RS256', kid: 'clave-1' })}.${b64(claimsValidos())}`;
    const firma = sign('RSA-SHA256', Buffer.from(entrada), otra.privateKey).toString('base64url');

    await expect(
      verifier().verifyIdentityToken(`${entrada}.${firma}`, NONCE),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('no acepta el `alg` que diga el propio token', async () => {
    const sinFirma = `${b64({ alg: 'none', kid: 'clave-1' })}.${b64(claimsValidos())}.`;
    await expect(verifier().verifyIdentityToken(sinFirma, NONCE)).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('sin client IDs no verifica nada: responde 503', async () => {
    const sinConfigurar = verifier([]);
    expect(sinConfigurar.enabled).toBe(false);
    await expect(
      sinConfigurar.verifyIdentityToken(firmar(claimsValidos()), NONCE),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('reutiliza las claves de Apple en vez de pedirlas en cada login', async () => {
    const v = verifier();
    await v.verifyIdentityToken(firmar(claimsValidos()), NONCE);
    await v.verifyIdentityToken(firmar(claimsValidos()), NONCE);
    expect(v.descargas).toBe(1);
  });
});

describe('AppleVerifier — notificaciones servidor a servidor', () => {
  it('lee el evento aunque `events` llegue como texto JSON', async () => {
    const payload = firmar({
      iss: 'https://appleid.apple.com',
      aud: BUNDLE,
      iat: Math.floor(Date.now() / 1000),
      jti: 'abc',
      events: JSON.stringify({ type: 'consent-revoked', sub: 'sub-1', event_time: 1 }),
    });

    await expect(verifier().verifyNotification(payload)).resolves.toEqual({
      type: 'consent-revoked',
      sub: 'sub-1',
      email: null,
    });
  });

  it('rechaza una notificacion para otra app', async () => {
    const payload = firmar({
      iss: 'https://appleid.apple.com',
      aud: 'com.otra.app',
      events: { type: 'account-deleted', sub: 'sub-1' },
    });
    await expect(verifier().verifyNotification(payload)).rejects.toBeInstanceOf(AppException);
  });
});

describe('AppleClient — API REST de Apple', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const PEM = ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  class ClienteDePrueba extends AppleClient {
    llamadas: { url: string; form: Record<string, string> }[] = [];
    respuesta = { status: 200, body: { refresh_token: 'r-apple' } as Record<string, unknown> };
    protected override post(url: string, form: Record<string, string>) {
      this.llamadas.push({ url, form });
      return Promise.resolve(this.respuesta);
    }
  }

  function cliente(conClave = true): ClienteDePrueba {
    return new ClienteDePrueba(
      config(
        conClave
          ? { APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: PEM }
          : {},
      ),
    );
  }

  it('firma el client_secret con ES256 como pide Apple', () => {
    const secreto = cliente().clientSecret(BUNDLE);
    const partes = decodeJwt(secreto)!;

    expect(partes.header).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(partes.payload).toMatchObject({
      iss: 'TEAM123456',
      aud: 'https://appleid.apple.com',
      sub: BUNDLE,
    });
    expect(
      verify(
        'sha256',
        Buffer.from(partes.signingInput),
        {
          key: ec.publicKey,
          dsaEncoding: 'ieee-p1363',
        },
        partes.signature,
      ),
    ).toBe(true);
  });

  it('canjea el codigo de autorizacion por el refresh token', async () => {
    const c = cliente();

    await expect(c.exchangeCode('codigo-1', BUNDLE)).resolves.toBe('r-apple');
    expect(c.llamadas[0]!.url).toBe(AppleClient.TOKEN_URL);
    expect(c.llamadas[0]!.form).toMatchObject({
      client_id: BUNDLE,
      code: 'codigo-1',
      grant_type: 'authorization_code',
    });
  });

  it('un canje rechazado no tumba el login: devuelve null', async () => {
    const c = cliente();
    c.respuesta = { status: 400, body: { error: 'invalid_grant' } };
    await expect(c.exchangeCode('codigo-usado', BUNDLE)).resolves.toBeNull();
  });

  it('revoca el refresh token con su client_id', async () => {
    const c = cliente();
    c.respuesta = { status: 200, body: {} };

    await expect(c.revoke('r-apple', BUNDLE)).resolves.toBe(true);
    expect(c.llamadas[0]!.url).toBe(AppleClient.REVOKE_URL);
    expect(c.llamadas[0]!.form).toMatchObject({
      client_id: BUNDLE,
      token: 'r-apple',
      token_type_hint: 'refresh_token',
    });
  });

  it('sin las credenciales del equipo no llama a Apple', async () => {
    const c = cliente(false);
    await expect(c.exchangeCode('codigo', BUNDLE)).resolves.toBeNull();
    await expect(c.revoke('r', BUNDLE)).resolves.toBe(false);
    expect(c.llamadas).toHaveLength(0);
  });
});

describe('AuthService.loginWithApple', () => {
  const DEVICE = { deviceId: 'dev-1' };
  const DTO = {
    deviceId: 'dev-1',
    identityToken: 'token',
    authorizationCode: 'codigo',
    nonce: NONCE,
  };
  const IDENTIDAD = {
    sub: 'sub-apple',
    email: 'ana@icloud.com',
    emailVerified: true,
    isPrivateEmail: false,
    clientId: BUNDLE,
  };

  function usuario(extra: Record<string, unknown> = {}) {
    return {
      id: 'u_1',
      email: 'ana@icloud.com',
      ci: null,
      name: 'Ana',
      role: 'runner',
      mustChangePassword: false,
      passwordHash: null,
      appleSub: null,
      deletedAt: null,
      preferences: { onboardingSeenAt: null },
      ...extra,
    };
  }

  function crear({
    porSub = null,
    porEmail = null,
    identidad = IDENTIDAD,
    refresh = 'r-apple',
  }: {
    porSub?: ReturnType<typeof usuario> | null;
    porEmail?: ReturnType<typeof usuario> | null;
    identidad?: typeof IDENTIDAD;
    refresh?: string | null;
  } = {}) {
    const findUnique = jest.fn((args: { where: Record<string, unknown> }) =>
      Promise.resolve('appleSub' in args.where ? porSub : porEmail),
    );
    const create = jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(usuario({ id: 'u_nuevo', ...args.data })),
    );
    const update = jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve(
        usuario({
          ...(porSub ?? porEmail ?? {}),
          id: args.where.id,
          ...args.data,
        }),
      ),
    );
    const prisma = { user: { findUnique, create, update } } as unknown as PrismaService;

    const emitir = jest
      .fn()
      .mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
    const tokens = { issueForNewSession: emitir } as unknown as TokenService;
    const apple = {
      verifyIdentityToken: jest.fn().mockResolvedValue(identidad),
    } as unknown as AppleVerifier;
    const exchangeCode = jest.fn().mockResolvedValue(refresh);
    const appleClient = { exchangeCode } as unknown as AppleClient;

    const service = new AuthService(
      prisma,
      tokens,
      {} as MailService,
      {} as AppConfigService,
      {} as GoogleVerifier,
      apple,
      appleClient,
    );
    return { service, create, update, emitir, exchangeCode };
  }

  it('crea la cuenta con el nombre que Apple mando la primera vez', async () => {
    const { service, create } = crear();

    const res = await service.loginWithApple(
      { ...DTO, givenName: 'Ana', familyName: 'Perez' },
      DEVICE,
    );

    const datos = create.mock.calls[0]![0].data;
    expect(datos['name']).toBe('Ana Perez');
    expect(datos['appleSub']).toBe('sub-apple');
    // Apple pide no pedir contrasena: la cuenta no tiene y lo dice.
    expect(datos['passwordHash']).toBeNull();
    expect(datos['mustChangePassword']).toBe(false);
    expect(res.user.hasApple).toBe(true);
    expect(res.user.hasPassword).toBe(false);
  });

  it('con correo oculto y sin nombre no usa la parte aleatoria del relay', async () => {
    const { service, create } = crear({
      identidad: {
        ...IDENTIDAD,
        email: 'x7f3k2pq9z@privaterelay.appleid.com',
        isPrivateEmail: true,
      },
    });

    await service.loginWithApple(DTO, DEVICE);

    expect(create.mock.calls[0]![0].data['name']).toBe('Corredor');
  });

  it('guarda el refresh token canjeado: es lo que se revoca al borrar la cuenta', async () => {
    const { service, update, exchangeCode } = crear();

    await service.loginWithApple(DTO, DEVICE);

    expect(exchangeCode).toHaveBeenCalledWith('codigo', BUNDLE);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      appleRefreshToken: 'r-apple',
      appleClientId: BUNDLE,
    });
  });

  it('entra en la cuenta ya vinculada por `sub` sin crear otra', async () => {
    const { service, create } = crear({ porSub: usuario({ appleSub: 'sub-apple' }) });

    const res = await service.loginWithApple(DTO, DEVICE);

    expect(create).not.toHaveBeenCalled();
    expect(res.user.id).toBe('u_1');
  });

  it('vincula la cuenta existente con el mismo correo verificado', async () => {
    const { service, create, update } = crear({
      porEmail: usuario({ passwordHash: 'hash' }),
    });

    const res = await service.loginWithApple(DTO, DEVICE);

    expect(create).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0].data['appleSub']).toBe('sub-apple');
    expect(res.user.hasApple).toBe(true);
    expect(res.user.hasPassword).toBe(true);
  });

  it('no vincula por un correo que Apple no verifico', async () => {
    const { service, create } = crear({
      porEmail: usuario(),
      identidad: { ...IDENTIDAD, emailVerified: false },
    });

    await service.loginWithApple(DTO, DEVICE);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('no le cambia el dueno a una cuenta de otra Apple Account', async () => {
    const { service, emitir } = crear({ porEmail: usuario({ appleSub: 'otro-sub' }) });

    await expect(service.loginWithApple(DTO, DEVICE)).rejects.toMatchObject({ status: 409 });
    expect(emitir).not.toHaveBeenCalled();
  });

  it('rechaza una cuenta borrada en vez de resucitarla', async () => {
    const { service, emitir } = crear({ porSub: usuario({ deletedAt: new Date() }) });

    await expect(service.loginWithApple(DTO, DEVICE)).rejects.toBeInstanceOf(AppException);
    expect(emitir).not.toHaveBeenCalled();
  });

  it('si el canje falla entra igual, sin pisar el token anterior', async () => {
    const { service, update, emitir } = crear({
      porSub: usuario({ appleSub: 'sub-apple' }),
      refresh: null,
    });

    await service.loginWithApple(DTO, DEVICE);

    expect(update.mock.calls[0]![0].data).toEqual({ appleSub: 'sub-apple' });
    expect(emitir).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService.handleAppleNotification', () => {
  function crear(existe = true, tipo = 'consent-revoked') {
    type Llamada = { where: Record<string, unknown>; data: Record<string, unknown> };
    const update = jest.fn<string, [Llamada]>().mockReturnValue('update');
    const updateMany = jest.fn<string, [Llamada]>().mockReturnValue('updateMany');
    const $transaction = jest.fn().mockResolvedValue([]);
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(existe ? { id: 'u_1' } : null), update },
      authSession: { updateMany },
      $transaction,
    } as unknown as PrismaService;
    const apple = {
      verifyNotification: jest
        .fn()
        .mockResolvedValue({ type: tipo, sub: 'sub-apple', email: null }),
    } as unknown as AppleVerifier;

    const service = new AuthService(
      prisma,
      {} as TokenService,
      {} as MailService,
      {} as AppConfigService,
      {} as GoogleVerifier,
      apple,
      {} as AppleClient,
    );
    return { service, update, updateMany, $transaction };
  }

  it('consent-revoked cierra sus sesiones y olvida el token, pero conserva el sub', async () => {
    const { service, update, updateMany, $transaction } = crear();

    await expect(service.handleAppleNotification('jws')).resolves.toEqual({ ok: true });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].data).toEqual({
      appleRefreshToken: null,
      appleClientId: null,
    });
    expect(updateMany.mock.calls[0]![0].where).toMatchObject({ userId: 'u_1', revokedAt: null });
  });

  it('account-deleted ademas desvincula: ese sub no vuelve', async () => {
    const { service, update } = crear(true, 'account-deleted');

    await service.handleAppleNotification('jws');

    expect(update.mock.calls[0]![0].data).toMatchObject({ appleSub: null });
  });

  it('un sub desconocido responde ok para que Apple no reintente', async () => {
    const { service, $transaction } = crear(false);

    await expect(service.handleAppleNotification('jws')).resolves.toEqual({ ok: true });
    expect($transaction).not.toHaveBeenCalled();
  });
});
