import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AccessTokenPayload, TokenService } from '../token.service';

/** El usuario autenticado, colgado del request por este guard. */
export interface AuthenticatedRequest extends Request {
  user?: AccessTokenPayload;
}

/**
 * Verifica el access token del header `Authorization: Bearer`.
 *
 * ponytail: sin passport ni passport-jwt. Extraer un bearer y verificar un JWT
 * son 20 lineas contra tres dependencias; passport aportaria valor si hubiera
 * varias estrategias (OAuth real), y ese es justamente el momento de meterlo.
 *
 * Se registra como guard GLOBAL: por defecto todo endpoint exige token y hay
 * que marcar explicitamente lo publico con `@Public()`. Al reves — proteger
 * ruta por ruta — cualquier endpoint nuevo nace desprotegido por olvido.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const esPublico = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (esPublico) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extraerBearer(req);

    if (!token) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Falta el token de acceso',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      req.user = await this.tokens.verifyAccessToken(token);
      return true;
    } catch {
      // No se distingue "caducado" de "invalido" en el mensaje, pero el cliente
      // no lo necesita: ante 401 dispara UN refresh y reintenta.
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'El token de acceso no es valido o expiro',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}

function extraerBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;

  const [esquema, valor] = header.split(' ');
  return esquema?.toLowerCase() === 'bearer' && valor ? valor : undefined;
}
