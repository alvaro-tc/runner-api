import { rangoSemanal } from '../../common/time/week';
import { armarSemanas, type DiaAgregado } from './weekly-stats';

const TZ = 'America/La_Paz';

/** Las dos ultimas semanas contando la del 19/08/2026 (miercoles). */
function semanas(): ReturnType<typeof rangoSemanal>[] {
  const hoy = new Date('2026-08-19T14:00:00.000Z');
  const anterior = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);
  return [rangoSemanal(anterior, TZ), rangoSemanal(hoy, TZ)];
}

function dia(offsetDias: number, distanceMeters: number): DiaAgregado {
  const base = semanas()[1]!.start.getTime();
  return {
    at: new Date(base + offsetDias * 24 * 60 * 60 * 1000),
    distanceMeters,
    movingSeconds: distanceMeters / 4, // ~4 min/km
    durationSeconds: distanceMeters / 4 + 60,
    workouts: 1,
  };
}

describe('armarSemanas', () => {
  it('devuelve una semana por rango, con siete dias, aunque no haya corrido nada', () => {
    const salida = armarSemanas(semanas(), []);

    expect(salida).toHaveLength(2);
    expect(salida[0]!.days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(salida[0]!.distanceMeters).toBe(0);
    expect(salida[0]!.avgPaceSecPerKm).toBeNull();
  });

  it('mete cada dia en su casilla y suma el total de la semana', () => {
    // Lunes y miercoles de la semana en curso.
    const salida = armarSemanas(semanas(), [dia(0, 5000), dia(2, 10_000)]);
    const actual = salida[1]!;

    expect(actual.days[0]!.distanceMeters).toBe(5000);
    expect(actual.days[2]!.distanceMeters).toBe(10_000);
    expect(actual.days[1]!.distanceMeters).toBe(0);
    expect(actual.distanceMeters).toBe(15_000);
    expect(actual.workouts).toBe(2);
    // 15 km en 3750 s = 250 s/km.
    expect(actual.avgPaceSecPerKm).toBe(250);
  });

  it('ignora los dias que caen fuera de las semanas pedidas', () => {
    const salida = armarSemanas(semanas(), [dia(-30, 9000), dia(30, 9000)]);

    expect(salida.every((s) => s.distanceMeters === 0)).toBe(true);
  });

  it('el domingo cae en la septima casilla y no se derrama a la semana siguiente', () => {
    const salida = armarSemanas(semanas(), [dia(6, 21_000)]);

    expect(salida[1]!.days[6]!.distanceMeters).toBe(21_000);
    expect(salida[1]!.distanceMeters).toBe(21_000);
  });
});
