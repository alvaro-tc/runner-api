import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { IngestRequest } from './ingest-token.guard';

/**
 * Rate limit de la ingesta contado **por sesion**, no por IP.
 *
 * Por IP no sirve aqui: media maraton entera sale por la misma red movil con la
 * misma IP publica, asi que un limite por IP o deja pasar a un cliente roto o
 * corta a doscientos corredores legitimos a la vez. La sesion es la unidad
 * natural — un corredor, un dispositivo, un flujo de puntos— y ademas ya viene
 * resuelta por `IngestTokenGuard`, que corre antes.
 *
 * El limite se calibra con `TRACKING_INGEST_BATCHES_PER_MINUTE`: el ritmo normal
 * son 2-4 lotes por minuto, y el margen esta para el cliente que drena su cola
 * tras un tunel.
 */
@Injectable()
export class IngestThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: IngestRequest): Promise<string> {
    // En OsmAnd la sesion se resuelve dentro del handler, asi que aqui todavia
    // no esta: el `id` del dispositivo hace el mismo papel de unidad de cuenta.
    const dispositivo = typeof req.query?.id === 'string' ? req.query.id : undefined;
    return Promise.resolve(req.trackingSession?.id ?? dispositivo ?? req.ip ?? 'desconocido');
  }
}
