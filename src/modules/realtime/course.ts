/**
 * Seguimiento de un corredor **sobre el trazado oficial**.
 *
 * Decide dos cosas: cuando alguien cruzo la meta (en vivo, para cerrar su
 * sesion) y si de verdad **completo el recorrido** (al final, sobre todos sus
 * puntos, para la clasificacion).
 *
 * La idea central es el **avance a lo largo de la linea**: cuantos metros de
 * trazado lleva cubiertos, proyectando cada punto GPS sobre el recorrido y
 * avanzando siempre hacia delante. La distancia corrida no vale (en una ida y
 * vuelta se puede juntar sin tocar el punto de giro) y la cercania a la meta
 * tampoco (la meta suele estar junto a la salida).
 *
 * **Circuitos de varias vueltas.** El trazado de una vuelta se repite `laps`
 * veces en una sola linea continua. El corredor no "cierra" vueltas al pasar
 * por el arco: simplemente sigue avanzando por la linea, y la vuelta en la que
 * esta se deduce de los metros cubiertos. Asi pasar tres veces por la meta no
 * depende de que el GPS mande un punto justo bajo el arco en cada pasada: si
 * ese punto falta o cae a 80 m, la siguiente vuelta sigue enganchando igual.
 *
 * **GPS impreciso.** Tres defensas:
 *  - La tolerancia lateral crece con la precision que reporta el punto, y los
 *    puntos peores que `PRECISION_MAXIMA_M` se ignoran.
 *  - La ventana de busqueda hacia delante crece con el **tiempo** desde el
 *    ultimo punto bueno: un tunel o un movil que dejo de subir dos minutos no
 *    deja al corredor clavado para siempre. Pero el salto tiene que ser
 *    plausible tambien en linea recta, para que el ruido en el arco de un
 *    circuito no regale una vuelta entera a quien esta parado en la salida.
 *  - Al final se mide la **cobertura**: que fraccion de tramos de 250 m del
 *    recorrido tiene puntos. Quien corta camino o apago el GPS media carrera
 *    puede llegar al arco, pero no completa el recorrido.
 *
 * Funciones puras sobre datos planos: nada de Prisma, sockets ni reloj.
 */

import type { Coordenada } from '../races/route';

const METROS_POR_GRADO = 111_320;

/** Ventana hacia delante sin informacion de tiempo, o entre puntos seguidos. */
const VENTANA_ADELANTE_M = 400;
/** Y hacia detras: el GPS oscila y sin margen el avance se inflaria solo. */
const VENTANA_ATRAS_M = 150;

/** Separacion de la linea que se acepta con buena senal (ancho de avenida + error). */
const TOLERANCIA_LATERAL_M = 60;
/** Tope de tolerancia por mala que sea la precision: mas ancho ya es otra calle. */
const TOLERANCIA_MAXIMA_M = 120;
/** Puntos con peor precision que esto no se usan para seguir la ruta. */
const PRECISION_MAXIMA_M = 100;

/**
 * Velocidad que nadie supera corriendo (2:23 min/km). Limita cuanto puede
 * haber avanzado alguien durante un hueco sin puntos.
 */
const VELOCIDAD_MAXIMA_MPS = 7;
/**
 * Cuanto mas larga que la linea recta puede ser la ruta entre dos puntos.
 * Cubre curvas y zigzags; un salto de una vuelta entera parado en el arco
 * (linea recta ~0) queda fuera.
 */
const FACTOR_RUTA = 2;

/** Lo que puede faltar de linea al final y darlo por acabado. */
const MARGEN_META_M = 75;
/** Cerca del final, basta con estar junto al arco (punto de llegada perdido). */
const ULTIMO_TRAMO_M = 250;
const RADIO_META_M = 60;

/** Tamano de tramo para medir cobertura. */
const TRAMO_M = 250;
// ponytail: 80 % absorbe tuneles y cortes de senal tipicos; bajar si hay
// carreras con mucho tramo cubierto (galerias, bosque cerrado).
export const COBERTURA_MINIMA = 0.8;

