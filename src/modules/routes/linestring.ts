import type { LineStringGeoJson } from '../races/route';

/**
 * Lo que se puede saber de un `LineString` sin tocar la base.
 *
 * Vive aparte del servicio porque es lo unico de este modulo que tiene reglas
 * de verdad —cuando una geometria es valida y cuanto mide— y es lo unico que
 * hay que poder probar sin levantar Postgres.
 */

/** Radio medio de la Tierra, en metros. */
const RADIO_TIERRA = 6_371_008.8;

/** Tope de vertices que se acepta al dar de alta un recorrido.
 *
 *  Un trazado oficial dibujado a mano no pasa de unos cientos; 10.000 ya es un
 *  track de GPS crudo subido por error, y aceptarlo dejaria un JSON de megas
 *  clavado en la fila de la maraton para siempre. */
export const MAX_VERTICES = 10_000;

export interface RecorridoResuelto {
  geoJson: LineStringGeoJson;
  distanceMeters: number;
  startLat: number;
  startLng: number;
}

/** Distancia entre dos coordenadas por haversine, en metros. */
export function metrosEntre(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;

  return 2 * RADIO_TIERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Largo total del trazado, en metros enteros. */
export function largoDeLineString(geo: LineStringGeoJson): number {
  let total = 0;

  for (let i = 1; i < geo.coordinates.length; i++) {
    const [lngA, latA] = geo.coordinates[i - 1]!;
    const [lngB, latB] = geo.coordinates[i]!;
    total += metrosEntre(latA, lngA, latB, lngB);
  }

  return Math.round(total);
}

/**
 * Valida un GeoJSON que llega de fuera y saca de el lo que la fila necesita.
 *
 * Devuelve `null` en vez de lanzar: quien la llama sabe con que codigo de error
 * responder, y esta funcion no tiene por que conocer `AppException`.
 *
 * **La distancia se calcula, no se cree.** Un organizador que escribe "42195"
 * junto a un trazado de 38 km deja una carrera cuyo mapa no llega a la meta; el
 * numero que sale de la geometria no puede contradecirla.
 */
export function resolverRecorrido(entrada: unknown): RecorridoResuelto | null {
  if (typeof entrada !== 'object' || entrada === null) return null;

  const geo = entrada as { type?: unknown; coordinates?: unknown };
  if (geo.type !== 'LineString' || !Array.isArray(geo.coordinates)) return null;
  if (geo.coordinates.length < 2 || geo.coordinates.length > MAX_VERTICES) return null;

  const coordinates: [number, number][] = [];

  for (const par of geo.coordinates) {
    if (!Array.isArray(par) || par.length < 2) return null;

    const [lng, lat] = par as [unknown, unknown];
    if (typeof lng !== 'number' || typeof lat !== 'number') return null;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    coordinates.push([lng, lat]);
  }

  const linea: LineStringGeoJson = { type: 'LineString', coordinates };
  const distanceMeters = largoDeLineString(linea);

  // Un trazado de menos de 100 m es un error de carga (dos puntos pegados, o
  // coordenadas invertidas), no un recorrido.
  if (distanceMeters < 100) return null;

  const [startLng, startLat] = coordinates[0]!;

  return { geoJson: linea, distanceMeters, startLat, startLng };
}
