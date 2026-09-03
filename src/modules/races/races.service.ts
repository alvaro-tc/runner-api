import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { StorageService } from '../storage/storage.service';
import { PaymentsService } from '../payments/payments.service';
import { marcadores, ritmo, type Punto } from '../workouts/metrics';
import { Prisma } from '../../../generated/prisma/client';
import { PaymentStatus, RegistrationStatus } from '../../../generated/prisma/enums';
import { aLineString, simplificarHasta } from './route';
import { ShareCardService } from './share-card.service';
import { estadoEnVivo } from '../marathons/live-status';
import { RaceStatusFilter, type ListMyRacesQueryDto } from './dto/race.dto';

/**
 * Tope de posiciones que se leen para dibujar un recorrido.
 *
 * Una maraton de cinco horas a 1 Hz son 18.000 puntos; el tope deja margen de
 * sobra y evita que una sesion con la ingesta descontrolada se traiga medio
 * millon de filas a memoria. Lo que llegue se simplifica igual.
 */
const MAX_POSICIONES = 60_000;

/** Lo que la pantalla de carreras necesita de la maraton. */
const MARATON_DE_LA_CARRERA = {
  id: true,
  slug: true,
  name: true,
  city: true,
  startsAt: true,
  timezone: true,
  distanceMeters: true,
  coverUrl: true,
  kitPickup: true,
  preparingAt: true,
  preparingMessage: true,
  liveStartedAt: true,
  liveFinishedAt: true,
} as const;

const INSCRIPCION_DE_LA_CARRERA = {
  marathon: { select: MARATON_DE_LA_CARRERA },
  category: { select: { id: true, name: true } },
  raceResult: { include: { checkpoints: { orderBy: { kmMark: 'asc' } } } },
  payments: { orderBy: { createdAt: 'desc' }, take: 1 },
} as const;

type CarreraConTodo = Prisma.RegistrationGetPayload<{
  include: typeof INSCRIPCION_DE_LA_CARRERA;
}>;

/**
 * Carreras: lo que queda de una maraton una vez corrida.
 *
 * La clave de toda la seccion es el **id de la inscripcion**, no el del
 * resultado: la app llega aqui desde "Mis carreras", donde una carrera futura
 * todavia no tiene resultado ninguno y aun asi tiene pantalla, dorsal y cuenta
 * regresiva.
 */
