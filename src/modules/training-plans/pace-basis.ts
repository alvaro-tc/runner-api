/**
 * Ritmo de referencia del usuario: el numero del que salen todos los rangos
 * del plan.
 *
 * La plantilla no guarda ritmos, guarda **factores** (`paceFactor: 1.15` = 15%
 * mas lento que el ritmo de referencia). Asi la misma plantilla de 10K sirve al
 * que corre a 4:30 y al que corre a 7:00, y todo el ajuste al corredor pasa por
 * este unico valor.
 */

import { PlanLevel } from '../../../generated/prisma/enums';

/**
 * Exponente de la formula de Riegel (1977): `T2 = T1 x (D2/D1)^1.06`.
 *
 * Predice el tiempo a una distancia a partir del rendimiento en otra. Es una
 * aproximacion —sobreestima en el salto de 10K a maraton para quien no tiene
 * volumen— pero necesita un solo dato y no un test de laboratorio, que es lo
 * unico que se puede pedir a una app.
 */
const EXPONENTE_RIEGEL = 1.06;

/**
 * Cuantos entrenamientos hacen falta para creerle a los datos.
 *
 * Con uno o dos, un mal dia o un GPS con rebotes entre edificios fijan el plan
 * entero. Por debajo de esto se usa el nivel autodeclarado, que sera impreciso
 * pero no es aleatorio.
 */
export const MINIMO_ENTRENAMIENTOS = 3;

/** Ritmo llano por nivel, en segundos por km, cuando no hay historial. */
const RITMO_POR_NIVEL: Record<PlanLevel, number> = {
  [PlanLevel.beginner]: 420, // 7:00
  [PlanLevel.intermediate]: 330, // 5:30
  [PlanLevel.advanced]: 270, // 4:30
};

/** Distancia minima de un esfuerzo para que Riegel diga algo. */
const DISTANCIA_MINIMA_METROS = 2000;

/** Topes de cordura: por fuera de esto el dato es basura, no un corredor. */
const RITMO_MINIMO = 150; // 2:30/km, ritmo de elite mundial
const RITMO_MAXIMO = 900; // 15:00/km, caminata

export interface Esfuerzo {
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Proyecta a `distanciaObjetivo` el tiempo de un esfuerzo, via Riegel.
 * Devuelve segundos por kilometro.
 */
export function riegel(esfuerzo: Esfuerzo, distanciaObjetivoMetros: number): number {
  const factor = (distanciaObjetivoMetros / esfuerzo.distanceMeters) ** EXPONENTE_RIEGEL;
  const tiempoProyectado = esfuerzo.durationSeconds * factor;
  return tiempoProyectado / (distanciaObjetivoMetros / 1000);
}

export interface RitmoBase {
  paceBasisSecPerKm: number;
  /** De donde salio. Se devuelve al cliente para poder explicarlo en pantalla. */
  source: 'recent_efforts' | 'declared_level';
}

/**
 * El ritmo de referencia para un plan con esa distancia objetivo.
 *
 * De los entrenamientos recientes se toma el **mejor esfuerzo** —el que mejor
 * ritmo proyecta a la distancia objetivo, no el mas largo ni el mas rapido en
 * absoluto— porque es el que mas se parece a lo que el corredor puede sostener
 * cuando le sale bien.
 *
 * Se descartan los tramos cortos: proyectar un maraton desde 800 m da un numero
 * con la forma correcta y ninguna relacion con la realidad.
 */
export function ritmoBase(
  esfuerzos: readonly Esfuerzo[],
  distanciaObjetivoMetros: number,
  nivel: PlanLevel,
): RitmoBase {
  const utiles = esfuerzos.filter(
    (e) => e.distanceMeters >= DISTANCIA_MINIMA_METROS && e.durationSeconds > 0,
  );

  if (utiles.length < MINIMO_ENTRENAMIENTOS) {
    return { paceBasisSecPerKm: RITMO_POR_NIVEL[nivel], source: 'declared_level' };
  }

  const mejor = Math.min(...utiles.map((e) => riegel(e, distanciaObjetivoMetros)));
  const acotado = Math.min(Math.max(Math.round(mejor), RITMO_MINIMO), RITMO_MAXIMO);

  return { paceBasisSecPerKm: acotado, source: 'recent_efforts' };
}
