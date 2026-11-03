import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

const SECRETO = /pass|token|secret|clave/i;

/** El cuerpo sin secretos: una contrasena en el registro de auditoria seria una fuga mas. */
export function sinSecretos(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.slice(0, 50).map(sinSecretos);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, SECRETO.test(k) ? '••••' : sinSecretos(v)]),
    );
  }
  return typeof valor === 'string' && valor.length > 500 ? `${valor.slice(0, 500)}…` : valor;
}

/**
 * Anota en `audit_logs` cada escritura del panel, haya salido bien o mal: un
 * intento rechazado (403) es justo lo que un auditor quiere ver.
 *
 * Las lecturas no se anotan: serian miles de filas por dia sin decir nada de
 * quien cambio que.
 * ponytail: escritura fuera del request y sin cola; si el volumen crece, mandarla a una cola (BullMQ ya esta).
 */
@Injectable()
export class AuditoriaInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditoriaInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next.handle();

    const anotar = (status: number) => {
      const params = req.params ?? {};
      const route = String((req.route as { path?: string } | undefined)?.path ?? req.path).replace(/^\/api\/v\d+/, '');
      this.prisma.auditLog
        .create({
          data: {
            actorId: req.user?.sub ?? null,
            actorRole: req.user?.role ?? null,
            method: req.method,
            route,
            targetId: [params.id, params.key, params.categoryId, params.extraId].find((v) => typeof v === 'string') ?? null,
            status,
            detail: (sinSecretos(req.body) ?? undefined),
            ip: req.ip ?? null,
          },
        })
        .catch((e: Error) => this.logger.error(`No se pudo auditar ${req.method} ${route}: ${e.message}`));
    };

    return next.handle().pipe(
      tap({
        next: () => anotar(context.switchToHttp().getResponse<Response>().statusCode),
        error: (e: unknown) => anotar(e instanceof HttpException ? e.getStatus() : 500),
      }),
    );
  }
}
