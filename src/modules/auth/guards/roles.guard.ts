import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../../../../generated/prisma/enums';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Exige un rol concreto. Corre DESPUES de `JwtAuthGuard`, que es quien deja
 * `req.user` puesto.
 *
 * El rol se lee del token, no de la base: por eso el access token dura solo 15
 * minutos. Degradar a alguien de admin a runner surte efecto en ese plazo, o de
 * inmediato si se revocan sus sesiones.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requeridos = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requeridos?.length) return true;

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!user || !requeridos.includes(user.role)) {
      throw new AppException(
        ErrorCode.INSUFFICIENT_ROLE,
        'No tenes permisos para esta operacion',
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}
