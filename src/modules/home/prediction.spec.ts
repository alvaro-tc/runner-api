import { predecir, SEMANAS_DE_HISTORIAL } from './prediction';
import { riegel, type Esfuerzo } from '../training-plans/pace-basis';

/** `n` esfuerzos iguales, para llegar al mínimo sin ruido. */
function repetir(esfuerzo: Esfuerzo, n: number): Esfuerzo[] {
  return Array.from({ length: n }, () => esfuerzo);
}

/** 10 km en 50 min: 5:00/km, un corredor popular reconocible. */
const DIEZ_K: Esfuerzo = { distanceMeters: 10_000, durationSeconds: 3000 };

describe('predecir', () => {
  it('no predice con menos de tres entrenamientos', () => {
    const salida = predecir(repetir(DIEZ_K, 2), 21_097);

    expect(salida.finishTimeSeconds).toBeNull();
    expect(salida.reason).toBe('insufficient_data');
  });

  it('ignora los tramos cortos al contar', () => {
    // Tres entrenamientos, pero de 1 km: no proyectan nada.
    const salida = predecir(repetir({ distanceMeters: 1000, durationSeconds: 300 }, 3), 10_000);

    expect(salida.reason).toBe('insufficient_data');
  });

  it('aplica Riegel sobre el mejor esfuerzo, no sobre la media', () => {
    const flojos = repetir({ distanceMeters: 10_000, durationSeconds: 4200 }, 5); // 7:00/km
    const salida = predecir([...flojos, DIEZ_K], 10_000);

    // El bueno manda: 5:00/km más la penalización por volumen, no 7:00.
    expect(salida.basedOn!.bestEffortDurationSeconds).toBe(3000);
    expect(salida.paceSecPerKm).toBeLessThan(340);
  });

  it('el tiempo sale del ritmo por la distancia', () => {
    const salida = predecir(repetir(DIEZ_K, 6), 10_000);

    expect(salida.finishTimeSeconds).toBe(salida.paceSecPerKm! * 10);
  });

  it('penaliza la falta de volumen y nunca regala tiempo', () => {
    // Mismo mejor esfuerzo; uno corre eso y nada más, el otro acumula volumen.
    const escaso = predecir(repetir(DIEZ_K, 3), 42_195);
    // 130 salidas de 10 km en 12 semanas son ~108 km/semana: cubre de sobra las
    // 2,5 veces la distancia que la fórmula da por supuestas.
    const sobrado = predecir(repetir(DIEZ_K, 130), 42_195);

    expect(escaso.paceSecPerKm!).toBeGreaterThan(sobrado.paceSecPerKm!);
    expect(sobrado.basedOn!.avgWeeklyDistanceMeters).toBeGreaterThan(42_195 * 2.5);
    // Con volumen de sobra la corrección desaparece: queda Riegel puro.
    expect(sobrado.paceSecPerKm).toBe(Math.round(riegel(DIEZ_K, 42_195)));
  });

  it('proyectar mucho más lejos que lo corrido baja la confianza', () => {
    expect(predecir(repetir(DIEZ_K, 8), 10_000).confidence).toBe('high');
    expect(predecir(repetir(DIEZ_K, 8), 21_097).confidence).toBe('medium');
    expect(predecir(repetir(DIEZ_K, 8), 42_195).confidence).toBe('low');
  });

  it('un objetivo sin distancia no se predice', () => {
    expect(predecir(repetir(DIEZ_K, 6), 0).reason).toBe('insufficient_data');
  });

  it('el volumen semanal se reparte entre las semanas analizadas', () => {
    const salida = predecir(repetir(DIEZ_K, 12), 10_000);

    expect(salida.basedOn!.weeksAnalyzed).toBe(SEMANAS_DE_HISTORIAL);
    expect(salida.basedOn!.avgWeeklyDistanceMeters).toBe(10_000);
  });
});