/** Un trazado listo para medir: las `laps` vueltas puestas una tras otra. */
export interface Recorrido {
  puntos: Coordenada[];
  /** Metros de linea acumulados hasta cada punto. `acumulado[0] === 0`. */
  acumulado: number[];
  /** Metros de la carrera entera, todas las vueltas. */
  total: number;
  /** Metros de una vuelta (incluido el empalme del arco con la salida). */
  vuelta: number;
  laps: number;
}

/** Un punto GPS tal como llega. Tiempo y precision son opcionales pero ayudan. */
export interface PuntoRuta extends Coordenada {
  recordedAt?: Date;
  accuracyMeters?: number | null;
}

/** Donde va el corredor sobre la linea. */
export interface Pista {
  /** Metros de linea cubiertos desde la salida, todas las vueltas. Nunca baja. */
  progresoM: number;
  /** Hora (ms) del ultimo punto que engancho en la ruta. */
  t: number | null;
  /** Ultimo punto que engancho, para medir saltos en linea recta. */
  ancla: Coordenada | null;
}

export function pistaInicial(inicio?: Date | null): Pista {
  return { progresoM: 0, t: inicio?.getTime() ?? null, ancla: null };
}

/**
 * Deja el `routeGeoJson` en algo medible, o `null` si no hay trazado
 * utilizable. Se hace una vez por maraton: son miles de vertices.
 */
export function prepararRecorrido(geojson: unknown, laps = 1): Recorrido | null {
  const vuelta = coordenadasDe(geojson);
  if (vuelta.length < 2) return null;

  const n = Math.max(1, Math.floor(laps));
  const puntos: Coordenada[] = [];
  for (let k = 0; k < n; k++) puntos.push(...vuelta);

  const acumulado: number[] = [0];
  for (let i = 1; i < puntos.length; i++) {
    acumulado.push(acumulado[i - 1]! + metros(puntos[i - 1]!, puntos[i]!));
  }

  const total = acumulado[acumulado.length - 1]!;
  return { puntos, acumulado, total, vuelta: n > 1 ? acumulado[vuelta.length]! : total, laps: n };
}

/**
 * Mueve al corredor con un punto. Devuelve la misma `pista` si el punto no
 * sirve (mala precision, fuera de la ruta): el corredor se salio o el GPS se
 * fue, y en los dos casos lo honesto es no avanzar.
 */
export function avanzar(recorrido: Recorrido, pista: Pista, punto: PuntoRuta): Pista {
  const precision = punto.accuracyMeters ?? null;
  if (precision !== null && precision > PRECISION_MAXIMA_M) return pista;

  const t = punto.recordedAt?.getTime() ?? null;
  const tolerancia = Math.min(
    TOLERANCIA_MAXIMA_M,
    Math.max(TOLERANCIA_LATERAL_M, (precision ?? 0) * 1.5),
  );
  const adelante = ventanaAdelante(recorrido, pista, punto, t);

  const desde = buscarIndice(recorrido.acumulado, pista.progresoM - VENTANA_ATRAS_M);
  const hasta = buscarIndice(recorrido.acumulado, pista.progresoM + adelante);

  let mejorLateral = Infinity;
  let mejorProgreso = pista.progresoM;

  // Gana el segmento **mas cercano**, no el mas adelantado: en una ida y vuelta
  // los dos carriles estan a metros, y en un circuito el arco es a la vez el
  // final de una vuelta y el principio de la siguiente.
  for (let i = desde; i <= hasta && i < recorrido.puntos.length - 1; i++) {
    const { lateral, aLoLargo } = proyectar(punto, recorrido.puntos[i]!, recorrido.puntos[i + 1]!);
    if (lateral >= mejorLateral) continue;
    mejorLateral = lateral;
    mejorProgreso = recorrido.acumulado[i]! + aLoLargo;
  }

  if (mejorLateral > tolerancia) return pista;

  return {
    progresoM: Math.max(pista.progresoM, mejorProgreso),
    t: t === null ? pista.t : Math.max(t, pista.t ?? t),
    ancla: { lat: punto.lat, lng: punto.lng },
  };
}

