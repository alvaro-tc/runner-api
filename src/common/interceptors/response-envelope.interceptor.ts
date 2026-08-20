import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_ENVELOPE_KEY } from '../decorators/skip-envelope.decorator';
import { buildMeta, Paginated, type ResponseMeta } from '../dto/response-envelope';

export interface Envelope<T> {
  data: T;
  meta: ResponseMeta;
}

/**
 * Envuelve toda respuesta exitosa en `{ data, meta }`.
 *
 * `meta.timestamp` es la hora del servidor: el cliente la usa como referencia
 * para las cuentas regresivas en vez de confiar en el reloj del telefono.
 *
 * Las rutas marcadas con `@SkipEnvelope()` pasan tal cual: sirven HTML u otro
 * formato donde el envoltorio destroza la respuesta.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, Envelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T> | T> {
    // El handler primero y la clase despues: asi una ruta suelta puede salirse
    // del envoltorio sin marcar el controlador entero.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();

    return next
      .handle()
      .pipe(
        map((data) =>
          data instanceof Paginated
            ? { data: data.items as T, meta: { ...buildMeta(req), nextCursor: data.nextCursor } }
            : { data, meta: buildMeta(req) },
        ),
      );
  }
}
