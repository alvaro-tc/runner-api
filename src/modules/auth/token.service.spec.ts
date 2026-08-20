import { HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AppConfigService } from '../../config/app-config.service';
import type { PrismaService } from '../../database/prisma.service';

/**
 * Tests unitarios de la rotacion de refresh tokens: la pieza donde un error no
 * se ve en la UI pero deja la sesion tomable. Prisma esta simulado a proposito
 * — lo que se prueba aqui es la LOGICA de rotacion, no que Postgres escriba.
 */
describe('TokenService — rotacion de refresh tokens', () => {
  const CONFIG = {
    ACCESS_TOKEN_TTL_MINUTES: 15,
    REFRESH_TOKEN_TTL_DAYS: 60,
  } as const;

  const config = {
    get: (k: keyof typeof CONFIG) => CONFIG[k],
  } as unknown as AppConfigService;

  const jwt = new JwtService({ secret: 'secreto-de-prueba-con-mas-de-32-caracteres' });

  /** Argumentos con los que `TokenService` llama a `authSession.create`. */
  interface CreateArgs {
    data: {
      refreshTokenHash: string;
      rotatedFromId?: string;
      expiresAt: Date;
    };
  }

  /** Doble de Prisma con lo justo que toca `TokenService`. */
  function crearPrisma(sesion: unknown) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue({});
    const create = jest
      .fn<Promise<{ id: string }>, [CreateArgs]>()
      .mockImplementation((args) => Promise.resolve({ id: 'sesion-nueva', ...args.data }));
    const findUnique = jest.fn().mockResolvedValue(sesion);

    const prisma = {
      authSession: { findUnique, create, update, updateMany },
      $transaction: (fn: (tx: unknown) => unknown) =>
        Promise.resolve(fn({ authSession: { update, create } })),
    } as unknown as PrismaService;

    return { prisma, findUnique, create, update, updateMany };
  }

  const sesionValida = {
    id: 'sesion-1',
    userId: 'user-1',
    deviceId: 'device-1',
    deviceName: 'Pixel',
    platform: 'android',
    ip: '1.2.3.4',
    userAgent: 'test',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
    user: { id: 'user-1', role: 'runner' as const, deletedAt: null },
  };

  const device = { deviceId: 'device-1' };

  it('rota: revoca el token usado y emite uno distinto', async () => {
    const { prisma, create, update } = crearPrisma(sesionValida);
    const service = new TokenService(prisma, jwt, config);

    const par = await service.rotate('refresh-viejo', device);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sesion-1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(create).toHaveBeenCalled();
    expect(par.refreshToken).not.toBe('refresh-viejo');
    expect(par.accessToken).toBeTruthy();
    expect(par.expiresIn).toBe(900);
  });

  it('la nueva sesion apunta a la anterior, formando la cadena', async () => {
    const { prisma, create } = crearPrisma(sesionValida);
    const service = new TokenService(prisma, jwt, config);

    await service.rotate('refresh-viejo', device);

    const args = create.mock.calls[0]?.[0];
    expect(args).toBeDefined();
    expect(args?.data.rotatedFromId).toBe('sesion-1');
  });

  it('la ventana de 60 dias se recalcula desde AHORA, no desde el login', async () => {
    const casiVencida = {
      ...sesionValida,
      expiresAt: new Date(Date.now() + 2 * 24 * 3600 * 1000), // le quedaban 2 dias
    };
    const { prisma, create } = crearPrisma(casiVencida);
    const service = new TokenService(prisma, jwt, config);

    await service.rotate('refresh-viejo', device);

    const args = create.mock.calls[0]?.[0];
    const diasRestantes = ((args?.data.expiresAt.getTime() ?? 0) - Date.now()) / (24 * 3600 * 1000);
    expect(diasRestantes).toBeGreaterThan(59.9);
  });

  it('guarda el hash del refresh, nunca el token en claro', async () => {
    const { prisma, create } = crearPrisma(sesionValida);
    const service = new TokenService(prisma, jwt, config);

    const par = await service.rotate('refresh-viejo', device);

    const hash = create.mock.calls[0]?.[0]?.data.refreshTokenHash;
    expect(hash).toBe(service.hashRefreshToken(par.refreshToken));
    expect(hash).not.toBe(par.refreshToken);
    expect(hash).toHaveLength(64); // sha256 en hex
  });

  it('un token ya rotado dispara TOKEN_REUSE_DETECTED y revoca el dispositivo entero', async () => {
    const yaRotada = { ...sesionValida, revokedAt: new Date() };
    const { prisma, updateMany } = crearPrisma(yaRotada);
    const service = new TokenService(prisma, jwt, config);

    await expect(service.rotate('refresh-robado', device)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_REUSE_DETECTED,
    });

    // Lo importante: no basta con rechazar, hay que cerrar TODO el dispositivo,
    // porque el atacante podria tener tambien el token vigente.
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', deviceId: 'device-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('un token inexistente da INVALID_REFRESH_TOKEN, no reuso', async () => {
    const { prisma, updateMany } = crearPrisma(null);
    const service = new TokenService(prisma, jwt, config);

    await expect(service.rotate('inventado', device)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFRESH_TOKEN,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('un token vencido se rechaza aunque la sesion no este revocada', async () => {
    const vencida = { ...sesionValida, expiresAt: new Date(Date.now() - 1000) };
    const { prisma, create } = crearPrisma(vencida);
    const service = new TokenService(prisma, jwt, config);

    await expect(service.rotate('viejisimo', device)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFRESH_TOKEN,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('un usuario borrado no puede refrescar', async () => {
    const deBorrado = { ...sesionValida, user: { ...sesionValida.user, deletedAt: new Date() } };
    const { prisma } = crearPrisma(deBorrado);
    const service = new TokenService(prisma, jwt, config);

    await expect(service.rotate('refresh', device)).rejects.toBeInstanceOf(AppException);
  });

  it('los errores de refresh son 401, para que el cliente sepa volver a Welcome', async () => {
    const { prisma } = crearPrisma(null);
    const service = new TokenService(prisma, jwt, config);

    await service.rotate('inventado', device).catch((err: AppException) => {
      expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });
    expect.hasAssertions();
  });

  it('el access token lleva sub, role y sessionId, y nada mas', async () => {
    const { prisma } = crearPrisma(sesionValida);
    const service = new TokenService(prisma, jwt, config);

    const par = await service.rotate('refresh-viejo', device);
    const payload = jwt.decode<Record<string, unknown>>(par.accessToken);

    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe('runner');
    expect(payload.sessionId).toBe('sesion-nueva');
    // Nada de email ni nombre: el JWT viaja en cada peticion y no se cifra.
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'role', 'sessionId', 'sub']);
  });

  it('dos refresh tokens seguidos nunca coinciden', async () => {
    const { prisma } = crearPrisma(sesionValida);
    const service = new TokenService(prisma, jwt, config);

    const a = await service.rotate('r1', device);
    const b = await service.rotate('r2', device);

    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(a.refreshToken.length).toBeGreaterThanOrEqual(43); // 32 bytes en base64url
  });
});
