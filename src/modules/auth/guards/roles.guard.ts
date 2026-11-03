import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PERMISOS_KEY } from '../decorators/roles.decorator';
import { PermisosService } from '../permisos.service';
import { PrismaService } from '../../../database/prisma.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Exige los permisos de `@Permiso`. Corre DESPUES de `JwtAuthGuard`, que deja
 * `req.user` puesto.
 *
 * El rol se lee del token (dura 15 minutos) y sus permisos de la tabla `roles`
 * (en memoria, ver `PermisosService`): editar la matriz surte efecto en el acto;
 * cambiarle el rol a alguien, cuando renueva el token.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permisos: PermisosService,
    private readonly prisma?: PrismaService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requeridos = this.reflector.getAllAndOverride<string[]>(PERMISOS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requeridos?.length) return true;

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tiene = this.permisos.de(user?.role);
    // Sin excepciones por rol: ni admin pasa sin el permiso.
    const ok = !!user && requeridos.every((p) => tiene.includes(p));

    if (!ok) {
      // Un intento denegado es lo primero que mira un auditor. Va aqui porque
      // el interceptor de auditoria corre despues de los guards y no lo veria.
      const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
      this.prisma?.auditLog
        .create({
          data: {
            actorId: user?.sub ?? null,
            actorRole: user?.role ?? null,
            method: req.method,
            route: String((req.route as { path?: string } | undefined)?.path ?? req.path).replace(/^\/api\/v\d+/, ''),
            targetId: [req.params?.id, req.params?.key].find((v) => typeof v === 'string') ?? null,
            status: HttpStatus.FORBIDDEN,
            detail: { denegado: requeridos.filter((p) => !tiene.includes(p)) },
            ip: req.ip ?? null,
          },
        })
        .catch(() => undefined);
      throw new AppException(
        ErrorCode.INSUFFICIENT_ROLE,
        'No tenes permisos para esta operacion',
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}
