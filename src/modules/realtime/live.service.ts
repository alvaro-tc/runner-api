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
import { avanzar, haLlegado, prepararRecorrido, type Recorrido } from './course';

/** Cuanto puede estar callada una sesion antes de que se tire su estado. */
const MAX_EDAD_MS = 8 * 60 * 60 * 1000;

/** A partir de cuantos corredores en memoria se barre lo abandonado. */
const UMBRAL_DE_PODA = 200;

/**
 * Fraccion de la distancia oficial que hay que cubrir para dar por acabada una
 * maraton **sin trazado cargado**.
 *
 * Es el plan B, no la regla: sin linea oficial no hay forma de comprobar que
 * alguien siguio la ruta, y lo unico que queda es su cuentakilometros. El 98 %
 * absorbe lo que el GPS recorta en las curvas — un movil siempre mide de menos,
 * nunca de mas — sin regalar medio kilometro.
 */
const FRACCION_SIN_TRAZADO = 0.98;

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
/** Lo que hace falta de una maraton para decidir si alguien llego. */
interface Curso {
  recorrido: Recorrido | null;
  distanceMeters: number;
}

@Injectable()
export class LiveService {
  private readonly logger = new Logger(LiveService.name);
  private readonly estados = new Map<string, EstadoCorredor>();

  /** Trazado por maraton, medido una vez. Ver `cursoDe`. */
  private readonly cursos = new Map<string, Curso>();

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
  ): Promise<boolean> {
    if (!sesion.marathonId || puntos.length === 0) return false;

    try {
      const estado = await this.estadoDe(sesion.id, sesion.marathonId, sesion.workoutId);
      const ultimo = acumular(estado, puntos);
      if (!ultimo) return false;

      const llego = await this.seguirRuta(sesion.id, estado, puntos);
      const ahora = Date.now();

      if (!debeEmitir(estado, ahora, this.intervaloMinimo()) && !llego) return llego;

      estado.ultimoEnvioMs = ahora;
      this.gateway.emitirPosicion(estado.marathonId, aPayload(estado, ultimo));

      if (llego) {
        this.gateway.emitirLlegada(estado.marathonId, {
          bib: estado.bib,
          distanceMeters: Math.round(estado.distanceMeters),
          t: ultimo.recordedAt.toISOString(),
        });
      }

      return llego;
    } catch (error) {
      // Nunca hacia arriba: el lote ya esta guardado y el corredor no tiene por
      // que enterarse de que el mapa de espectadores se cayo.
      this.logger.warn(
        { err: error, sessionId: sesion.id },
        'No se pudo publicar la posicion en vivo; el lote se guardo igual',
      );
      return false;
    }
  }

  /**
   * Mueve al corredor por el trazado oficial y dice si acaba de cruzar la meta.
   *
   * **La distancia recorrida no decide nada.** En una ida y vuelta cualquiera
   * puede juntar los 21 km dandose media vuelta antes del punto de giro, y el
   * arco de meta esta a diez metros del de salida, asi que la cercania tampoco
   * sirve. Lo que se mide es cuanta *linea oficial* lleva cubierta, punto a
   * punto y siempre hacia delante: ver `course.ts`.
   *
   * La marca se escribe en la base antes de anunciar nada. El cierre de la
   * sesion viene detras y puede fallar —una consolidacion pesada, un timeout—;
   * sin esta fila no quedaria rastro de que la llegada llego a detectarse.
   */
  private async seguirRuta(
    sessionId: string,
    estado: EstadoCorredor,
    puntos: readonly PuntoLive[],
  ): Promise<boolean> {
    if (estado.terminado) return false;

    const curso = await this.cursoDe(estado.marathonId);
    let llego = false;

    if (curso.recorrido) {
      for (const punto of puntos) {
        estado.progresoM = avanzar(curso.recorrido, estado.progresoM, punto);
        if (haLlegado(curso.recorrido, estado.progresoM, punto)) {
          llego = true;
          break;
        }
      }
    } else {
      // Sin trazado cargado no hay ruta que comprobar: solo queda el
      // cuentakilometros del propio corredor.
      llego =
        curso.distanceMeters > 0 &&
        estado.distanceMeters >= curso.distanceMeters * FRACCION_SIN_TRAZADO;
    }

    if (!llego) return false;

    estado.terminado = true;
    await this.prisma.trackingSession.update({
      where: { id: sessionId },
      data: { finishDetectedAt: new Date() },
    });
    this.logger.log(`Llegada detectada: dorsal ${estado.bib ?? '?'} en ${estado.marathonId}`);

    return true;
  }

  /**
   * El trazado de una maraton, medido una sola vez.
   *
   * Son miles de vertices y esto vive en el camino caliente de la ingesta:
   * releerlo y remedirlo en cada lote seria una consulta y un recorrido entero
   * de la polilinea por corredor cada veinte segundos. Un trazado no cambia
   * durante la carrera; si el organizador lo edita, el proceso se reinicia.
   */
  private async cursoDe(marathonId: string): Promise<Curso> {
    const cacheado = this.cursos.get(marathonId);
    if (cacheado) return cacheado;

    const maraton = await this.prisma.marathon.findUnique({
      where: { id: marathonId },
      select: { routeGeoJson: true, distanceMeters: true },
    });

    const curso: Curso = {
      recorrido: prepararRecorrido(maraton?.routeGeoJson),
      distanceMeters: maraton?.distanceMeters ?? 0,
    };
    this.cursos.set(marathonId, curso);

    return curso;
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
    // El trazado tampoco hace falta ya, y soltarlo es lo que hace que una
    // edicion del recorrido entre sin reiniciar el proceso.
    this.cursos.delete(estado.marathonId);
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
