import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { AppException } from '../../../common/errors/app.exception';
import type { UserRole } from '../../../../generated/prisma/enums';

/**
 * El guard de roles todavia no protege ningun endpoint — el primero llegara con
 * `/admin/*`. Se prueba ahora igualmente porque cuando ese endpoint exista, el
 * fallo seria silencioso: un panel de administracion abierto no da error, da
 * acceso.
 */
describe('RolesGuard', () => {
  const reflector = new Reflector();

  function contexto(user?: { role: UserRole }): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  function guardConRoles(roles: UserRole[] | undefined) {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
    return new RolesGuard(reflector);
  }

  afterEach(() => jest.restoreAllMocks());

  it('deja pasar cuando el endpoint no exige ningun rol', () => {
    expect(guardConRoles(undefined).canActivate(contexto({ role: 'runner' }))).toBe(true);
  });

  it('deja pasar al admin en un endpoint de admin', () => {
    expect(guardConRoles(['admin']).canActivate(contexto({ role: 'admin' }))).toBe(true);
  });

  it('bloquea al runner en un endpoint de admin', () => {
    const guard = guardConRoles(['admin']);

    expect(() => guard.canActivate(contexto({ role: 'runner' }))).toThrow();

    try {
      guard.canActivate(contexto({ role: 'runner' }));
    } catch (err) {
      const e = err as AppException;
      expect(e.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
      expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
    expect.hasAssertions();
  });

  it('bloquea si no hay usuario, aunque el guard de JWT haya fallado en ponerlo', () => {
    // Cinturon y tirantes: este guard nunca asume que el anterior hizo su parte.
    expect(() => guardConRoles(['admin']).canActivate(contexto(undefined))).toThrow();
  });
});
