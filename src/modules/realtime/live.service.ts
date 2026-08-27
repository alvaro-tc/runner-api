import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { LiveGateway } from './live.gateway';
import {
  aPayload,
  acumular,
  foto,
  debeEmitir,
  nuevoEstado,
  podar,
  type EstadoCorredor,
  type EstadoDeMaraton,
  type PuntoLive,
} from './live-state';

/** Cuanto puede estar callada una sesion antes de que se tire su estado. */
const MAX_EDAD_MS = 8 * 60 * 60 * 1000;

/** A partir de cuantos corredores en memoria se barre lo abandonado. */
const UMBRAL_DE_PODA = 200;

/**
 * Publicacion de posiciones a los espectadores.
 *
 * Se llama desde la ingesta, **despues** de guardar. El orden importa: lo que
 * no puede perderse es el punto en la base, y una caida del bus de eventos no
 * debe llevarse por delante un entrenamiento. Por eso ademas nada de esto
 * lanza: para el corredor que sube su lote, que haya o no espectadores es
 * irrelevante.
 *
 * ponytail: el estado por corredor vive **en memoria del proceso**. Con el
 * despliegue previsto —un VPS, un servicio systemd— es exacto. Con varias
 * instancias detras de un balanceador, cada una llevaria su propio contador y un
 * corredor podria emitir hasta N veces por ventana; el arreglo es un
 * `SET clave NX PX <ventana>` en Redis en lugar de este mapa, unas cinco lineas.
 * El adapter de Redis ya esta puesto, asi que las salas si funcionan repartidas.
 */
@Injectable()
export class LiveService {
  private readonly logger = new Logger(LiveService.name);
  private readonly estados = new Map<string, EstadoCorredor>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly gateway: LiveGateway,
  ) {}

  /**
   * Publica el ultimo punto de un lote, si toca.
   *
   * Solo se publica lo que es una **carrera**: una sesion sin `marathonId` es
   * un entrenamiento cualquiera, y la posicion de alguien corriendo por su
   * barrio no tiene espectadores ni debe tenerlos.
   */
  async publicar(
    sesion: { id: string; workoutId: string | null; marathonId: string | null },
    puntos: readonly PuntoLive[],
  ): Promise<void> {
    if (!sesion.marathonId || puntos.length === 0) return;

    try {
      const estado = await this.estadoDe(sesion.id, sesion.marathonId, sesion.workoutId);
      const ultimo = acumular(estado, puntos);
      const ahora = Date.now();

      if (!ultimo || !debeEmitir(estado, ahora, this.intervaloMinimo())) return;

      estado.ultimoEnvioMs = ahora;
      this.gateway.emitirPosicion(estado.marathonId, aPayload(estado, ultimo));
    } catch (error) {
      // Nunca hacia arriba: el lote ya esta guardado y el corredor no tiene por
      // que enterarse de que el mapa de espectadores se cayo.
      this.logger.warn(
        { err: error, sessionId: sesion.id },
        'No se pudo publicar la posicion en vivo; el lote se guardo igual',
      );
    }
  }

  /**
   * Anuncia que la maraton arranco o termino.
   *
   * La llama el panel de admin. Al terminar se olvidan los corredores de esa
   * carrera: sus estados ya no valen para nada y quedarse con ellos es guardar
   * la ultima posicion conocida de un monton de gente sin motivo.
   */
  anunciar(estado: EstadoDeMaraton): void {
    this.gateway.emitirEstado(estado.marathonId, estado);

    if (!estado.finishedAt) return;

    for (const [sessionId, corredor] of this.estados) {
      if (corredor.marathonId === estado.marathonId) this.estados.delete(sessionId);
    }
  }

  /** Donde va cada corredor de esa maraton ahora mismo. */
  posiciones(marathonId: string) {
    return foto(this.estados, marathonId);
  }

  /** Olvida a un corredor. La llama el cierre o el descarte de la sesion. */
  olvidar(sessionId: string): void {
    this.estados.delete(sessionId);
  }

  private intervaloMinimo(): number {
    return this.config.get('LIVE_UPDATE_MIN_INTERVAL_MS');
  }

  /**
   * El estado del corredor, creandolo la primera vez.
   *
   * El dorsal se resuelve **una sola vez por sesion** y se queda cacheado: es un
   * dato que no cambia durante una carrera, y consultarlo en cada lote seria una
   * consulta cada veinte segundos por corredor para leer siempre lo mismo.
   */
  private async estadoDe(
    sessionId: string,
    marathonId: string,
    workoutId: string | null,
  ): Promise<EstadoCorredor> {
    const existente = this.estados.get(sessionId);
    if (existente) return existente;

    if (this.estados.size >= UMBRAL_DE_PODA) {
      const tirados = podar(this.estados, Date.now(), MAX_EDAD_MS);
      if (tirados > 0) this.logger.debug(`Podados ${tirados} corredores sin actividad`);
    }

    const estado = nuevoEstado(marathonId, await this.dorsalDe(workoutId));
    this.estados.set(sessionId, estado);

    return estado;
  }

  private async dorsalDe(workoutId: string | null): Promise<string | null> {
    if (!workoutId) return null;

    const workout = await this.prisma.workout.findUnique({
      where: { id: workoutId },
      select: { registration: { select: { bibNumber: true } } },
    });

    return workout?.registration?.bibNumber ?? null;
  }
}
