import { HttpStatus } from '@nestjs/common';
import type { UserRole } from '../../../generated/prisma/enums';
import type { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AdminService } from './admin.service';

/**
 * El techo del rol `organizer`.
 *
 * Se prueba solo esta funcion —sin base ni modulo— porque es la unica que
 * separa "administrar corredores" de una toma de cuenta: resetear la
 * contrasena de un admin es entrar como el. Si se rompe, nada falla a la
 * vista; simplemente el organizador puede mas de lo que debe.
 */
describe('techo del rol organizer', () => {
  // Solo se ejerce un metodo privado y puro: las dependencias no se tocan.
  const admin = Object.create(AdminService.prototype) as AdminService;
  const techo = (actor: UserRole, objetivo?: UserRole, pedido?: UserRole) =>
    (
      admin as unknown as { techoDeOrganizador: (a: UserRole, o?: UserRole, p?: UserRole) => void }
    ).techoDeOrganizador(actor, objetivo, pedido);

  function niega(fn: () => void) {
    try {
      fn();
    } catch (e) {
      const err = e as AppException;
      expect(err.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
      expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
      return;
    }
    throw new Error('deberia haber sido rechazado');
  }

  it('al admin no le pone ningun techo', () => {
    expect(() => techo('admin', 'admin', 'admin')).not.toThrow();
  });

  it('deja al organizador administrar corredores', () => {
    expect(() => techo('organizer', 'runner', 'runner')).not.toThrow();
  });

  it('no lo deja tocar la cuenta de un admin ni la de otro organizador', () => {
    niega(() => techo('organizer', 'admin'));
    niega(() => techo('organizer', 'organizer'));
  });

  it('no lo deja repartir roles que no sean corredor', () => {
    niega(() => techo('organizer', 'runner', 'admin'));
    niega(() => techo('organizer', 'runner', 'organizer'));
  });
});
