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
import { RegistrationStatus } from '../../../generated/prisma/enums';

/** Cuanto puede estar callada una sesion antes de que se tire su estado. */
const MAX_EDAD_MS = 8 * 60 * 60 * 1000;

/**
 * Cuanto vale una resolucion dispositivo → maraton en preparacion.
 *
 * Sin cache seria una consulta por punto y por corredor: OsmAnd manda un punto
 * por peticion, asi que en la salida serian cientos por segundo para leer
 * siempre lo mismo. Un minuto es lo que puede tardar en aparecer en el mapa
 * quien acaba de encender el telefono, y eso en la salida no lo nota nadie.
 */
const TTL_CALENTAMIENTO_MS = 60_000;

/** A partir de cuantos dispositivos cacheados se barre lo caducado. */
const UMBRAL_CACHE_CALENTAMIENTO = 500;

/** Donde corre un dispositivo que todavia no tiene sesion abierta. */
interface Calentamiento {
  deviceId: string;
  marathonId: string;
  bib: string | null;
}

/** Clave del estado de un corredor que aun no arranco su sesion. */
function claveDeDispositivo(deviceId: string): string {
  return `device:${deviceId}`;
}

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

  /** `uniqueId` → donde calienta, o `null` si no calienta en ningun lado. */
  private readonly calentamientos = new Map<
    string,
    { hasta: number; donde: Calentamiento | null }
  >();

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
    sesion: {
      id: string;
      workoutId: string | null;
      marathonId: string | null;
      deviceId?: string | null;
    },
    puntos: readonly PuntoLive[],
  ): Promise<boolean> {
    if (!sesion.marathonId || puntos.length === 0) return false;

    // Ya corre de verdad: su estado de calentamiento sobra, y dejarlo pondria
    // dos marcadores con el mismo dorsal en la foto del mapa.
    if (sesion.deviceId) this.estados.delete(claveDeDispositivo(sesion.deviceId));

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
   *
   * Va tambien a la sala personal de cada inscrito: el corredor con la app
   * abierta en cualquier otra pantalla se entera igual, sin depender de que
   * hubiera pedido ver esta maraton. Si esa consulta falla el aviso sale de
   * todas formas por la sala de la maraton —lo que no puede pasar es que la
   * largada se quede sin anunciar porque la base tosio—.
   */
  async anunciar(estado: EstadoDeMaraton): Promise<void> {
    const inscritos = await this.inscritosDe(estado.marathonId).catch((error: unknown) => {
      this.logger.warn({ err: error, marathonId: estado.marathonId }, 'No se pudo leer inscritos');
      return [] as string[];
    });

    this.gateway.emitirEstado(estado.marathonId, estado, inscritos);

    if (!estado.finishedAt) return;

    for (const [sessionId, corredor] of this.estados) {
      if (corredor.marathonId === estado.marathonId) this.estados.delete(sessionId);
    }
    // El trazado tampoco hace falta ya, y soltarlo es lo que hace que una
    // edicion del recorrido entre sin reiniciar el proceso.
    this.cursos.delete(estado.marathonId);
  }

  /**
   * Avisa al dueño de una inscripcion de que algo cambio en ella.
   *
   * Es lo que hace inmediato el "pago validado": quien espera revision no esta
   * en ninguna sala de maraton todavia. No lleva datos —solo el id— porque
   * quien lo recibe relee `GET /registrations/me`, que es la fuente.
   *
   * No lanza nunca: la validacion del pago ya ocurrio, y que el aviso no salga
   * solo significa que el corredor lo vera en el siguiente sondeo.
   */
  async anunciarInscripcion(registrationId: string): Promise<void> {
    try {
      const registro = await this.prisma.registration.findUnique({
        where: { id: registrationId },
        select: { userId: true },
      });

      if (registro) this.gateway.emitirInscripcion(registro.userId, registrationId);
    } catch (error) {
      this.logger.warn(
        { err: error, registrationId },
        'No se pudo avisar del cambio de inscripcion',
      );
    }
  }

  /**
   * Publica la posicion de quien todavia no arranco su sesion de carrera.
   *
   * Entre "en preparacion" y la largada el corredor ya esta en la salida y el
   * organizador quiere verlo, pero no hay sesion: la abre la largada. Estos
   * puntos **no se guardan** —son de antes de la carrera y no pueden acabar en
   * el entrenamiento— y solo se publican en la sala de la maraton, con
   * `distanceMeters: 0`: nadie ha recorrido nada todavia.
   *
   * Devuelve si el dispositivo estaba efectivamente calentando; el que no,
   * sigue siendo un error de ingesta.
   */
  async publicarCalentamiento(uniqueId: string, puntos: readonly PuntoLive[]): Promise<boolean> {
    if (puntos.length === 0) return false;

    const donde = await this.calentamientoDe(uniqueId);
    if (!donde) return false;

    const clave = claveDeDispositivo(donde.deviceId);
    let estado = this.estados.get(clave);

    if (!estado) {
      estado = nuevoEstado(donde.marathonId, donde.bib);
      this.estados.set(clave, estado);
    }

    const ultimo = acumular(estado, puntos);
    if (!ultimo) return true;

    const ahora = Date.now();
    if (!debeEmitir(estado, ahora, this.intervaloMinimo())) return true;

    estado.ultimoEnvioMs = ahora;
    this.gateway.emitirPosicion(donde.marathonId, {
      ...aPayload(estado, ultimo),
      distanceMeters: 0,
    });

    return true;
  }

  /**
   * Donde calienta un dispositivo, cacheado un minuto.
   *
   * Se cachea tambien el "en ningun lado": si no, un tracker olvidado encendido
   * consultaria la base una vez por segundo para siempre.
   *
   * ponytail: cache en memoria del proceso, como el resto de este servicio. Con
   * varias instancias cada una lleva la suya, que es correcto —solo duplica la
   * consulta, no el resultado—.
   */
  private async calentamientoDe(uniqueId: string): Promise<Calentamiento | null> {
    const ahora = Date.now();
    const cacheado = this.calentamientos.get(uniqueId);
    if (cacheado && cacheado.hasta > ahora) return cacheado.donde;

    const device = await this.prisma.device.findUnique({
      where: { uniqueId },
      select: { id: true, userId: true },
    });

    const registro = device
      ? await this.prisma.registration.findFirst({
          where: {
            userId: device.userId,
            status: RegistrationStatus.confirmed,
            deletedAt: null,
            // La maraton que esta en preparacion: ni antes ni despues de eso hay
            // nada que pintar en el mapa de la salida.
            marathon: { preparingAt: { not: null }, liveStartedAt: null, liveFinishedAt: null },
          },
          select: { marathonId: true, bibNumber: true },
        })
      : null;

    const donde: Calentamiento | null =
      device && registro
        ? { deviceId: device.id, marathonId: registro.marathonId, bib: registro.bibNumber }
        : null;

    if (this.calentamientos.size >= UMBRAL_CACHE_CALENTAMIENTO) {
      for (const [clave, entrada] of this.calentamientos) {
        if (entrada.hasta <= ahora) this.calentamientos.delete(clave);
      }
    }

    this.calentamientos.set(uniqueId, { hasta: ahora + TTL_CALENTAMIENTO_MS, donde });

    return donde;
  }

  /** Quien corre esta maraton, para avisarles por su sala personal. */
  private async inscritosDe(marathonId: string): Promise<string[]> {
    const filas = await this.prisma.registration.findMany({
      where: { marathonId, status: RegistrationStatus.confirmed, deletedAt: null },
      select: { userId: true },
    });

    return filas.map((f) => f.userId);
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
