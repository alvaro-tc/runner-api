import { generarTrack } from './track';
import { consolidar } from '../../src/modules/workouts/metrics';

/**
 * El generador de recorridos es la pieza del seed de la que cuelga todo lo
 * demas: si un "10K" mide 10.700 m, el historial, las estadisticas semanales,
 * la prediccion de llegada y los kilometros de la zapatilla salen todos
 * torcidos a la vez, y nada lo delata salvo mirar los numeros.
 *
 * Se prueba contra `consolidar()` —la misma funcion que usa la API— porque lo
 * que importa no es lo que el generador cree haber dibujado, sino lo que el
 * backend mide sobre esos puntos.
 */
describe('generarTrack', () => {
  const base = {
    inicio: new Date('2026-05-10T10:30:00Z'),
    ritmoSecPerKm: 330,
    centro: { lat: -16.5417, lng: -68.0806 },
    altitudBase: 3300,
    semilla: 42,
  };

  it.each([5000, 10_000, 21_097, 42_195])('un recorrido de %i m mide eso al consolidarlo', (d) => {
    const metricas = consolidar(generarTrack({ ...base, distanceMeters: d }));

    // ±3%: el ruido del GPS y los puntos descartados mueven el total, pero un
    // circuito deformado sin corregir el perimetro se iba un 7% largo — que es
    // exactamente el error que este test existe para no repetir.
    expect(metricas.distanceMeters).toBeGreaterThan(d * 0.97);
    expect(metricas.distanceMeters).toBeLessThan(d * 1.03);
  });

  it('el ritmo medido se parece al ritmo pedido', () => {
    const metricas = consolidar(generarTrack({ ...base, distanceMeters: 10_000 }));

    expect(metricas.avgPaceSecPerKm).toBeGreaterThan(base.ritmoSecPerKm * 0.95);
    expect(metricas.avgPaceSecPerKm).toBeLessThan(base.ritmoSecPerKm * 1.05);
  });

  it('mete puntos con mala precision, para que el filtro tenga algo que filtrar', () => {
    const metricas = consolidar(generarTrack({ ...base, distanceMeters: 21_097 }));

    // Un seed que solo produce puntos perfectos nunca ejerce el camino del
    // descarte, que es justo el que rompe las metricas cuando falla.
    expect(metricas.discardedPoints).toBeGreaterThan(0);
  });

  it('es determinista: la misma semilla da el mismo recorrido', () => {
    const a = generarTrack({ ...base, distanceMeters: 8000 });
    const b = generarTrack({ ...base, distanceMeters: 8000 });
    const otro = generarTrack({ ...base, distanceMeters: 8000, semilla: 43 });

    expect(a).toEqual(b);
    expect(a).not.toEqual(otro);
  });

  it('produce splits por kilometro completo', () => {
    const metricas = consolidar(generarTrack({ ...base, distanceMeters: 10_000 }));

    expect(metricas.splits.length).toBeGreaterThanOrEqual(9);
    expect(metricas.bestKmIndex).not.toBeNull();
  });
});
