/**
 * Plegado de totales diarios en semanas Lunes-Domingo.
 *
 * Postgres agrupa por dia local (ver `WorkoutsService.agregarPorDia`) y aqui se
 * reparten esos dias en las semanas que pinta la app. Es funcion pura: entra un
 * array de dias y las fronteras de cada semana, salen las barras.
 *
 * El reparto se hace por indice y no por otro `date_trunc('week', ...)` porque
 * una semana sin ningun entrenamiento tiene que aparecer igual, con ceros: si
 * el usuario no corrio en toda la semana, la barra vacia **es** la informacion.
 */
import type { RangoSemana } from '../../common/time/week';
import { ritmo } from './metrics';

const MS_POR_DIA = 24 * 60 * 60 * 1000;
const DIAS_POR_SEMANA = 7;

/** Un dia ya agregado por la base. `at` es el instante UTC de su medianoche local. */
export interface DiaAgregado {
  at: Date;
  distanceMeters: number;
  movingSeconds: number;
  durationSeconds: number;
  workouts: number;
}

export interface DiaStats {
  /** 1 = lunes, 7 = domingo. Misma convencion que `weekday` en los planes. */
  weekday: number;
  startsAt: string;
  distanceMeters: number;
  movingSeconds: number;
  workouts: number;
}

export interface SemanaStats {
  weekStartsAt: string;
  weekEndsAt: string;
  distanceMeters: number;
  movingSeconds: number;
  durationSeconds: number;
  workouts: number;
  avgPaceSecPerKm: number | null;
  days: DiaStats[];
}

function semanaVacia(rango: RangoSemana): SemanaStats {
  return {
    weekStartsAt: rango.start.toISOString(),
    weekEndsAt: rango.end.toISOString(),
    distanceMeters: 0,
    movingSeconds: 0,
    durationSeconds: 0,
    workouts: 0,
    avgPaceSecPerKm: null,
    days: Array.from({ length: DIAS_POR_SEMANA }, (_, i) => ({
      weekday: i + 1,
      startsAt: new Date(rango.start.getTime() + i * MS_POR_DIA).toISOString(),
      distanceMeters: 0,
      movingSeconds: 0,
      workouts: 0,
    })),
  };
}

/**
 * Reparte `dias` en `semanas` y devuelve las barras listas para pintar.
 *
 * El indice del dia sale redondeando la diferencia en dias y no con una
 * division entera: con cambio de horario un dia dura 23 o 25 horas y el truncar
 * mandaria ese dia a la casilla del vecino. Bolivia no cambia la hora, pero el
 * codigo no deberia depender de eso.
 */
export function armarSemanas(
  semanas: readonly RangoSemana[],
  dias: readonly DiaAgregado[],
): SemanaStats[] {
  const salida = semanas.map(semanaVacia);

  for (const dia of dias) {
    const indiceSemana = semanas.findIndex((s) => dia.at >= s.start && dia.at < s.end);
    const semana = salida[indiceSemana];
    if (!semana) continue; // Dia fuera del rango pedido: no es de nadie.

    const indiceDia = Math.min(
      DIAS_POR_SEMANA - 1,
      Math.max(
        0,
        Math.round((dia.at.getTime() - semanas[indiceSemana]!.start.getTime()) / MS_POR_DIA),
      ),
    );
    const casilla = semana.days[indiceDia]!;

    casilla.distanceMeters += dia.distanceMeters;
    casilla.movingSeconds += dia.movingSeconds;
    casilla.workouts += dia.workouts;

    semana.distanceMeters += dia.distanceMeters;
    semana.movingSeconds += dia.movingSeconds;
    semana.durationSeconds += dia.durationSeconds;
    semana.workouts += dia.workouts;
  }

  for (const semana of salida) {
    semana.avgPaceSecPerKm = ritmo(semana.distanceMeters, semana.movingSeconds);
  }

  return salida;
}
