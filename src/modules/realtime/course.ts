/**
 * Seguimiento de un corredor **sobre el trazado oficial**.
 *
 * Sirve para una sola cosa: decidir cuando alguien acabo la maraton, y hacerlo
 * bien en el caso que rompe cualquier atajo, que es la **ida y vuelta**. Ahi la
 * distancia recorrida no vale —el corredor puede darse la vuelta a mitad y
 * llegar al arco con los 21 km puestos sin haber tocado el punto de giro—, y la
 * cercania a la meta tampoco —la meta esta a diez metros de la salida, asi que
 * todo el mundo "llega" en el primer minuto—.
 *
 * Lo que si vale es el **avance a lo largo de la linea**: cuantos metros de
 * trazado lleva cubiertos, medidos proyectando cada punto GPS sobre el
 * recorrido y avanzando siempre hacia delante. En una ida y vuelta la ida y la
 * vuelta son tramos distintos de la misma polilinea, y por eso el corredor que
 * se da la vuelta antes se queda clavado en su kilometro: no hay linea por
 * delante que pueda ir cubriendo.
 *
 * Funciones puras sobre datos planos: nada de Prisma, sockets ni reloj. El
 * GPS de verdad se prueba con arrays de coordenadas, no saliendo a correr.
 */

import type { Coordenada } from '../races/route';

/** Metros por grado de latitud. Constante suficiente fuera de los polos. */
const METROS_POR_GRADO = 111_320;

/**
 * Cuanto trazado por delante se mira para enganchar el punto.
 *
 * Es el tope de lo que un corredor puede "avanzar" de un punto al siguiente.
 * Con lotes cada 20-30 s a ritmo popular son 100-150 m; 400 deja aire para el
 * ciclista de apoyo y para un lote que llego tarde, y a la vez impide que un
 * rebote del GPS al otro lado de la calle —en la ida y vuelta, el carril de
 * enfrente es *otro tramo* de la misma linea— teletransporte a nadie kilometros
 * hacia delante.
 */
const VENTANA_ADELANTE_M = 400;

/**
 * Y cuanto por detras. El GPS oscila unas decenas de metros; sin margen hacia
 * atras, un punto ruidoso engancharia siempre en el limite delantero de la
 * ventana y el avance se inflaria solo.
 */
const VENTANA_ATRAS_M = 150;

/**
 * Cuanto se puede separar el corredor de la linea y seguir contando.
 *
 * Cubre el ancho de una avenida, el error tipico de un movil entre edificios y
 * el hecho de que el trazado oficial se dibujo por el centro de la calzada. Un
 * punto mas lejos que esto no se descarta: simplemente **no hace avanzar** el
 * progreso, que es lo correcto para quien se salio de la ruta.
 */
const TOLERANCIA_LATERAL_M = 60;

/**
 * Lo que puede faltar del trazado y aun asi darlo por acabado.
 *
 * La linea oficial nunca coincide al metro con el arco de meta y el ultimo
 * punto del GPS cae donde cae. Exigir el 100,0 % dejaria a medio pelotón sin
 * llegada registrada por una imprecision de dibujo.
 */
const MARGEN_META_M = 75;

/** Y cuanto puede estar el corredor del final de la linea al cruzarla. */
const RADIO_META_M = 60;

/** Un trazado listo para medir sobre el. */
export interface Recorrido {
  puntos: Coordenada[];
  /** Metros de linea acumulados hasta cada punto. `acumulado[0] === 0`. */
  acumulado: number[];
  total: number;
}

/**
 * Deja el `routeGeoJson` de la maraton en algo medible, o `null` si no hay
 * trazado utilizable. Se hace **una vez por maraton**, no una vez por lote:
 * son miles de vertices y la ingesta es el camino caliente.
 */
export function prepararRecorrido(geojson: unknown): Recorrido | null {
  const coords = coordenadasDe(geojson);
  if (coords.length < 2) return null;

  const acumulado: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    acumulado.push(acumulado[i - 1]! + metros(coords[i - 1]!, coords[i]!));
  }

  return { puntos: coords, acumulado, total: acumulado[acumulado.length - 1]! };
}

/**
 * Cuanto trazado lleva cubierto el corredor tras ver este punto.
 *
 * Devuelve el progreso nuevo, que **nunca retrocede**: un punto que engancha
 * detras es ruido del sensor, no un corredor desandando la carrera. Si ningun
 * segmento de la ventana queda dentro de la tolerancia lateral, devuelve el
 * progreso tal cual estaba — el corredor se salio, o el GPS se fue, y en los
 * dos casos lo honesto es no avanzar.
 */
export function avanzar(recorrido: Recorrido, progresoM: number, punto: Coordenada): number {
  const desde = buscarIndice(recorrido.acumulado, progresoM - VENTANA_ATRAS_M);
  const hasta = buscarIndice(recorrido.acumulado, progresoM + VENTANA_ADELANTE_M);

  let mejorLateral = Infinity;
  let mejorProgreso = progresoM;

  // Gana el segmento **mas cercano**, no el mas adelantado: en una ida y vuelta
  // los dos carriles estan a metros uno del otro y quedarse con el que mas
  // avanza pondria a todo el mundo en el tramo de regreso desde el kilometro 1.
  for (let i = desde; i <= hasta && i < recorrido.puntos.length - 1; i++) {
    const { lateral, aLoLargo } = proyectar(punto, recorrido.puntos[i]!, recorrido.puntos[i + 1]!);
    if (lateral >= mejorLateral) continue;

    mejorLateral = lateral;
    mejorProgreso = recorrido.acumulado[i]! + aLoLargo;
  }

  if (mejorLateral > TOLERANCIA_LATERAL_M) return progresoM;

  return Math.max(progresoM, mejorProgreso);
}

/** Si con este progreso y este punto el corredor ya cruzo la meta. */
export function haLlegado(recorrido: Recorrido, progresoM: number, punto: Coordenada): boolean {
  if (progresoM < recorrido.total - MARGEN_META_M) return false;
  return metros(punto, recorrido.puntos[recorrido.puntos.length - 1]!) <= RADIO_META_M;
}

// ─── Internos ──────────────────────────────────────────────────────────────

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
 * Proyecta el punto sobre el segmento: cuanto se separa de el y cuantos metros
 * de segmento deja detras. Plano local equirectangular — a escala de una
 * carrera el error es de centimetros y esto corre dentro del bucle caliente.
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
  // Dos vertices repetidos: el segmento no tiene direccion, solo distancia.
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