/** Si con esta pista y este punto el corredor cruzo la meta final. */
export function haLlegado(recorrido: Recorrido, pista: Pista, punto: PuntoRuta): boolean {
  if (pista.progresoM >= recorrido.total - MARGEN_META_M) return true;
  if (pista.progresoM < recorrido.total - ULTIMO_TRAMO_M) return false;

  // Ultimos metros cubiertos y el punto junto al arco, aunque no haya caido
  // sobre la linea: el corredor que se para pasada la meta, fuera del trazado.
  const precision = Math.min(punto.accuracyMeters ?? 0, PRECISION_MAXIMA_M);
  return metros(punto, recorrido.puntos[recorrido.puntos.length - 1]!) <= RADIO_META_M + precision;
}

/** Vueltas completas, para el mapa en vivo. */
export function vueltasDe(recorrido: Recorrido, pista: Pista): number {
  return Math.min(recorrido.laps, Math.floor((pista.progresoM + MARGEN_META_M) / recorrido.vuelta));
}

export interface Avance {
  pista: Pista;
  vueltas: number;
  llego: boolean;
}

/** En vivo: mueve al corredor con un lote y dice si acaba de llegar. */
export function avanceEnCircuito(
  recorrido: Recorrido,
  pista: Pista,
  puntos: readonly PuntoRuta[],
): Avance {
  for (const punto of puntos) {
    pista = avanzar(recorrido, pista, punto);
    if (haLlegado(recorrido, pista, punto)) return { pista, vueltas: recorrido.laps, llego: true };
  }
  return { pista, vueltas: vueltasDe(recorrido, pista), llego: false };
}

export interface Validacion {
  /** Llego a la meta **y** cubrio el recorrido: cuenta como finisher. */
  completo: boolean;
  llego: boolean;
  /** Fraccion (0..1) de tramos de 250 m del recorrido con puntos. */
  cobertura: number;
  vueltas: number;
  progresoM: number;
  /** Hora del punto con el que cruzo la meta: es su hora oficial de llegada. */
  llegadaAt: Date | null;
}

/**
 * Valida un recorrido entero a partir de todos sus puntos, en orden de tiempo.
 *
 * Es la fuente de verdad para la clasificacion: corre sobre lo guardado, asi
 * que no le afectan los lotes que llegaron tarde ni un reinicio del proceso a
 * mitad de carrera. La deteccion en vivo solo sirve para cerrar la sesion.
 */
export function validarRecorrido(
  recorrido: Recorrido,
  puntos: readonly PuntoRuta[],
  inicio?: Date | null,
): Validacion {
  const tramos = Math.max(1, Math.ceil(recorrido.total / TRAMO_M));
  const visitados = new Uint8Array(tramos);
  const marcar = (desde: number, hasta: number) => {
    const a = Math.min(tramos - 1, Math.floor(desde / TRAMO_M));
    const b = Math.min(tramos - 1, Math.floor(hasta / TRAMO_M));
    // Entre dos puntos seguidos se da por cubierto lo de en medio; tras un
    // hueco largo, solo el tramo donde reaparece.
    for (let i = hasta - desde <= 2 * TRAMO_M ? a : b; i <= b; i++) visitados[i] = 1;
  };

  let pista = pistaInicial(inicio);
  let llegadaAt: Date | null = null;
  let llego = false;

  for (const punto of puntos) {
    const previa = pista;
    pista = avanzar(recorrido, pista, punto);
    if (pista !== previa) marcar(previa.progresoM, pista.progresoM);

    if (haLlegado(recorrido, pista, punto)) {
      llego = true;
      llegadaAt = punto.recordedAt ?? null;
      marcar(pista.progresoM, recorrido.total);
      break;
    }
  }

  const cobertura = visitados.reduce((n, v) => n + v, 0) / tramos;

  return {
    completo: llego && cobertura >= COBERTURA_MINIMA,
    llego,
    cobertura: Math.round(cobertura * 1000) / 1000,
    vueltas: llego ? recorrido.laps : vueltasDe(recorrido, pista),
    progresoM: Math.round(pista.progresoM),
    llegadaAt,
  };
}

