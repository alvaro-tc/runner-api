import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { hashIngestToken } from '../../common/ingest-token';
import { PrismaService } from '../../database/prisma.service';
import { TrackingSessionStatus } from '../../../generated/prisma/enums';

/** La sesion resuelta a partir del token, colgada del request por este guard. */
export interface SesionDeIngesta {
  id: string;
  userId: string;
  workoutId: string | null;
  deviceId: string | null;
  startedAt: Date;
  status: TrackingSessionStatus;
  /// Maraton que se esta corriendo, si la sesion es una carrera. Es lo que
  /// decide si el punto se publica a espectadores: sin esto, la ingesta
  /// tendria que consultarlo en cada lote para casi siempre no publicar nada.
  marathonId: string | null;
}

export interface IngestRequest extends Request {
  trackingSession?: SesionDeIngesta;
}

/** Estados en los que la sesion sigue viva y admite posiciones. */
const ABIERTA: TrackingSessionStatus[] = [
  TrackingSessionStatus.active,
  TrackingSessionStatus.paused,
];

/**
 * Autentica la ingesta con el `ingestToken` de la sesion, no con el JWT.
 *
 * El credencial que viaja desde el telefono cada veinte segundos, durante toda
 * una carrera, tiene que ser el de menor alcance posible: este solo sirve para
 * mandar puntos a **una** sesion, muere cuando la sesion se cierra y no da
 * acceso a nada mas de la cuenta. Mandar el JWT de usuario en cada lote seria
 * pasear la llave de todo por la red mil veces por entrenamiento.
 *
 * Se acepta tambien en pausa: un lote en vuelo cuando el usuario pulsa "pausa"
 * contiene puntos que ocurrieron de verdad, y rechazarlo los perderia. Solo se
 * cierra la puerta cuando la sesion ya termino o se descarto.
 */
@Injectable()
export class IngestTokenGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<IngestRequest>();
    const token = extraerBearer(req);
    if (!token) throw this.invalido();

    const sesion = await this.prisma.trackingSession.findUnique({
      where: { ingestToken: hashIngestToken(token) },
      select: {
        id: true,
        userId: true,
        workoutId: true,
        deviceId: true,
        startedAt: true,
        status: true,
        marathonId: true,
      },
    });

    // Un token que no existe y un token de otra sesion dan el mismo error: si
    // se distinguieran, el mensaje seria un oraculo para adivinar ids ajenos.
    const idPedido = req.params.id;
    if (!sesion || (idPedido && sesion.id !== idPedido)) throw this.invalido();

    if (!ABIERTA.includes(sesion.status)) {
      throw new AppException(
        ErrorCode.SESSION_NOT_ACTIVE,
        'La sesion ya esta cerrada: no admite mas posiciones',
        HttpStatus.CONFLICT,
        [{ status: sesion.status }],
      );
    }

    req.trackingSession = sesion;
    return true;
  }

  private invalido(): AppException {
    return new AppException(
      ErrorCode.INVALID_INGEST_TOKEN,
      'El token de ingesta no es valido',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

function extraerBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;

  const [esquema, valor] = header.split(' ');
  return esquema?.toLowerCase() === 'bearer' && valor ? valor : undefined;
}
