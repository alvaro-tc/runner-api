/**
 * Estado por corredor mientras esta en carrera.
 *
 * Todo lo que decide **si** y **que** se publica a los espectadores vive aqui,
 * como funciones puras sobre un objeto: sin sockets, sin Redis y sin reloj
 * propio. Asi el throttling —que es lo unico no trivial de este modulo— se
 * prueba en milisegundos en vez de levantando dos clientes y esperando.
 */

import { haversine, type Punto } from '../workouts/metrics';

/** Lo minimo que necesita un punto para entrar en la cuenta. */
export type PuntoLive = Pick<Punto, 'recordedAt' | 'lat' | 'lng'>;

export interface EstadoCorredor {
  marathonId: string;
  /** Dorsal. Es lo unico que ve el espectador: nunca el nombre ni el userId. */
  bib: string | null;
  /** Ultimo instante en que se emitio algo, en ms epoch. 0 = nunca. */
  ultimoEnvioMs: number;
  /** Distancia acumulada desde que el proceso conoce esta sesion. */
  distanceMeters: number;
  /** Ultima posicion vista, para encadenar la distancia entre lotes. */
  ultimoPunto: PuntoLive | null;
  /** Cuando se toco por ultima vez, para poder podar lo abandonado. */
  ultimoUsoMs: number;
}

export function nuevoEstado(marathonId: string, bib: string | null): EstadoCorredor {
  return {
    marathonId,
    bib,
    ultimoEnvioMs: 0,
    distanceMeters: 0,
    ultimoPunto: null,
    ultimoUsoMs: Date.now(),
  };
}

/**
 * Suma al estado la distancia del lote y devuelve el ultimo punto.
 *
 * Es una acumulacion **aproximada y a proposito**: no filtra por precision ni
 * descarta saltos imposibles, que es lo que si hace `consolidar()` al cerrar el
 * entrenamiento. Un mapa en vivo se mira a escala de kilometros y unos metros de
 * ruido no cambian nada; aplicar el filtrado bueno aqui significaria rehacer el
 * recorrido entero en cada lote.
 *
 * El numero que vale, y el que acaba en la clasificacion, es siempre el de la
 * consolidacion.
 */
export function acumular(estado: EstadoCorredor, puntos: readonly PuntoLive[]): PuntoLive | null {
  const ordenados = [...puntos].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  for (const punto of ordenados) {
    if (estado.ultimoPunto) {
      estado.distanceMeters += haversine(comoPunto(estado.ultimoPunto), comoPunto(punto));
    }
    estado.ultimoPunto = punto;
  }

  estado.ultimoUsoMs = Date.now();

  return estado.ultimoPunto;
}

/**
 * Si toca emitir a los espectadores.
 *
 * Un corredor manda un lote cada 15-30 s y dentro van 30 puntos. Reenviarlos
 * todos multiplicaria por treinta el trafico hacia cada espectador para dibujar
 * un movimiento que en el mapa son tres pixeles: con mil corredores y cien
 * espectadores eso son millones de mensajes por minuto para nada.
 *
 * Una posicion cada 5 s por corredor es mas de lo que cualquier mapa puede
 * animar, y acota la carga a algo que se puede calcular de antemano.
 */
export function debeEmitir(
  estado: EstadoCorredor,
  ahoraMs: number,
  intervaloMinimoMs: number,
): boolean {
  return ahoraMs - estado.ultimoEnvioMs >= intervaloMinimoMs;
}

/**
 * Tira los corredores que ya no mandan nada.
 *
 * Sin esto el mapa de estados crece con cada sesion que se abre y nunca baja:
 * una app que muere a mitad de carrera no avisa de nada, y su entrada se
 * quedaria en memoria hasta el siguiente despliegue.
 */
export function podar(
  estados: Map<string, EstadoCorredor>,
  ahoraMs: number,
  maxEdadMs: number,
): number {
  let tirados = 0;

  for (const [clave, estado] of estados) {
    if (ahoraMs - estado.ultimoUsoMs > maxEdadMs) {
      estados.delete(clave);
      tirados += 1;
    }
  }

  return tirados;
}

/** El payload que ve el espectador. Nada que identifique a la persona. */
export interface PosicionEnVivo {
  bib: string | null;
  lat: number;
  lng: number;
  distanceMeters: number;
  /** Instante del punto, ISO-8601 UTC. Corto a proposito: `t`, no `recordedAt`. */
  t: string;
}

export function aPayload(estado: EstadoCorredor, punto: PuntoLive): PosicionEnVivo {
  return {
    bib: estado.bib,
    lat: redondear(punto.lat),
    lng: redondear(punto.lng),
    distanceMeters: Math.round(estado.distanceMeters),
    t: punto.recordedAt.toISOString(),
  };
}

/** 5 decimales son ~1 m: mas precision no la pinta ningun mapa. */
function redondear(valor: number): number {
  return Math.round(valor * 1e5) / 1e5;
}

function comoPunto(p: PuntoLive): Punto {
  return { ...p, altitude: null, accuracyMeters: null };
}
