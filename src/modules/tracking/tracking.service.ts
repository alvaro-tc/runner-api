import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LiveService } from '../realtime/live.service';
import { WorkoutSessionsService } from '../workouts/workout-sessions.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PositionSource, TrackingSessionStatus } from '../../../generated/prisma/enums';
import type { SesionDeIngesta } from './ingest-token.guard';
import type { PuntoNormalizado } from './sources/position-ingestion-source';
import type { SimulateDto } from './dto/tracking.dto';

/**
 * Cuanto puede adelantarse el reloj del dispositivo, en milisegundos.
 *
 * Los relojes de los telefonos derivan segundos, y un lote tarda en llegar. Sin
 * margen se rechazarian puntos buenos por una diferencia de reloj que no es
 * culpa de nadie; con demasiado margen entran fechas inventadas que rompen la
 * duracion del entrenamiento.
 *
 * ponytail: margen fijo; si aparecen dispositivos con deriva grande, calcular
 * el desfase por sesion a partir de `receivedAt - recordedAt`.
 */
const FUTURO_TOLERADO_MS = 2 * 60 * 1000;

/** Igual, hacia atras: un punto justo anterior al arranque no es basura. */
const ANTES_DEL_INICIO_TOLERADO_MS = 60 * 1000;

/** Filas por `createMany`. Un lote normal cabe entero; el tope acota el atrasado. */
const TAMANO_LOTE = 1000;

