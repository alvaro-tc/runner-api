import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { registrarDispositivo } from '../../common/devices';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/dto/response-envelope';
import { exigirClaveDeIdempotencia } from '../../common/idempotency';
import { antesDe, armarPagina, decodeCursor } from '../../common/pagination/cursor';
import { rangoSemanal, type RangoSemana } from '../../common/time/week';
import { ShoesService } from '../users/shoes.service';
import { TrainingPlansService } from '../training-plans/training-plans.service';
import { RacesService } from '../races/races.service';
import { Prisma } from '../../../generated/prisma/client';
import {
  PositionSource,
  TrackingSessionStatus,
  WorkoutSource,
  WorkoutType,
} from '../../../generated/prisma/enums';
import { calorias, consolidar, ritmo, type Metricas, type Punto } from './metrics';
import { armarSemanas, type DiaAgregado } from './weekly-stats';
import { WorkoutSessionsService } from './workout-sessions.service';
import {
  GroupBy,
  GRUPOS_POR_DEFECTO,
  LIMITE_POR_DEFECTO,
  SEMANAS_POR_DEFECTO,
  type GroupedQueryDto,
  type ListWorkoutsQueryDto,
  type SyncResultDto,
  type SyncWorkoutDto,
  type SyncWorkoutsDto,
  type WeeklyStatsQueryDto,
} from './dto/workout-history.dto';
import type { PositionPointDto } from '../tracking/dto/tracking.dto';

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Margen alrededor de la ventana del entrenamiento para aceptar un punto.
 *
 * El reloj del telefono no coincide al segundo con el `startedAt` que el propio
 * cliente reporta, y un punto grabado dos segundos antes de darle a "empezar"
 * no es basura. Mas alla de esto ya es otro dia u otra carrera.
 */
const TOLERANCIA_PUNTOS_MS = 5 * 60 * 1000;

/**
 * Filas por `createMany` de posiciones.
 *
 * Un entrenamiento largo trae miles de puntos y un solo INSERT con veinte mil
 * filas arma una sentencia que Postgres tiene que parsear entera. En lotes es
 * la misma cantidad de trabajo repartida.
 */
const TAMANO_LOTE_POSICIONES = 2000;

/** Lo que sale por el listado. Sin splits: el historial no los pinta. */
const CAMPOS_RESUMEN = {
  id: true,
  clientUuid: true,
  type: true,
  source: true,
  startedAt: true,
  endedAt: true,
  distanceMeters: true,
  durationSeconds: true,
  movingSeconds: true,
  avgPaceSecPerKm: true,
  elevationGainMeters: true,
  calories: true,
  feeling: true,
  planSessionId: true,
  registrationId: true,
} as const;

type FilaResumen = Prisma.WorkoutGetPayload<{ select: typeof CAMPOS_RESUMEN }>;

/** Punto del cliente a punto medible. Solo lo que usa `consolidar()`. */
function aPunto(p: PositionPointDto): Punto {
  return {
    recordedAt: new Date(p.recordedAt),
    lat: p.lat,
    lng: p.lng,
    altitude: p.altitude ?? null,
    accuracyMeters: p.accuracy ?? null,
  };
}

/** Lo que devuelven las agregaciones en crudo. */
interface FilaAgregada {
  startsAt: Date;
  distanceMeters: number | null;
  movingSeconds: number | null;
  durationSeconds: number | null;
  elevationGainMeters: number | null;
  workouts: number;
}

/**
 * Historial de entrenamientos: consulta, agregados y sincronizacion offline.
 *
 * Separado de `WorkoutSessionsService` a proposito: alli vive el ciclo de vida
 * de una sesion en curso (arrancar, pausar, cerrar) y aqui todo lo que se hace
 * con entrenamientos que ya terminaron. Son dos vidas distintas del mismo dato.
 */
