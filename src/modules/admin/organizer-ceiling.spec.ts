import { HttpStatus } from '@nestjs/common';
import type { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { permisosEfectivos } from '../auth/permisos';
import { AdminService } from './admin.service';

/**
 * El techo de quien administra cuentas.
 *
 * Es lo unico que separa "atender corredoras" de una toma de cuenta: resetear
 * la contrasena de un admin es entrar como el. Si se rompe, nada falla a la
 * vista; simplemente alguien puede mas de lo que debe.
 */
describe('techo de usuarios.gestionar / roles.asignar', () => {
  const matriz: Record<string, string[]> = {
    admin: ['usuarios.ver', 'usuarios.gestionar', 'carreras.editar'],
    organizer: ['usuarios.ver', 'usuarios.gestionar'],
    osi: ['usuarios.ver', 'usuarios.gestionar', 'roles.asignar', 'roles.gestionar'],
  };
  const roles = new Set(['runner', 'organizer', 'osi', 'admin', 'veedor']);
  const admin = Object.assign(Object.create(AdminService.prototype) as object, {
    permisos: { tiene: (r: string, p: string) => permisosEfectivos(matriz[r]).includes(p) },
    prisma: { role: { findUnique: ({ where }: { where: { key: string } }) => Promise.resolve(roles.has(where.key) ? { key: where.key } : null) } },
  }) as unknown as AdminService;
  const techo = (actor: string, objetivo?: string, pedido?: string) =>
    (admin as unknown as { techoDeRol: (a: string, o?: string, p?: string) => Promise<void> }).techoDeRol(actor, objetivo, pedido);

  async function niega(p: Promise<void>, code: string = ErrorCode.INSUFFICIENT_ROLE) {
    const err = (await p.then(() => null, (e: unknown) => e)) as AppException | null;
    expect(err).not.toBeNull();
    expect(err!.code).toBe(code);
  }

  // Admin no es superusuario: sin roles.asignar tiene el mismo techo que cualquiera.
  it('a un admin sin roles.asignar tambien le pone techo', async () => {
    await expect(techo('admin', 'runner', 'runner')).resolves.toBeUndefined();
    await niega(techo('admin', 'runner', 'admin'));
    await niega(techo('admin', 'osi'));
  });

  it('deja al organizador administrar corredoras', async () => {
    await expect(techo('organizer', 'runner', 'runner')).resolves.toBeUndefined();
  });

  it('no deja al organizador tocar cuentas del equipo ni repartir roles', async () => {
    await niega(techo('organizer', 'admin'));
    await niega(techo('organizer', 'veedor'));
    await niega(techo('organizer', 'runner', 'admin'));
    await niega(techo('organizer', 'runner', 'veedor'));
  });

  it('el osi (roles.asignar) reparte cualquier rol, incluido admin', async () => {
    await expect(techo('osi', 'runner', 'admin')).resolves.toBeUndefined();
    await expect(techo('osi', 'admin', 'veedor')).resolves.toBeUndefined();
  });

  it('rechaza un rol que no existe', async () => {
    const err = (await techo('osi', 'runner', 'inventado').then(() => null, (e: unknown) => e)) as AppException;
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });
});