// ─── Internos ──────────────────────────────────────────────────────────────

/**
 * Cuanto puede haber avanzado el corredor desde su ultimo punto bueno.
 *
 * Por tiempo (nadie corre a mas de 7 m/s) y por linea recta (la ruta no es mas
 * del doble de larga que la recta). El minimo de las dos: tras un tunel de dos
 * minutos hay margen, pero parado en el arco de un circuito no se salta una
 * vuelta por mucho que el GPS rebote.
 */
function ventanaAdelante(r: Recorrido, pista: Pista, punto: Coordenada, t: number | null): number {
  if (t === null || pista.t === null || t <= pista.t) return VENTANA_ADELANTE_M;
  const porTiempo = (VELOCIDAD_MAXIMA_MPS * (t - pista.t)) / 1000;
  const porRecta = FACTOR_RUTA * metros(pista.ancla ?? r.puntos[0]!, punto);
  return Math.max(VENTANA_ADELANTE_M, Math.min(porTiempo, porRecta) + VENTANA_ATRAS_M);
}

/** Primer indice cuyo acumulado alcanza `metrosDeLinea`. Busqueda binaria. */
function buscarIndice(acumulado: readonly number[], metrosDeLinea: number): number {
  let bajo = 0;
  let alto = acumulado.length - 1;
  while (bajo < alto) {
    const medio = (bajo + alto) >> 1;
    if (acumulado[medio]! < metrosDeLinea) bajo = medio + 1;
    else alto = medio;
  }
  return bajo;
}

/**
 * Proyecta el punto sobre el segmento: cuanto se separa y cuantos metros de
 * segmento deja detras. Plano local equirectangular: a escala de una carrera
 * el error es de centimetros.
 */
function proyectar(
  p: Coordenada,
  a: Coordenada,
  b: Coordenada,
): { lateral: number; aLoLargo: number } {
  const cos = Math.cos((a.lat * Math.PI) / 180);
  const x = (c: Coordenada) => (c.lng - a.lng) * cos * METROS_POR_GRADO;
  const y = (c: Coordenada) => (c.lat - a.lat) * METROS_POR_GRADO;

  const bx = x(b);
  const by = y(b);
  const largo2 = bx * bx + by * by;
  if (largo2 === 0) return { lateral: Math.hypot(x(p), y(p)), aLoLargo: 0 };

  const t = Math.min(1, Math.max(0, (x(p) * bx + y(p) * by) / largo2));
  return {
    lateral: Math.hypot(x(p) - t * bx, y(p) - t * by),
    aLoLargo: t * Math.sqrt(largo2),
  };
}

function metros(a: Coordenada, b: Coordenada): number {
  const cos = Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lng - a.lng) * cos * METROS_POR_GRADO;
  const dy = (b.lat - a.lat) * METROS_POR_GRADO;
  return Math.hypot(dx, dy);
}

function coordenadasDe(geojson: unknown): Coordenada[] {
  const crudo = (geojson as { coordinates?: unknown })?.coordinates;
  if (!Array.isArray(crudo)) return [];

  const puntos: Coordenada[] = [];
  for (const par of crudo) {
    if (!Array.isArray(par) || par.length < 2) continue;
    const [lng, lat] = par as [unknown, unknown];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    puntos.push({ lat, lng });
  }
  return puntos;
}
