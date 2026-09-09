import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { nuevoIngestToken } from '../../common/ingest-token';
import { registrarDispositivo } from '../../common/devices';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ShoesService, type DistanciaSumada } from '../users/shoes.service';
import { TrainingPlansService } from '../training-plans/training-plans.service';
import { RacesService } from '../races/races.service';
import { LiveService } from '../realtime/live.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { Prisma } from '../../../generated/prisma/client';
import {
  RegistrationStatus,
  TrackingSessionStatus,
  WorkoutType,
} from '../../../generated/prisma/enums';
import { calorias, consolidar, type Punto } from './metrics';
import type { FinishSessionDto, StartSessionDto } from './dto/workout.dto';

/** Estados en los que la sesion sigue viva y admite posiciones. */
const ABIERTA: TrackingSessionStatus[] = [
  TrackingSessionStatus.active,
  TrackingSessionStatus.paused,
];

/**
 * Tope de posiciones que se leen para consolidar.
 *
 * A 1 Hz son mas de once horas de carrera: cubre cualquier maraton popular con
 * margen. El limite existe para que una sesion que se quedo abierta tres dias
 * con el GPS encendido no se traiga cien mil filas al proceso.
 *
 * ponytail: carga en memoria; si aparecen ultramaratones, consolidar por lotes.
 */
const MAX_POSICIONES = 40_000;

const WORKOUT_CON_SPLITS = {
  splits: { orderBy: { index: 'asc' } },
} as const;

type FilaWorkout = Prisma.WorkoutGetPayload<{ include: typeof WORKOUT_CON_SPLITS }>;

