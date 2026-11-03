import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import type { PermisosService } from '../permisos.service';
import { permisosEfectivos } from '../permisos';

/**
 * El guard decide quien entra al panel. Si falla, no da error: da acceso. Por
 * eso se prueba cada borde: sin permiso exigido, el candado `*`, y un rol
 * creado en el panel con solo lectura.
 */
describe('RolesGuard (permisos)', () => {
  const reflector = new Reflector();
  const matriz: Record<string, string[]> = {
    admin: ['carreras.ver', 'carreras.editar', 'config.gestionar'],
    organizer: ['carreras.ver', 'cobros.ver', 'cobros.validar'],
    veedor: ['carreras.ver', 'inscritas.ver'],
  };
  const permisos = { de: (r?: string) => (r ? permisosEfectivos(matriz[r]) : []) } as unknown as PermisosService;

  function contexto(user?: { role: string }): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  function guard(requeridos: string[] | undefined) {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requeridos);
    return new RolesGuard(reflector, permisos);
  }

  afterEach(() => jest.restoreAllMocks());

  it('deja pasar cuando el endpoint no exige nada', () => {
    expect(guard(undefined).canActivate(contexto({ role: 'runner' }))).toBe(true);
    expect(guard([]).canActivate(contexto({ role: 'runner' }))).toBe(true);
  });

  it('el candado NADIE no lo abre ningun rol, tampoco admin', () => {
    expect(() => guard(['nadie']).canActivate(contexto({ role: 'admin' }))).toThrow();
    expect(() => guard(['nadie']).canActivate(contexto({ role: 'organizer' }))).toThrow();
  });

  // Sin superusuario: lo que no esta en la tabla, admin tampoco lo tiene.
  it('admin solo pasa con los permisos que tiene en la tabla', () => {
    expect(guard(['carreras.editar']).canActivate(contexto({ role: 'admin' }))).toBe(true);
    expect(() => guard(['roles.gestionar']).canActivate(contexto({ role: 'admin' }))).toThrow();
  });

  it('un veedor ve inscritas pero no las exporta ni edita carreras', () => {
    expect(guard(['inscritas.ver']).canActivate(contexto({ role: 'veedor' }))).toBe(true);
    expect(() => guard(['inscritas.exportar']).canActivate(contexto({ role: 'veedor' }))).toThrow();
    expect(() => guard(['carreras.editar']).canActivate(contexto({ role: 'veedor' }))).toThrow();
  });

  it('exige todos los permisos pedidos', () => {
    expect(guard(['cobros.ver', 'cobros.validar']).canActivate(contexto({ role: 'organizer' }))).toBe(true);
    expect(() => guard(['cobros.ver', 'roles.asignar']).canActivate(contexto({ role: 'organizer' }))).toThrow();
  });

  it('bloquea a un runner y a una peticion sin usuario', () => {
    expect(() => guard(['carreras.ver']).canActivate(contexto({ role: 'runner' }))).toThrow();
    expect(() => guard(['carreras.ver']).canActivate(contexto(undefined))).toThrow();
  });
});
