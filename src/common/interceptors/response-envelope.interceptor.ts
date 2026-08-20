import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
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
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, Envelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T>> {
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