@Injectable()
export class WorkoutsService {
  private readonly logger = new Logger(WorkoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly sessions: WorkoutSessionsService,
    private readonly shoes: ShoesService,
    private readonly plans: TrainingPlansService,
    private readonly races: RacesService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  Consulta
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Historial paginado por cursor, del mas reciente al mas viejo.
   *
   * El orden descendente no es un detalle de presentacion: la pantalla abre por
   * arriba y el usuario baja. Paginar al reves obligaria a traerlo todo para
   * pintar los tres ultimos.
   */
  async listar(
    userId: string,
    query: ListWorkoutsQueryDto,
  ): Promise<Paginated<ReturnType<typeof this.toResumen>>> {
    const limit = query.limit ?? LIMITE_POR_DEFECTO;
    const where: Prisma.WorkoutWhereInput = {
      userId,
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.from || query.to
        ? {
            startedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const cursor = decodeCursor(query.cursor);
    const filas = await this.prisma.workout.findMany({
      where: cursor
        ? { AND: [where, { OR: antesDe('startedAt', new Date(cursor.v), cursor.id) }] }
        : where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: CAMPOS_RESUMEN,
    });

    const pagina = armarPagina(filas, limit, (fila) => ({
      v: fila.startedAt.toISOString(),
      id: fila.id,
    }));

    return new Paginated(
      pagina.items.map((f) => this.toResumen(f)),
      pagina.nextCursor,
    );
  }

  /** Detalle con splits. El `userId` va en el `where`: filtrar ES la autorizacion. */
  async detalle(userId: string, id: string) {
    const workout = await this.prisma.workout.findFirst({
      where: { id, userId, deletedAt: null },
      include: { splits: { orderBy: { index: 'asc' } } },
    });

    if (!workout) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'El entrenamiento no existe',
        HttpStatus.NOT_FOUND,
      );
    }

    return this.sessions.toWorkout(workout);
  }

  /**
   * Borrado logico.
   *
   * Las posiciones se quedan, al reves que al descartar una sesion en curso:
   * aqui el entrenamiento ya existio, puede estar colgado de una carrera o de
   * una sesion de plan, y un `deletedAt` que se pueda deshacer vale mas que el
   * espacio ahorrado. La politica de retencion de ubicaciones esta en
   * `docs/decisiones.md`.
   *
   * Los kilometros ya sumados a la zapatilla **no se restan**: el desgaste del
   * material ocurrio de verdad aunque el usuario esconda el entrenamiento.
   */
  async borrar(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.workout.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (count === 0) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'El entrenamiento no existe',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Agregados
  // ─────────────────────────────────────────────────────────────────────────

  /** Totales por semana o por mes, del grupo mas reciente hacia atras. */
  async agrupar(userId: string, query: GroupedQueryDto) {
    const by = query.by ?? GroupBy.week;
    const timezone = this.config.get('DEFAULT_TIMEZONE');
    const filas = await this.agregarPor(userId, by, timezone, query.limit ?? GRUPOS_POR_DEFECTO);

    return {
      by,
      timezone,
      groups: filas.map((f) => ({
        startsAt: f.startsAt.toISOString(),
        distanceMeters: f.distanceMeters ?? 0,
        movingSeconds: f.movingSeconds ?? 0,
        durationSeconds: f.durationSeconds ?? 0,
        elevationGainMeters: f.elevationGainMeters ?? 0,
        workouts: f.workouts,
        avgPaceSecPerKm: ritmo(f.distanceMeters ?? 0, f.movingSeconds ?? 0),
      })),
    };
  }

  /**
   * Resumen semanal con la barra de cada dia.
   *
   * Se pide a la base el total **por dia** y el reparto en semanas se hace en
   * memoria (`armarSemanas`). Asi una semana en la que el usuario no corrio
   * aparece igual, con sus siete ceros: pintar la tira Mon-Sun necesita las
   * casillas vacias tanto como las llenas, y un `GROUP BY week` solo devuelve
   * las semanas que existen.
   */
  async statsSemanales(userId: string, query: WeeklyStatsQueryDto) {
    const cuantas = query.weeks ?? SEMANAS_POR_DEFECTO;
    const timezone = this.config.get('DEFAULT_TIMEZONE');
    const ahora = new Date();

    // De la mas vieja a la mas reciente. Cada frontera se calcula con
    // `rangoSemanal` en vez de restar 7x24 h para que un cambio de horario no
    // desplace la semana entera una hora.
    const semanas: RangoSemana[] = [];
    for (let i = cuantas - 1; i >= 0; i -= 1) {
      semanas.push(rangoSemanal(new Date(ahora.getTime() - i * 7 * MS_POR_DIA), timezone));
    }

    const desde = semanas[0]!.start;
    const hasta = semanas.at(-1)!.end;
    const filas = await this.agregarPorDia(userId, timezone, desde, hasta);

    const dias: DiaAgregado[] = filas.map((f) => ({
      at: f.startsAt,
      distanceMeters: f.distanceMeters ?? 0,
      movingSeconds: f.movingSeconds ?? 0,
      durationSeconds: f.durationSeconds ?? 0,
      workouts: f.workouts,
    }));

    return { timezone, weeks: armarSemanas(semanas, dias) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Sincronizacion offline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sube entrenamientos grabados sin red.
   *
   * **Un fallo no tumba el lote.** El movil puede llevar dos semanas de cola y
   * traer un entrenamiento con un `planSessionId` que ya no existe; rechazar
   * los 20 por culpa de ese seria condenar al cliente a reintentar para
   * siempre. Cada uno se resuelve por separado y la respuesta dice, uno a uno,
   * que paso: el cliente borra de su cola los `created` y los `duplicated`, y
   * marca los `rejected` para no reintentarlos eternamente.
   *
   * La idempotencia real la da `clientUuid`, que es unico en la base: reenviar
   * el mismo lote no duplica nada. La cabecera `Idempotency-Key` se exige igual
   * porque es el contrato del endpoint y porque hace explicito, del lado del
   * cliente, que el reintento es seguro.
   */
  async sincronizar(userId: string, dto: SyncWorkoutsDto, idempotencyKey: string) {
    exigirClaveDeIdempotencia(idempotencyKey);

    const results: SyncResultDto[] = [];
    for (const item of dto.workouts) {
      results.push(await this.sincronizarUno(userId, item));
    }

    return {
      created: results.filter((r) => r.status === 'created').length,
      duplicated: results.filter((r) => r.status === 'duplicated').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
      results,
    };
  }

  private async sincronizarUno(userId: string, item: SyncWorkoutDto): Promise<SyncResultDto> {
    const previo = await this.prisma.workout.findUnique({
      where: { clientUuid: item.clientUuid },
      select: { id: true, userId: true },
    });

    if (previo) {
      return previo.userId === userId
        ? this.resultado(item, 'duplicated', previo.id)
        : this.resultado(item, 'rejected', null, 'Ese clientUuid ya existe');
    }

    const startedAt = new Date(item.startedAt);
    const endedAt = new Date(item.endedAt);
    if (endedAt <= startedAt) {
      return this.resultado(item, 'rejected', null, 'endedAt tiene que ser posterior a startedAt');
    }
    if (startedAt.getTime() > Date.now() + TOLERANCIA_PUNTOS_MS) {
      return this.resultado(item, 'rejected', null, 'startedAt esta en el futuro');
    }

    if (item.planSessionId) {
      const existe = await this.prisma.trainingPlanSession.count({
        where: { id: item.planSessionId, plan: { userId } },
      });
      if (existe === 0)
        return this.resultado(item, 'rejected', null, 'La sesion del plan no existe');
    }

    if (item.registrationId) {
      const existe = await this.prisma.registration.count({
        where: { id: item.registrationId, userId, deletedAt: null },
      });
      if (existe === 0) return this.resultado(item, 'rejected', null, 'La inscripcion no existe');
    }

    const enVentana = this.puntosDentroDeLaVentana(item.points ?? [], startedAt, endedAt);
    const puntos = enVentana.map(aPunto);
    const conRecorrido = puntos.length > 0;
    const metricas = conRecorrido ? consolidar(puntos) : this.metricasManuales(item);
    const descartadosFuera = (item.points?.length ?? 0) - enVentana.length;

    const perfil = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { weightGrams: true },
    });

    const device = item.deviceId ? await this.registrarDispositivo(userId, item.deviceId) : null;

    if (conRecorrido) {
      await this.prisma.ensurePositionsPartitions(puntos.map((p) => p.recordedAt));
    }

    const { workout, zapatilla } = await this.prisma.$transaction(async (tx) => {
      const workout = await tx.workout.create({
        data: {
          userId,
          clientUuid: item.clientUuid,
          source: item.source ?? (conRecorrido ? WorkoutSource.app : WorkoutSource.manual),
          type: item.type ?? WorkoutType.free_run,
          planSessionId: item.planSessionId ?? null,
          registrationId: item.registrationId ?? null,
          startedAt,
          endedAt,
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
          clientReported: (item.clientReported ?? null) as Prisma.InputJsonValue,
          feeling: item.feeling ?? null,
          notes: item.notes ?? null,
          isSynced: true,
          splits: { create: metricas.splits },
        },
      });

      if (conRecorrido) {
        // El recorrido llego entero y ya cerrado: la sesion de tracking se crea
        // aqui solo para que las posiciones cuelguen de algo, igual que las de
        // un entrenamiento seguido en vivo. Asi el resto del sistema (mapa de
        // la carrera, live tracking) no tiene que distinguir dos origenes.
        const sesion = await tx.trackingSession.create({
          data: {
            userId,
            workoutId: workout.id,
            deviceId: device?.id ?? null,
            status: TrackingSessionStatus.finished,
            // Marcador, no credencial: la ingesta compara contra un sha256 en
            // hexadecimal, asi que este valor no autentica nada. La columna es
            // NOT NULL y unica, y una sesion ya cerrada no admite posiciones.
            ingestToken: `sync:${workout.id}`,
            startedAt,
            lastPositionAt: puntos.at(-1)?.recordedAt ?? null,
            finishedAt: endedAt,
          },
        });

        await this.guardarPosiciones(tx, {
          userId,
          workoutId: workout.id,
          trackingSessionId: sesion.id,
          deviceId: device?.id ?? null,
          puntos: enVentana,
        });
      }

      const zapatilla = await this.shoes.sumarDistancia(tx, userId, metricas.distanceMeters);
      return { workout, zapatilla };
    });

    if (zapatilla?.justCrossedWearAlert) {
      await this.sessions.avisarDesgaste(userId, zapatilla);
    }

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
    if (workout.registrationId) await this.races.registrarResultado(workout.id);

    return this.resultado(
      item,
      'created',
      workout.id,
      null,
      metricas.discardedPoints + descartadosFuera,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Interno
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Los agregados los hace Postgres, no el proceso.
   *
   * `date_trunc` se aplica sobre la hora **local**: la columna es UTC, asi que
   * hay que traerla a la zona del usuario, cortar ahi, y devolver la frontera
   * como instante UTC otra vez. Sin eso, en La Paz (UTC-4) toda carrera de
   * domingo por la tarde cae en el mes o la semana siguiente.
   */
  private agregarPor(
    userId: string,
    unidad: GroupBy,
    tz: string,
    limit: number,
  ): Promise<FilaAgregada[]> {
    return this.prisma.$queryRaw<FilaAgregada[]>`
      SELECT (date_trunc(${unidad}::text, "startedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text)
                AT TIME ZONE ${tz}::text) AS "startsAt",
             SUM("distanceMeters")::int      AS "distanceMeters",
             SUM("movingSeconds")::int       AS "movingSeconds",
             SUM("durationSeconds")::int     AS "durationSeconds",
             SUM("elevationGainMeters")::int AS "elevationGainMeters",
             COUNT(*)::int                   AS "workouts"
      FROM workouts
      WHERE "userId" = ${userId} AND "deletedAt" IS NULL
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${limit}
    `;
  }

  private agregarPorDia(
    userId: string,
    tz: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaAgregada[]> {
    return this.prisma.$queryRaw<FilaAgregada[]>`
      SELECT (date_trunc('day', "startedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text)
                AT TIME ZONE ${tz}::text) AS "startsAt",
             SUM("distanceMeters")::int      AS "distanceMeters",
             SUM("movingSeconds")::int       AS "movingSeconds",
             SUM("durationSeconds")::int     AS "durationSeconds",
             SUM("elevationGainMeters")::int AS "elevationGainMeters",
             COUNT(*)::int                   AS "workouts"
      FROM workouts
      WHERE "userId" = ${userId} AND "deletedAt" IS NULL
        AND "startedAt" >= ${desde} AND "startedAt" < ${hasta}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
  }

  /**
   * Un punto fuera de la ventana del entrenamiento no se mide.
   *
   * Es el punto que quedo en la cola local de la carrera de ayer, o el que el
   * GPS emitio con la fecha a cero al arrancar en frio. Uno solo, con una fecha
   * lejana, convierte una hora de carrera en una duracion de tres dias.
   */
  private puntosDentroDeLaVentana(
    puntos: readonly PositionPointDto[],
    startedAt: Date,
    endedAt: Date,
  ): PositionPointDto[] {
    const desde = startedAt.getTime() - TOLERANCIA_PUNTOS_MS;
    const hasta = endedAt.getTime() + TOLERANCIA_PUNTOS_MS;

    return puntos.filter((p) => {
      const t = new Date(p.recordedAt).getTime();
      return Number.isFinite(t) && t >= desde && t <= hasta;
    });
  }

  /**
   * Un entrenamiento sin recorrido se cree lo que dice el usuario.
   *
   * Es la unica excepcion a "la fuente de verdad es el servidor", y no es una
   * concesion: sin puntos no hay nada que recalcular. Se anota como
   * `source: manual` para que se pueda distinguir de lo medido.
   */
  private metricasManuales(item: SyncWorkoutDto): Metricas {
    const distanceMeters = item.distanceMeters ?? 0;
    const durationSeconds =
      item.durationSeconds ??
      Math.max(
        0,
        Math.round((new Date(item.endedAt).getTime() - new Date(item.startedAt).getTime()) / 1000),
      );

    return {
      distanceMeters,
      durationSeconds,
      movingSeconds: durationSeconds,
      avgPaceSecPerKm: ritmo(distanceMeters, durationSeconds),
      avgSpeedMps: durationSeconds > 0 ? distanceMeters / durationSeconds : null,
      elevationGainMeters: 0,
      bestKmIndex: null,
      splits: [],
      discardedPoints: 0,
    };
  }

  /**
   * Inserta el recorrido en lotes, saltando los repetidos.
   *
   * `skipDuplicates` sobre `(clientPointId, recordedAt)` es lo que hace seguro
   * reenviar: un lote a medio subir se reintenta entero sin miedo a duplicar.
   */
  private async guardarPosiciones(
    tx: Prisma.TransactionClient,
    datos: {
      userId: string;
      workoutId: string;
      trackingSessionId: string;
      deviceId: string | null;
      puntos: readonly PositionPointDto[];
    },
  ): Promise<void> {
    const filas = datos.puntos.map((p) => ({
      trackingSessionId: datos.trackingSessionId,
      workoutId: datos.workoutId,
      userId: datos.userId,
      deviceId: datos.deviceId,
      recordedAt: new Date(p.recordedAt),
      lat: p.lat,
      lng: p.lng,
      altitude: p.altitude ?? null,
      speedMps: p.speed ?? null,
      accuracyMeters: p.accuracy ?? null,
      heading: p.heading ?? null,
      batteryLevel: p.battery ?? null,
      source: PositionSource.app_batch,
      clientPointId: p.clientPointId,
    }));

    for (let i = 0; i < filas.length; i += TAMANO_LOTE_POSICIONES) {
      await tx.position.createMany({
        data: filas.slice(i, i + TAMANO_LOTE_POSICIONES),
        skipDuplicates: true,
      });
    }
  }

  private registrarDispositivo(userId: string, uniqueId: string) {
    return registrarDispositivo(this.prisma, userId, uniqueId);
  }

  private resultado(
    item: SyncWorkoutDto,
    status: SyncResultDto['status'],
    workoutId: string | null,
    reason: string | null = null,
    discardedPoints: number | null = null,
  ): SyncResultDto {
    return { clientUuid: item.clientUuid, status, workoutId, reason, discardedPoints };
  }

  private toResumen(w: FilaResumen) {
    return {
      id: w.id,
      clientUuid: w.clientUuid,
      type: w.type,
      source: w.source,
      startedAt: w.startedAt.toISOString(),
      endedAt: w.endedAt?.toISOString() ?? null,
      distanceMeters: w.distanceMeters,
      durationSeconds: w.durationSeconds,
      movingSeconds: w.movingSeconds,
      avgPaceSecPerKm: w.avgPaceSecPerKm,
      elevationGainMeters: w.elevationGainMeters,
      calories: w.calories,
      feeling: w.feeling,
      planSessionId: w.planSessionId,
      registrationId: w.registrationId,
    };
  }
}
