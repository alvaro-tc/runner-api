import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessTokenPayload } from '../token.service';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';

/**
 * Inyecta el usuario autenticado en el controlador.
 *
 * `@CurrentUser() user` da el payload entero; `@CurrentUser('sub') userId` da
 * un campo. Los controladores nunca leen `req.user` a mano.
 *
 * Solo se usa en rutas protegidas: si el guard global dejo pasar la peticion
 * sin token (`@Public()`), aqui no hay usuario y el tipo lo refleja.
 */
export const CurrentUser = createParamDecorator(
  (campo: keyof AccessTokenPayload | undefined, ctx: ExecutionContext) => {
    const { user } = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) return undefined;
    return campo ? user[campo] : user;
  },
);