export interface ResultadoIngesta {
  accepted: number;
  duplicated: number;
  rejected: number;
  reasons: Record<string, number>;
}
/** Por que se descarto un punto. Viaja en la respuesta para poder diagnosticar. */
type Motivo = 'future' | 'before_session' | 'invalid_coordinates';

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly sesiones: WorkoutSessionsService,
  ) {}

  /**
   * Guarda un lote de puntos en la sesion.
   *
   * **Idempotente por `clientPointId`.** Reenviar un lote entero es seguro: los
   * repetidos caen en el `ON CONFLICT DO NOTHING` del indice unico. Eso es lo
   * que permite al cliente reintentar a ciegas cuando se le corta la senal, que
   * es el caso normal y no la excepcion.
   *
   * Responde rapido y no calcula nada: el post-procesado pesado (splits
   * parciales, publicacion a espectadores) no va en el request.
   */
  async ingerir(
    sesion: SesionDeIngesta,
    puntos: readonly PuntoNormalizado[],
    source: PositionSource,
  ): Promise<ResultadoIngesta> {
    const reasons: Record<string, number> = {};
    const validos: PuntoNormalizado[] = [];
    const ahora = Date.now();

    for (const punto of puntos) {
      const motivo = this.motivoDeDescarte(punto, sesion, ahora);
      if (motivo) {
        reasons[motivo] = (reasons[motivo] ?? 0) + 1;
        continue;
      }
      validos.push(punto);
    }

    const rejected = puntos.length - validos.length;
    if (validos.length === 0) return { accepted: 0, duplicated: 0, rejected, reasons };

    await this.prisma.ensurePositionsPartitions(validos.map((p) => p.recordedAt));

    let accepted = 0;
    for (let i = 0; i < validos.length; i += TAMANO_LOTE) {
      const { count } = await this.prisma.position.createMany({
        data: validos.slice(i, i + TAMANO_LOTE).map((p) => ({
          trackingSessionId: sesion.id,
          userId: sesion.userId,
          deviceId: sesion.deviceId,
          recordedAt: p.recordedAt,
          lat: p.lat,
          lng: p.lng,
          altitude: p.altitude,
          speedMps: p.speedMps,
          accuracyMeters: p.accuracyMeters,
          heading: p.heading,
          batteryLevel: p.batteryLevel,
          source,
          clientPointId: p.clientPointId,
        })),
        // Dedupe por `(clientPointId, recordedAt)`: reintentar no duplica.
        skipDuplicates: true,
      });
      accepted += count;
    }

    // Las posiciones NO se cuelgan del workout aqui, sino al cerrar la sesion:
    // hasta entonces podrian acabar en un entrenamiento descartado.
    const ultimo = validos.reduce(
      (max, p) => (p.recordedAt > max ? p.recordedAt : max),
      new Date(0),
    );
    await this.prisma.trackingSession.update({
      where: { id: sesion.id },
      data: { lastPositionAt: ultimo },
    });

    if (rejected > 0) {
      this.logger.debug(
        { sessionId: sesion.id, rejected, reasons },
        'Puntos descartados en la ingesta',
      );
    }

    // Despues de guardar y nunca antes: lo que no puede perderse es el punto
    // en la base. `publicar` no lanza —si el mapa se cae, el lote ya esta a
    // salvo— y el throttling decide dentro si esto llega a emitir algo.
    const llego = await this.live.publicar(sesion, validos);

    if (llego) await this.cerrarPorLlegada(sesion);

    return { accepted, duplicated: validos.length - accepted, rejected, reasons };
  }

  /**
   * Cierra la carrera de quien acaba de cruzar la meta.
   *
   * **Lo cierra el servidor y no el movil** porque el movil puede no estar en
   * condiciones de hacerlo: la pantalla apagada en el bolsillo, la app matada
   * por el sistema tras cuatro horas, el telefono sin bateria en el arco. El
   * corredor cruzo la meta de verdad y su resultado no puede depender de que su
   * telefono siga vivo para avisar. Con Traccar subiendo por su cuenta, la app
   * puede llevar horas sin ejecutar una linea.
   *
   * Es el **mismo** cierre que llama el boton de finalizar: consolida las
   * metricas, cuelga las posiciones del entrenamiento y produce el resultado
   * oficial. Un segundo camino con sus propias reglas es como se acaba con dos
   * tiempos distintos para la misma carrera.
   *
   * No propaga: el lote ya esta guardado, y devolver un 500 a la ingesta por
   * esto haria que el movil reintentara el mismo lote en bucle.
   */
  private async cerrarPorLlegada(sesion: SesionDeIngesta): Promise<void> {
    try {
      await this.sesiones.finalizar(sesion.userId, sesion.id, {});
      this.logger.log(`Carrera cerrada por llegada detectada: sesion ${sesion.id}`);
    } catch (error) {
      this.logger.warn(
        { err: error, sessionId: sesion.id },
        'No se pudo cerrar la sesion tras detectar la llegada; los puntos se guardaron igual',
      );
    }
  }

  /**
   * Resuelve la sesion a la que apunta un dispositivo por su `uniqueId`.
   *
   * Es lo que hace posible el protocolo OsmAnd, que no tiene donde meter un
   * token de sesion: el tracker solo sabe decir quien es. Si el dispositivo no
   * tiene ninguna sesion abierta no hay nada que hacer con el punto —no vamos a
   * abrir una sesion por un GET suelto, porque entonces cualquier tracker
   * olvidado encendido crearia entrenamientos fantasma.
   */
  async sesionDeDispositivo(uniqueId: string): Promise<SesionDeIngesta> {
    const sesion = await this.prisma.trackingSession.findFirst({
      where: {
        device: { uniqueId },
        status: { in: [TrackingSessionStatus.active, TrackingSessionStatus.paused] },
      },
      orderBy: { startedAt: 'desc' },
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

    if (!sesion) {
      throw new AppException(
        ErrorCode.SESSION_NOT_ACTIVE,
        'Ese dispositivo no tiene ninguna sesion de tracking abierta',
        HttpStatus.CONFLICT,
      );
    }

    return sesion;
  }

  /**
   * Reproduce un track en una sesion abierta. Solo fuera de produccion.
   *
   * Existe porque la alternativa para probar el tracking es salir a correr, y
   * eso convierte cada cambio en `metrics.ts` en una hora de calle. Reutiliza
   * `ingerir()` entera: si la simulacion pasa, el camino real tambien.
   *
   * Los puntos se generan hacia atras desde ahora y la sesion se retrasa para
   * que quepan: un track de veinte minutos en una sesion recien arrancada
   * tendria todos los puntos en el futuro y se descartaria solo.
   */
  async simular(sesion: SesionDeIngesta, dto: SimulateDto): Promise<ResultadoIngesta> {
    const intervalo = (dto.intervalSeconds ?? 1) * 1000;
    const fin = Date.now();
    const inicio = fin - (dto.coordinates.length - 1) * intervalo;

    if (inicio < sesion.startedAt.getTime()) {
      await this.prisma.trackingSession.update({
        where: { id: sesion.id },
        data: { startedAt: new Date(inicio) },
      });
      sesion = { ...sesion, startedAt: new Date(inicio) };
    }

    const marca = Date.now();
    const puntos: PuntoNormalizado[] = dto.coordinates.map(([lng, lat], i) => ({
      // La marca evita que dos simulaciones seguidas en la misma sesion se
      // dedupliquen entre ellas cuando caen en el mismo segundo.
      clientPointId: `sim-${marca}-${i}`,
      recordedAt: new Date(inicio + i * intervalo),
      lat,
      lng,
      altitude: null,
      speedMps: null,
      accuracyMeters: 5,
      heading: null,
      batteryLevel: null,
    }));

    // ponytail: se marcan como `app_batch` porque el enum de la base no tiene
    // un valor para simulacion; el prefijo `sim-` del `clientPointId` alcanza
    // para distinguirlos. Si algun dia hay que filtrarlos en consultas, ahi si
    // toca migracion.
    return this.ingerir(sesion, puntos, PositionSource.app_batch);
  }

  /**
   * Un punto solo se rechaza por lo que lo hace **imposible**, no por lo que lo
   * hace malo.
   *
   * La precision mala no se filtra aqui: el punto se guarda y se descarta al
   * consolidar (`metrics.ts`). Guardarlo cuesta una fila y permite recalcular
   * un entrenamiento con otro umbral el dia que haga falta; tirarlo en la
   * ingesta es una decision irreversible tomada con la peor informacion.
   */
  private motivoDeDescarte(
    punto: PuntoNormalizado,
    sesion: SesionDeIngesta,
    ahora: number,
  ): Motivo | null {
    const t = punto.recordedAt.getTime();

    if (!Number.isFinite(t)) return 'future';
    if (t > ahora + FUTURO_TOLERADO_MS) return 'future';
    if (t < sesion.startedAt.getTime() - ANTES_DEL_INICIO_TOLERADO_MS) return 'before_session';

    if (
      !Number.isFinite(punto.lat) ||
      !Number.isFinite(punto.lng) ||
      Math.abs(punto.lat) > 90 ||
      Math.abs(punto.lng) > 180
    ) {
      return 'invalid_coordinates';
    }

    return null;
  }
}