@Injectable()
export class WorkoutSessionsService {
  private readonly logger = new Logger(WorkoutSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shoes: ShoesService,
    private readonly plans: TrainingPlansService,
    private readonly races: RacesService,
    private readonly live: LiveService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Aviso de zapatilla gastada. Comparte texto y reglas de entrega con el
   *  cierre por sincronizacion offline: el usuario no distingue por donde
   *  entro el entrenamiento. */
  avisarDesgaste(userId: string, zapatilla: DistanciaSumada): Promise<void> {
    return this.notifications.notify(userId, {
      type: 'shoe.wear_alert',
      shoeId: zapatilla.id,
      brand: zapatilla.brand,
      model: zapatilla.model,
      distanceMeters: zapatilla.distanceMeters,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Arranque
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Abre un entrenamiento y su sesion de tracking.
   *
   * **Idempotente por `clientUuid`.** El cliente genera ese uuid antes de tener
   * red, asi que reintentar el arranque tras un timeout no puede crear un
   * segundo entrenamiento: se devuelve el que ya existe.
   *
   * En ese reintento el `ingestToken` se **rota**. El anterior solo existe en la
   * base como hash y es irrecuperable; sin rotarlo, un cliente que perdio la
   * respuesta original se quedaria sin poder mandar posiciones a su propia
   * sesion. Rotar invalida de paso el token viejo, que es lo que se quiere si
   * el motivo del reintento fue un cambio de dispositivo.
   */
  async iniciar(userId: string, dto: StartSessionDto) {
    const abierta = await this.prisma.trackingSession.findFirst({
      where: { userId, status: { in: ABIERTA }, workout: { clientUuid: dto.clientUuid } },
      include: { workout: { include: WORKOUT_CON_SPLITS } },
    });

    if (abierta?.workout) {
      const { token, hash } = nuevoIngestToken();
      const sesion = await this.prisma.trackingSession.update({
        where: { id: abierta.id },
        data: { ingestToken: hash },
      });

      return {
        session: this.toSesion(sesion),
        workout: this.toWorkout(abierta.workout),
        ingestToken: token,
      };
    }

    await this.exigirSinOtraSesionAbierta(userId);
    if (dto.planSessionId) await this.exigirSesionDePlanPropia(userId, dto.planSessionId);
    // La maraton se guarda en la sesion, no se deduce despues: es lo que lee la
    // ingesta —en el camino caliente— para decidir si el punto va al mapa de
    // espectadores, y no puede costar una consulta por lote.
    const marathonId = dto.registrationId
      ? await this.exigirInscripcionPropia(userId, dto.registrationId)
      : null;

    const device = dto.deviceId ? await this.registrarDispositivo(userId, dto.deviceId) : null;
    const { token, hash } = nuevoIngestToken();
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : new Date();

    const { workout, sesion } = await this.prisma.$transaction(async (tx) => {
      const workout = await tx.workout.create({
        data: {
          userId,
          clientUuid: dto.clientUuid,
          type: dto.type ?? WorkoutType.free_run,
          planSessionId: dto.planSessionId ?? null,
          registrationId: dto.registrationId ?? null,
          startedAt,
          // Mientras la sesion siga abierta el cliente tiene puntos sin subir.
          isSynced: false,
        },
        include: WORKOUT_CON_SPLITS,
      });

      const sesion = await tx.trackingSession.create({
        data: {
          userId,
          workoutId: workout.id,
          marathonId,
          deviceId: device?.id ?? null,
          ingestToken: hash,
          startedAt,
        },
      });

      return { workout, sesion };
    });

    return { session: this.toSesion(sesion), workout: this.toWorkout(workout), ingestToken: token };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Pausa y reanudacion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Pausar y reanudar solo mueven el estado de la sesion.
   *
   * El tiempo parado **no se descuenta aqui**: sale de las posiciones al
   * consolidar (`movingSeconds`). Llevar la cuenta con los eventos de pausa
   * significaria confiar en que todos llegan y en orden, y una pausa cuyo
   * "resume" se perdio en un tunel dejaria el entrenamiento con horas de parada
   * inventadas. La ingesta **sigue abierta en pausa**: un lote en vuelo cuando
   * el usuario pulsa "pausa" contiene puntos que ocurrieron de verdad, y
   * rechazarlo los perderia. La puerta se cierra al finalizar o descartar.
   */
  pausar(userId: string, sessionId: string) {
    return this.cambiarEstado(
      userId,
      sessionId,
      TrackingSessionStatus.active,
      TrackingSessionStatus.paused,
    );
  }

  reanudar(userId: string, sessionId: string) {
    return this.cambiarEstado(
      userId,
      sessionId,
      TrackingSessionStatus.paused,
      TrackingSessionStatus.active,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Cierre
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cierra la sesion y consolida las metricas desde las posiciones.
   *
   * Lo que manda el cliente en `clientReported` se guarda tal cual y no se usa
   * para nada mas: lo que se publica sale de `consolidar()`. Dos telefonos con
   * el mismo recorrido dan distancias distintas segun el filtrado de su SDK, y
   * el puesto en una carrera no puede depender del modelo de telefono.
   *
   * Una sesion sin posiciones se cierra igual, con las metricas a cero: el
   * entrenamiento existio aunque el GPS no funcionara, y borrarlo por eso seria
   * decidir por el usuario.
   */
  async finalizar(userId: string, sessionId: string, dto: FinishSessionDto) {
    const sesion = await this.buscarPropia(userId, sessionId);
    this.exigirAbierta(sesion.status);
    if (!sesion.workoutId) throw this.noExiste('La sesion no tiene entrenamiento asociado');

    const puntos = await this.posicionesDe(sesion.id);
    const metricas = consolidar(puntos);

    const perfil = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { weightGrams: true },
    });

    const finishedAt = new Date();
    const workoutId = sesion.workoutId;

    const { workout, zapatilla } = await this.prisma.$transaction(async (tx) => {
      // Las posiciones se cuelgan del workout al cerrar, no al llegar: hasta
      // aqui podrian haber acabado en una sesion descartada.
      await tx.position.updateMany({
        where: { trackingSessionId: sesion.id },
        data: { workoutId },
      });

      await tx.workoutSplit.deleteMany({ where: { workoutId } });

      const workout = await tx.workout.update({
        where: { id: workoutId },
        data: {
          endedAt: finishedAt,
          durationSeconds: metricas.durationSeconds,
          movingSeconds: metricas.movingSeconds,
          distanceMeters: metricas.distanceMeters,
          avgPaceSecPerKm: metricas.avgPaceSecPerKm,
          avgSpeedMps: metricas.avgSpeedMps,
          elevationGainMeters: metricas.elevationGainMeters,
          bestKmIndex: metricas.bestKmIndex,
          calories: calorias(
            metricas.distanceMeters,
            metricas.movingSeconds,
            perfil?.weightGrams ?? null,
          ),
          clientReported: (dto.clientReported ?? null) as Prisma.InputJsonValue,
          feeling: dto.feeling ?? null,
          notes: dto.notes ?? null,
          isSynced: true,
          splits: { create: metricas.splits },
        },
        include: WORKOUT_CON_SPLITS,
      });

      await tx.trackingSession.update({
        where: { id: sesion.id },
        data: { status: TrackingSessionStatus.finished, finishedAt },
      });

      const zapatilla = await this.shoes.sumarDistancia(tx, userId, metricas.distanceMeters);
      return { workout, zapatilla };
    });

    if (zapatilla?.justCrossedWearAlert) await this.avisarDesgaste(userId, zapatilla);

    // Fuera de la transaccion a proposito: cerrar la sesion del plan es una
    // consecuencia agradable, no parte del entrenamiento. Si falla, el workout
    // ya esta guardado y el usuario puede marcarla a mano.
    if (workout.planSessionId) {
      await this.plans
        .completarSesion(userId, workout.planSessionId, { workoutId: workout.id })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, planSessionId: workout.planSessionId },
            'No se pudo cerrar la sesion del plan; el entrenamiento se guardo igual',
          );
        });
    }

    // Si el entrenamiento era una carrera, de aqui sale el resultado oficial y
    // el recalculo de puestos. Nunca lanza: ver `registrarResultado`.
    this.live.olvidar(sesion.id);

    if (workout.registrationId) await this.races.registrarResultado(workout.id);

    return {
      session: this.toSesion({ ...sesion, status: TrackingSessionStatus.finished, finishedAt }),
      workout: this.toWorkout(workout),
      discardedPoints: metricas.discardedPoints,
      shoe: zapatilla,
    };
  }

  /**
   * Descarta la sesion: se van las posiciones y el entrenamiento.
   *
   * Aqui el borrado del workout **si** es logico (`deletedAt`), al reves que en
   * los planes: el usuario que descarta puede arrepentirse, y una fila con
   * fecha de borrado se recupera desde el panel. Las posiciones, en cambio, se
   * borran de verdad — son datos de ubicacion, y guardar el rastro de un
   * recorrido que el usuario pidio tirar es exactamente lo que no hay que
   * hacer con un dato sensible.
   */
  async descartar(userId: string, sessionId: string) {
    const sesion = await this.buscarPropia(userId, sessionId);
    this.exigirAbierta(sesion.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.position.deleteMany({ where: { trackingSessionId: sesion.id } });

      if (sesion.workoutId) {
        await tx.workout.update({
          where: { id: sesion.workoutId },
          data: { deletedAt: new Date() },
        });
      }

      await tx.trackingSession.update({
        where: { id: sesion.id },
        data: { status: TrackingSessionStatus.discarded, finishedAt: new Date() },
      });
    });

    this.live.olvidar(sesion.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Interno
  // ─────────────────────────────────────────────────────────────────────────

  private async posicionesDe(trackingSessionId: string): Promise<Punto[]> {
    return this.prisma.position.findMany({
      where: { trackingSessionId },
      orderBy: { recordedAt: 'asc' },
      take: MAX_POSICIONES,
      select: { recordedAt: true, lat: true, lng: true, altitude: true, accuracyMeters: true },
    });
  }

  /**
   * Una sola sesion abierta por usuario.
   *
   * Dos sesiones vivas a la vez significan dos flujos de posiciones del mismo
   * telefono y ninguna forma de saber a cual pertenece cada punto. Casi siempre
   * es una sesion vieja que quedo colgada porque la app murio, asi que el error
   * devuelve su id: el cliente la finaliza o la descarta y reintenta.
   */
  private async exigirSinOtraSesionAbierta(userId: string) {
    const abierta = await this.prisma.trackingSession.findFirst({
      where: { userId, status: { in: ABIERTA } },
      select: { id: true, startedAt: true },
    });
    if (!abierta) return;

    throw new AppException(
      ErrorCode.SESSION_ALREADY_ACTIVE,
      'Ya tienes una sesion de tracking abierta',
      HttpStatus.CONFLICT,
      [{ sessionId: abierta.id, startedAt: abierta.startedAt.toISOString() }],
    );
  }

  private async exigirSesionDePlanPropia(userId: string, planSessionId: string) {
    const existe = await this.prisma.trainingPlanSession.findFirst({
      where: { id: planSessionId, plan: { userId } },
      select: { id: true },
    });
    if (!existe) throw this.noExiste('La sesion del plan no existe');
  }

  /**
   * Devuelve la maraton de la inscripcion: es lo que convierte la sesion en carrera.
   *
   * **Exige que este confirmada.** Un borrador a medias o un QR sin pagar no
   * dan derecho a correr la carrera, y dejarlos pasar aqui pondria a esa
   * persona en el mapa en vivo, en el ranking y en los resultados oficiales sin
   * haber pagado ni tener dorsal. El cupo y el dorsal se toman al confirmar el
   * pago; esta comprobacion es la otra mitad de esa misma regla.
   */
  private async exigirInscripcionPropia(userId: string, registrationId: string): Promise<string> {
    const inscripcion = await this.prisma.registration.findFirst({
      where: { id: registrationId, userId, deletedAt: null },
      select: { marathonId: true, status: true },
    });
    if (!inscripcion) throw this.noExiste('La inscripcion no existe');

    if (inscripcion.status !== RegistrationStatus.confirmed) {
      throw new AppException(
        ErrorCode.REGISTRATION_NOT_CONFIRMED,
        'Esa inscripcion todavia no esta confirmada: termina el pago para poder largar',
        HttpStatus.CONFLICT,
        [{ status: inscripcion.status }],
      );
    }

    return inscripcion.marathonId;
  }

  /**
   * El dispositivo, al dia. La fila la comparte con el login: ver
   * `registrarDispositivo` en `common/devices.ts`.
   */
  private registrarDispositivo(userId: string, uniqueId: string) {
    return registrarDispositivo(this.prisma, userId, uniqueId);
  }

  private async cambiarEstado(
    userId: string,
    sessionId: string,
    desde: TrackingSessionStatus,
    hasta: TrackingSessionStatus,
  ) {
    const sesion = await this.buscarPropia(userId, sessionId);

    if (sesion.status !== desde) {
      throw new AppException(
        ErrorCode.SESSION_NOT_ACTIVE,
        `La sesion esta en estado ${sesion.status}`,
        HttpStatus.CONFLICT,
        [{ status: sesion.status, expected: desde }],
      );
    }

    const actualizada = await this.prisma.trackingSession.update({
      where: { id: sesion.id },
      data: { status: hasta },
    });

    return this.toSesion(actualizada);
  }

  private exigirAbierta(status: TrackingSessionStatus) {
    if (ABIERTA.includes(status)) return;

    throw new AppException(
      ErrorCode.SESSION_NOT_ACTIVE,
      'La sesion ya esta cerrada',
      HttpStatus.CONFLICT,
      [{ status }],
    );
  }

  /** El `userId` va en el `where`, no en un `if` posterior. */
  private async buscarPropia(userId: string, sessionId: string) {
    const sesion = await this.prisma.trackingSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!sesion) throw this.noExiste('La sesion no existe');
    return sesion;
  }

  private toSesion(s: {
    id: string;
    status: TrackingSessionStatus;
    startedAt: Date;
    lastPositionAt: Date | null;
    finishedAt: Date | null;
  }) {
    return {
      id: s.id,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      lastPositionAt: s.lastPositionAt?.toISOString() ?? null,
      finishedAt: s.finishedAt?.toISOString() ?? null,
    };
  }

  toWorkout(w: FilaWorkout) {
    return {
      id: w.id,
      clientUuid: w.clientUuid,
      type: w.type,
      planSessionId: w.planSessionId,
      registrationId: w.registrationId,
      startedAt: w.startedAt.toISOString(),
      endedAt: w.endedAt?.toISOString() ?? null,
      durationSeconds: w.durationSeconds,
      movingSeconds: w.movingSeconds,
      distanceMeters: w.distanceMeters,
      avgPaceSecPerKm: w.avgPaceSecPerKm,
      avgSpeedMps: w.avgSpeedMps,
      elevationGainMeters: w.elevationGainMeters,
      calories: w.calories,
      bestKmIndex: w.bestKmIndex,
      feeling: w.feeling,
      notes: w.notes,
      clientReported: w.clientReported,
      splits: w.splits.map((s) => ({
        index: s.index,
        distanceMeters: s.distanceMeters,
        durationSeconds: s.durationSeconds,
        paceSecPerKm: s.paceSecPerKm,
        elevationGainMeters: s.elevationGainMeters,
      })),
    };
  }

  private noExiste(mensaje: string): AppException {
    return new AppException(ErrorCode.NOT_FOUND, mensaje, HttpStatus.NOT_FOUND);
  }
}
