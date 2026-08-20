/**
 * Prediccion del tiempo de llegada.
 *
 * Funcion pura sobre un puñado de entrenamientos: entran esfuerzos y sale un
 * tiempo. Sin Prisma y sin reloj, para poder discutir la formula con un test en
 * vez de con una carrera.
 */

import { riegel, MINIMO_ENTRENAMIENTOS, type Esfuerzo } from '../training-plans/pace-basis';

export { MINIMO_ENTRENAMIENTOS };

/**
 * Ventana de historial que se mira, en semanas.
 *
 * El PROMT pide 8-12 y se toman 12: lo que corriste hace tres meses todavia
 * dice algo de tu forma, y con una ventana mas corta un usuario que se lesiona
 * dos semanas se queda sin prediccion justo cuando mas quiere verla.
 */
export const SEMANAS_DE_HISTORIAL = 12;

/** Por debajo de esta distancia, un esfuerzo no proyecta nada util. */
const DISTANCIA_MINIMA_METROS = 2000;

/**
 * Volumen semanal que Riegel da por supuesto, como multiplo de la distancia
 * objetivo.
 *
 * Riegel asume que el corredor esta *entrenado para esa distancia*. Quien corre
 * 15 km por semana y se apunta a una maraton no va a hacer el tiempo que dice la
 * formula, y decirselo sin mas es mandarlo a reventar en el km 30. La regla
 * clasica de los planes de fondo —volumen semanal de unas 2,5 veces la carrera—
 * es la referencia contra la que se mide.
 */
const VOLUMEN_ESPERADO = 2.5;

/**
 * Cuanto se penaliza, como maximo, la falta de volumen.
 *
 * Un 12% sobre un maraton de 4 h son casi 30 minutos: suficiente para que la
 * cifra deje de ser optimista, sin convertir la pantalla en un castigo. No se
 * pretende precision aqui —no la hay— sino no mentir hacia el lado peligroso.
 */
const PENALIZACION_MAXIMA = 0.12;

/**
 * A partir de cuantas veces la distancia del mejor esfuerzo la extrapolacion
 * deja de ser fiable.
 */
const EXTRAPOLACION_DUDOSA = 2;
const EXTRAPOLACION_MALA = 3;

/** Topes de cordura, en segundos por km: fuera de esto el dato es basura. */
const RITMO_MINIMO = 150; // 2:30/km, elite mundial
const RITMO_MAXIMO = 900; // 15:00/km, caminata

/** Cuanto creerle al numero. La app lo usa para elegir el texto de al lado. */
export type Confianza = 'high' | 'medium' | 'low';

export interface BaseDeLaPrediccion {
  /** Cuantos entrenamientos utiles entraron en el calculo. */
  workouts: number;
  bestEffortDistanceMeters: number;
  bestEffortDurationSeconds: number;
  avgWeeklyDistanceMeters: number;
  weeksAnalyzed: number;
}

export interface Prediccion {
  finishTimeSeconds: number | null;
  paceSecPerKm: number | null;
  confidence: Confianza | null;
  basedOn: BaseDeLaPrediccion | null;
  /** `insufficient_data` cuando no hay con que predecir. `null` si hay numero. */
  reason: 'insufficient_data' | null;
}

const SIN_DATOS: Prediccion = {
  finishTimeSeconds: null,
  paceSecPerKm: null,
  confidence: null,
  basedOn: null,
  reason: 'insufficient_data',
};

/**
 * Tiempo estimado para `distanciaObjetivoMetros`.
 *
 * Se proyecta cada esfuerzo con Riegel y se toma **el mejor**: es el que mas se
 * parece a lo que el corredor puede sostener cuando le sale bien. Promediarlos
 * mezclaria los rodajes suaves —que son la mayoria— y devolveria el ritmo de
 * entrenar, no el de competir.
 *
 * Sobre esa proyeccion se aplica la penalizacion por volumen: la formula supone
 * un corredor entrenado para la distancia, y el que no lo esta no hace ese
 * tiempo. La correccion solo puede empeorar el pronostico, nunca mejorarlo —
 * tener mucho volumen no te hace mas rapido de lo que ya demostraste ser.
 */
export function predecir(
  esfuerzos: readonly Esfuerzo[],
  distanciaObjetivoMetros: number,
  semanas: number = SEMANAS_DE_HISTORIAL,
): Prediccion {
  if (distanciaObjetivoMetros <= 0) return SIN_DATOS;

  const utiles = esfuerzos.filter(
    (e) => e.distanceMeters >= DISTANCIA_MINIMA_METROS && e.durationSeconds > 0,
  );

  if (utiles.length < MINIMO_ENTRENAMIENTOS) return SIN_DATOS;

  const mejor = utiles.reduce((mejor, e) =>
    riegel(e, distanciaObjetivoMetros) < riegel(mejor, distanciaObjetivoMetros) ? e : mejor,
  );

  const volumenSemanal =
    utiles.reduce((suma, e) => suma + e.distanceMeters, 0) / Math.max(1, semanas);

  const ritmoProyectado = riegel(mejor, distanciaObjetivoMetros);
  const castigo = penalizacion(volumenSemanal, distanciaObjetivoMetros);

  const paceSecPerKm = Math.min(
    Math.max(Math.round(ritmoProyectado * castigo), RITMO_MINIMO),
    RITMO_MAXIMO,
  );

  return {
    finishTimeSeconds: Math.round((paceSecPerKm * distanciaObjetivoMetros) / 1000),
    paceSecPerKm,
    confidence: confianza(utiles.length, mejor.distanceMeters, distanciaObjetivoMetros),
    basedOn: {
      workouts: utiles.length,
      bestEffortDistanceMeters: Math.round(mejor.distanceMeters),
      bestEffortDurationSeconds: Math.round(mejor.durationSeconds),
      avgWeeklyDistanceMeters: Math.round(volumenSemanal),
      weeksAnalyzed: semanas,
    },
    reason: null,
  };
}

/** Multiplicador &ge; 1 que castiga la falta de kilometros semanales. */
function penalizacion(volumenSemanalMetros: number, distanciaObjetivoMetros: number): number {
  const esperado = distanciaObjetivoMetros * VOLUMEN_ESPERADO;
  const cobertura = Math.min(1, volumenSemanalMetros / esperado);

  return 1 + PENALIZACION_MAXIMA * (1 - cobertura);
}

/**
 * Cuanto fiarse del numero.
 *
 * Manda la extrapolacion: proyectar un maraton desde un 10K es estirar la
 * formula cuatro veces mas alla de lo que se ha demostrado, y eso pesa mucho mas
 * que tener tres entrenamientos o treinta.
 */
function confianza(cuantos: number, mejorDistancia: number, objetivo: number): Confianza {
  const estiramiento = objetivo / mejorDistancia;

  if (estiramiento > EXTRAPOLACION_MALA) return 'low';
  if (estiramiento > EXTRAPOLACION_DUDOSA || cuantos < 2 * MINIMO_ENTRENAMIENTOS) return 'medium';

  return 'high';
}