@Injectable()
export class RacesService {
  private readonly logger = new Logger(RacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly shareCards: ShareCardService,
    private readonly payments: PaymentsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  Consulta
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cabecera de la pantalla: cuantas corriste, cuanto sumaste y cuanto gastaste.
   *
   * El gasto sale de los **pagos**, no de los precios de las maratones: un
   * precio cambia, un cobro no, y sumar precios de catalogo le mostraria al
   * usuario un total que nunca pago. Un pago reembolsado deja de estar `paid`,
   * asi que la resta de los reembolsos ya viene hecha por el propio estado.
   */
  async resumen(userId: string) {
    const [terminadas, proximas, gastado] = await Promise.all([
      this.prisma.raceResult.aggregate({
        where: { registration: { userId, deletedAt: null } },
        _count: { _all: true },
        _sum: { distanceMeters: true },
      }),
      this.prisma.registration.findMany({
        where: {
          userId,
          deletedAt: null,
          status: RegistrationStatus.confirmed,
          marathon: { startsAt: { gt: new Date() } },
        },
        include: INSCRIPCION_DE_LA_CARRERA,
        orderBy: { marathon: { startsAt: 'asc' } },
      }),
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.paid, registration: { userId, deletedAt: null } },
        _sum: { amountCents: true },
      }),
    ]);

    const siguiente = proximas[0];

    return {
      racesCompleted: terminadas._count._all,
      racesUpcoming: proximas.length,
      totalDistanceMeters: terminadas._sum.distanceMeters ?? 0,
      totalSpentCents: gastado._sum.amountCents ?? 0,
      currency: 'BOB',
      nextRace: siguiente ? this.toResumen(siguiente) : null,
    };
  }

  /**
   * Mis carreras.
   *
   * Solo inscripciones **confirmadas**: un borrador a medias o una cancelada no
   * son una carrera, y mezclarlas aqui convertiria la pestana en una bandeja de
   * intentos. Los borradores viven en `/registrations`.
   */
  async listar(userId: string, query: ListMyRacesQueryDto) {
    const ahora = new Date();
    const proximas = query.status === RaceStatusFilter.upcoming;
    const porFecha = proximas
      ? { gt: ahora }
      : query.status === RaceStatusFilter.completed
        ? { lte: ahora }
        : undefined;

    const filas = await this.prisma.registration.findMany({
      where: {
        userId,
        deletedAt: null,
        status: RegistrationStatus.confirmed,
        ...(porFecha ? { marathon: { startsAt: porFecha } } : {}),
      },
      include: INSCRIPCION_DE_LA_CARRERA,
      // Las proximas se leen de la mas cercana a la mas lejana; las pasadas, de
      // la mas reciente hacia atras. Un solo orden descendente pondria la
      // carrera de dentro de seis meses por encima de la de pasado manana.
      orderBy: { marathon: { startsAt: proximas ? 'asc' : 'desc' } },
    });

    return filas.map((fila) => this.toResumen(fila));
  }

  /** Detalle completo, con recorrido simplificado y marcadores cada 5 km. */
  async detalle(userId: string, registrationId: string) {
    const carrera = await this.buscarPropia(userId, registrationId);
    const resultado = carrera.raceResult;

    const [splits, recorrido, finishers] = await Promise.all([
      this.splitsDe(resultado?.workoutId ?? null),
      this.recorridoDe(resultado?.workoutId ?? null),
      this.finishersDe(carrera.marathonId, resultado !== null),
    ]);

    return {
      ...this.toResumen(carrera, finishers),
      splits,
      checkpoints: this.toCheckpoints(carrera.raceResult?.checkpoints ?? []),
      routeGeoJson: recorrido,
    };
  }

  /** Parciales por km y marcadores, sin el resto del detalle. */
  async splits(userId: string, registrationId: string) {
    const carrera = await this.buscarPropia(userId, registrationId);
    const resultado = this.exigirResultado(carrera);

    return {
      splits: await this.splitsDe(resultado.workoutId),
      checkpoints: this.toCheckpoints(resultado.checkpoints),
    };
  }

  /**
   * Comprobante de la inscripcion.
   *
   * No genera nada: resuelve cual fue el pago cobrado y se lo pide a pagos, que
   * es quien sabe emitirlo. Duplicar aqui la generacion del PDF daria dos
   * documentos distintos para el mismo cobro.
   */
  async comprobante(userId: string, registrationId: string) {
    const carrera = await this.buscarPropia(userId, registrationId);

    const pagado = await this.prisma.payment.findFirst({
      where: { registrationId: carrera.id, status: PaymentStatus.paid },
      orderBy: { paidAt: 'desc' },
      select: { id: true },
    });

    if (!pagado) {
      throw new AppException(
        ErrorCode.RECEIPT_NOT_AVAILABLE,
        'Esta inscripcion no tiene ningun pago cobrado',
        HttpStatus.CONFLICT,
      );
    }

    return this.payments.comprobante(userId, pagado.id);
  }

  /**
   * Tarjeta de imagen del resultado.
   *
   * Se regenera en cada POST a proposito: el puesto cambia cuando el
   * organizador carga los resultados que faltaban, y una tarjeta cacheada
   * seguiria diciendo "puesto 12" cuando ya es el 40. Es la misma clave de
   * archivo, asi que la URL no cambia.
   */
  async tarjeta(userId: string, registrationId: string) {
    const carrera = await this.buscarPropia(userId, registrationId);
    const resultado = this.exigirResultado(carrera);

    const clave = await this.shareCards.generar({
      raceResultId: resultado.id,
      marathonName: carrera.marathon.name,
      city: carrera.marathon.city,
      finishedAt: resultado.finishedAt,
      timezone: carrera.marathon.timezone,
      runnerName: nombreDelCorredor(carrera.personalData),
      bibNumber: carrera.bibNumber,
      finishTimeSeconds: resultado.finishTimeSeconds,
      distanceMeters: resultado.distanceMeters,
      avgPaceSecPerKm: resultado.avgPaceSecPerKm,
      overallRank: resultado.overallRank,
    });

    await this.prisma.raceResult.update({
      where: { id: resultado.id },
      data: { shareCardUrl: clave },
    });

    return { url: this.storage.url(clave) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Resultados
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Convierte un entrenamiento de carrera en resultado oficial.
   *
   * Lo llama el cierre de la sesion (Fase 10) cuando el entrenamiento venia
   * atado a una inscripcion. Es idempotente por `registrationId`: repetir el
   * cierre reescribe el mismo resultado en vez de crear un segundo.
   *
   * `finishTime` es el tiempo **desde la largada**, medido contra
   * `marathon.startsAt`, porque eso es lo que ordena una clasificacion;
   * `chipTime` es el reloj del propio corredor. Si el entrenamiento acabo antes
   * de la hora de largada —una prueba, o un reloj desfasado— el tiempo oficial
   * cae al del corredor: un numero negativo en una clasificacion es peor que
   * uno impreciso.
   *
   * **No propaga errores.** Lo llama el cierre de una sesion que ya esta
   * guardada: tumbar esa respuesta porque el resultado no cuajo le haria creer
   * al corredor que perdio el entrenamiento entero. Queda el log, y el resultado
   * se puede rehacer desde el panel — el entrenamiento, no.
   */
  async registrarResultado(workoutId: string): Promise<void> {
    try {
      await this.registrarResultadoOFallar(workoutId);
    } catch (error) {
      this.logger.warn(
        { err: error, workoutId },
        'No se pudo registrar el resultado de la carrera; el entrenamiento se guardo igual',
      );
    }
  }

  private async registrarResultadoOFallar(workoutId: string): Promise<void> {
    const workout = await this.prisma.workout.findUnique({
      where: { id: workoutId },
      include: { registration: { include: { marathon: true } } },
    });

    const registro = workout?.registration;
    if (!workout || !registro || registro.status !== RegistrationStatus.confirmed) return;

    const puntos = await this.posicionesDe(workoutId);
    const marcas = marcadores(puntos);

    // La meta se cruza en el ultimo punto del recorrido, no cuando el corredor
    // se acuerda de pulsar "finalizar" —ni cuando el telefono, sin cobertura,
    // consigue subir el entrenamiento tres horas despues. Sin recorrido no hay
    // nada mejor que `endedAt`.
    const finishedAt = puntos.at(-1)?.recordedAt ?? workout.endedAt ?? new Date();

    const desdeLargada = Math.round(
      (finishedAt.getTime() - registro.marathon.startsAt.getTime()) / 1000,
    );
    const finishTimeSeconds = desdeLargada > 0 ? desdeLargada : workout.durationSeconds;

    const datos = {
      workoutId,
      finishTimeSeconds,
      chipTimeSeconds: workout.durationSeconds,
      avgPaceSecPerKm: workout.avgPaceSecPerKm,
      avgSpeedMps: workout.avgSpeedMps,
      distanceMeters: workout.distanceMeters,
      elevationGainMeters: workout.elevationGainMeters,
      bestKmIndex: workout.bestKmIndex,
      finishedAt,
    };

    await this.prisma.$transaction(async (tx) => {
      const resultado = await tx.raceResult.upsert({
        where: { registrationId: registro.id },
        create: { registrationId: registro.id, ...datos },
        update: datos,
      });

      // Se reescriben enteros: recalcular unos cuantos marcadores es mas barato
      // y mucho mas simple que averiguar cuales cambiaron.
      await tx.raceCheckpoint.deleteMany({ where: { raceResultId: resultado.id } });
      await tx.raceCheckpoint.createMany({
        data: marcas.map((m) => ({ raceResultId: resultado.id, ...m })),
      });
    });

    await this.recalcularPuestos(registro.marathonId);
  }

  /**
   * Reasigna los puestos general y por categoria de una maraton.
   *
   * Se ordena por el tiempo oficial, con la hora de llegada como desempate. Los
   * empates **comparten puesto** —dos corredores con el mismo tiempo son ambos
   * terceros— y el siguiente salta al quinto: es la regla de cualquier
   * clasificacion deportiva, y numerarlos 3 y 4 por orden de id inventaria una
   * diferencia que no existe.
   *
   * Se recalcula la maraton entera cada vez. Con miles de resultados son unas
   * pocas decenas de milisegundos, y la alternativa —insertar en el medio y
   * arrastrar los de abajo— es la clase de optimizacion que acaba dejando dos
   * corredores con el mismo puesto por un fallo a medio camino.
   */
  async recalcularPuestos(marathonId: string): Promise<void> {
    const resultados = await this.prisma.raceResult.findMany({
      where: { registration: { marathonId, deletedAt: null } },
      orderBy: [{ finishTimeSeconds: 'asc' }, { finishedAt: 'asc' }],
      select: {
        id: true,
        finishTimeSeconds: true,
        overallRank: true,
        categoryRank: true,
        registration: { select: { categoryId: true } },
      },
    });

    // Por cada clasificacion se llevan dos cuentas: cuantos van (que decide el
    // puesto del siguiente que mejore el tiempo) y el ultimo tiempo visto (que
    // decide si hay empate). Con una sola no se pueden tener las dos cosas.
    const general = { vistos: 0, puesto: 0, ultimoTiempo: null as number | null };
    const porCategoria = new Map<string, typeof general>();
    const cambios: { id: string; overallRank: number; categoryRank: number | null }[] = [];

    const situar = (cuenta: typeof general, tiempo: number): number => {
      cuenta.vistos += 1;
      if (tiempo !== cuenta.ultimoTiempo) {
        cuenta.puesto = cuenta.vistos;
        cuenta.ultimoTiempo = tiempo;
      }
      return cuenta.puesto;
    };

    for (const r of resultados) {
      const overallRank = situar(general, r.finishTimeSeconds);

      const clave = r.registration.categoryId;
      let categoryRank: number | null = null;

      if (clave !== null) {
        const cuenta = porCategoria.get(clave) ?? { vistos: 0, puesto: 0, ultimoTiempo: null };
        porCategoria.set(clave, cuenta);
        categoryRank = situar(cuenta, r.finishTimeSeconds);
      }

      if (r.overallRank !== overallRank || r.categoryRank !== categoryRank) {
        cambios.push({ id: r.id, overallRank, categoryRank });
      }
    }

    if (cambios.length === 0) return;

    await this.prisma.$transaction(
      cambios.map((c) =>
        this.prisma.raceResult.update({
          where: { id: c.id },
          data: { overallRank: c.overallRank, categoryRank: c.categoryRank },
        }),
      ),
    );

    this.logger.log(`Puestos recalculados en ${marathonId}: ${cambios.length} resultados`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Internos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * El filtro por `userId` va dentro del `where`, no en un `if` posterior, y un
   * id ajeno devuelve 404 y no 403: contestar "existe pero no es tuya"
   * convertiria el endpoint en un oraculo para descubrir quien corrio que.
   */
  private async buscarPropia(userId: string, registrationId: string): Promise<CarreraConTodo> {
    const carrera = await this.prisma.registration.findFirst({
      where: {
        id: registrationId,
        userId,
        deletedAt: null,
        status: RegistrationStatus.confirmed,
      },
      include: INSCRIPCION_DE_LA_CARRERA,
    });

    if (!carrera) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La carrera no existe', HttpStatus.NOT_FOUND);
    }

    return carrera;
  }

  private exigirResultado(carrera: CarreraConTodo) {
    if (!carrera.raceResult) {
      throw new AppException(
        ErrorCode.RESULT_NOT_AVAILABLE,
        'Esta carrera todavia no tiene resultado',
        HttpStatus.CONFLICT,
      );
    }

    return carrera.raceResult;
  }

  private toCheckpoints(
    marcas: {
      kmMark: number;
      lat: number | null;
      lng: number | null;
      passedAt: Date;
      splitSeconds: number;
    }[],
  ) {
    return marcas.map((c) => ({
      kmMark: c.kmMark,
      lat: c.lat,
      lng: c.lng,
      passedAt: c.passedAt.toISOString(),
      splitSeconds: c.splitSeconds,
    }));
  }

  private async splitsDe(workoutId: string | null) {
    if (!workoutId) return [];

    return this.prisma.workoutSplit.findMany({
      where: { workoutId },
      orderBy: { index: 'asc' },
      select: {
        index: true,
        distanceMeters: true,
        durationSeconds: true,
        paceSecPerKm: true,
        elevationGainMeters: true,
      },
    });
  }

  private async posicionesDe(workoutId: string): Promise<Punto[]> {
    return this.prisma.position.findMany({
      where: { workoutId },
      orderBy: { recordedAt: 'asc' },
      take: MAX_POSICIONES,
      select: { recordedAt: true, lat: true, lng: true, altitude: true, accuracyMeters: true },
    });
  }

  private async recorridoDe(workoutId: string | null) {
    if (!workoutId) return null;

    const puntos = await this.posicionesDe(workoutId);
    if (puntos.length < 2) return null;

    const { puntos: simplificados, toleranciaMetros } = simplificarHasta(puntos);
    this.logger.debug(
      `Recorrido de ${workoutId}: ${puntos.length} puntos a ${simplificados.length} (${toleranciaMetros} m)`,
    );

    return aLineString(simplificados);
  }

  /** Cuantos terminaron la maraton. Solo se consulta si hay resultado que situar. */
  private async finishersDe(marathonId: string, hayResultado: boolean): Promise<number | null> {
    if (!hayResultado) return null;

    return this.prisma.raceResult.count({
      where: { registration: { marathonId, deletedAt: null } },
    });
  }

  private toResumen(carrera: CarreraConTodo, finishers: number | null = null) {
    const resultado = carrera.raceResult;
    const pasada = carrera.marathon.startsAt.getTime() <= Date.now();

    return {
      registrationId: carrera.id,
      marathon: {
        ...carrera.marathon,
        startsAt: carrera.marathon.startsAt.toISOString(),
        coverUrl: this.storage.publicUrl(carrera.marathon.coverUrl),
        // La largada real. Con esto la app sabe, al abrirse, si tiene que estar
        // en la pantalla de carrera aunque se haya perdido el aviso del socket.
        liveStartedAt: carrera.marathon.liveStartedAt?.toISOString() ?? null,
        liveFinishedAt: carrera.marathon.liveFinishedAt?.toISOString() ?? null,
        // La preparacion viaja **aqui y no en el catalogo**: es lo que bloquea
        // la app, y solo puede bloquearsela a quien tiene inscripcion
        // confirmada en esta carrera. Este endpoint devuelve exactamente eso,
        // asi que nadie mas puede llegar a ver el aviso.
        preparingAt: carrera.marathon.preparingAt?.toISOString() ?? null,
        preparingMessage: carrera.marathon.preparingMessage,
        liveState: estadoEnVivo(carrera.marathon),
      },
      bibNumber: carrera.bibNumber,
      categoryName: carrera.category?.name ?? null,
      status: pasada ? RaceStatusFilter.completed : RaceStatusFilter.upcoming,
      paymentStatus: carrera.payments[0]?.status ?? null,
      registeredAt: carrera.registeredAt?.toISOString() ?? null,
      result: resultado
        ? {
            finishTimeSeconds: resultado.finishTimeSeconds,
            chipTimeSeconds: resultado.chipTimeSeconds,
            distanceMeters: resultado.distanceMeters,
            // Si el entrenamiento no dejo ritmo medio, se deriva del resultado
            // en vez de responder `null`: la pantalla tiene un hueco que llenar.
            avgPaceSecPerKm:
              resultado.avgPaceSecPerKm ??
              ritmo(resultado.distanceMeters, resultado.finishTimeSeconds),
            avgSpeedMps: resultado.avgSpeedMps,
            elevationGainMeters: resultado.elevationGainMeters,
            bestKmIndex: resultado.bestKmIndex,
            overallRank: resultado.overallRank,
            categoryRank: resultado.categoryRank,
            finishers,
            finishedAt: resultado.finishedAt.toISOString(),
            // En la base se guarda la **clave** del archivo, no la URL: mudar de
            // dominio o de driver no invalida ninguna fila.
            shareCardUrl: resultado.shareCardUrl ? this.storage.url(resultado.shareCardUrl) : null,
            workoutId: resultado.workoutId,
          }
        : null,
    };
  }
}

/**
 * Nombre para la tarjeta. `personalData` es jsonb libre: una fila vieja o
 * tocada a mano no deberia tumbar la generacion de una imagen.
 */
function nombreDelCorredor(personalData: Prisma.JsonValue): string {
  if (personalData && typeof personalData === 'object' && !Array.isArray(personalData)) {
    const nombre = (personalData as Record<string, unknown>).fullName;
    if (typeof nombre === 'string' && nombre.trim() !== '') return nombre.trim();
  }

  return 'Corredor';
}
