import {
  ACCURACY_MAXIMA_METROS,
  calorias,
  consolidar,
  haversine,
  marcadores,
  ritmo,
  type Punto,
} from './metrics';

/**
 * Un grado de latitud segun el mismo radio que usa `haversine`.
 *
 * Se usa el valor exacto del modelo esferico y no los 111,32 km del elipsoide
 * para que "25 m entre puntos" sean 25 m de verdad y los splits caigan donde
 * dice el test, en vez de a un metro de la marca.
 */
const METROS_POR_GRADO_LAT = 111_194.93;

const BASE = new Date('2026-08-19T10:00:00.000Z');

/**
 * Recorrido recto hacia el norte desde (0,0), a velocidad constante.
 *
 * Se elige el ecuador y un rumbo norte porque ahi la conversion grados→metros
 * es la mas simple y las cuentas del test se pueden hacer a mano.
 */
function recta(opciones: {
  puntos: number;
  metrosPorPunto: number;
  segundosPorPunto: number;
  accuracy?: number | null;
  altitudPorPunto?: number;
}): Punto[] {
  const { puntos, metrosPorPunto, segundosPorPunto } = opciones;

  return Array.from({ length: puntos }, (_, i) => ({
    recordedAt: new Date(BASE.getTime() + i * segundosPorPunto * 1000),
    lat: (i * metrosPorPunto) / METROS_POR_GRADO_LAT,
    lng: 0,
    altitude: opciones.altitudPorPunto === undefined ? null : i * opciones.altitudPorPunto,
    accuracyMeters: opciones.accuracy === undefined ? 5 : opciones.accuracy,
  }));
}

describe('metrics', () => {
  describe('haversine', () => {
    const punto = (lat: number, lng: number): Punto => ({
      recordedAt: BASE,
      lat,
      lng,
      altitude: null,
      accuracyMeters: null,
    });

    it('mide cero entre un punto y si mismo', () => {
      expect(haversine(punto(-16.5, -68.15), punto(-16.5, -68.15))).toBe(0);
    });

    it('un grado de latitud son unos 111 km', () => {
      expect(haversine(punto(0, 0), punto(1, 0))).toBeCloseTo(111_195, -2);
    });

    it('mide la distancia La Paz - Santa Cruz en linea recta, ~547 km', () => {
      const km = haversine(punto(-16.5, -68.15), punto(-17.78, -63.18)) / 1000;
      expect(km).toBeGreaterThan(540);
      expect(km).toBeLessThan(555);
    });
  });

  describe('ritmo', () => {
    it('5 km en 25 min son 300 s/km', () => {
      expect(ritmo(5000, 1500)).toBe(300);
    });

    it('es null sin distancia', () => {
      expect(ritmo(0, 600)).toBeNull();
    });
  });

  describe('consolidar', () => {
    it('sin puntos devuelve todo a cero, no NaN', () => {
      const m = consolidar([]);
      expect(m.distanceMeters).toBe(0);
      expect(m.avgPaceSecPerKm).toBeNull();
      expect(m.avgSpeedMps).toBeNull();
      expect(m.bestKmIndex).toBeNull();
      expect(m.splits).toEqual([]);
    });

    it('un solo punto no es un recorrido', () => {
      expect(
        consolidar(recta({ puntos: 1, metrosPorPunto: 0, segundosPorPunto: 1 })).distanceMeters,
      ).toBe(0);
    });

    it('mide un recorrido recto de 3 km a 5:00/km', () => {
      // 3000 puntos serian lentos: 5 m/s con un punto cada 5 s = 25 m/punto.
      const m = consolidar(recta({ puntos: 121, metrosPorPunto: 25, segundosPorPunto: 5 }));

      expect(m.distanceMeters).toBeCloseTo(3000, -1);
      expect(m.durationSeconds).toBe(600);
      expect(m.movingSeconds).toBe(600);
      expect(m.avgPaceSecPerKm).toBeCloseTo(200, -1);
      expect(m.avgSpeedMps).toBeCloseTo(5, 1);
    });

    it('emite un split por km completo y descarta el resto parcial', () => {
      // 2,5 km: dos splits, no tres.
      const m = consolidar(recta({ puntos: 101, metrosPorPunto: 25, segundosPorPunto: 5 }));

      expect(m.splits).toHaveLength(2);
      expect(m.splits.every((s) => s.distanceMeters === 1000)).toBe(true);
      expect(m.distanceMeters).toBeCloseTo(2500, -1);
    });

    it('el mejor km es el mas rapido, no el primero', () => {
      // Primer km lento (10 s/punto), segundo rapido (5 s/punto).
      const lento = recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 10 });
      const rapido = recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 5 }).map((p, i) => ({
        ...p,
        recordedAt: new Date(lento.at(-1)!.recordedAt.getTime() + i * 5000),
        lat: lento.at(-1)!.lat + p.lat,
      }));

      const m = consolidar([...lento, ...rapido.slice(1)]);
      expect(m.splits.length).toBeGreaterThanOrEqual(2);
      expect(m.bestKmIndex).toBe(1);
      expect(m.splits[1]!.paceSecPerKm).toBeLessThan(m.splits[0]!.paceSecPerKm);
    });

    it('descarta los puntos con precision peor que el umbral', () => {
      const buenos = recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 5 });
      const malo: Punto = {
        ...buenos[20]!,
        lat: buenos[20]!.lat + 0.01, // ~1,1 km de rebote
        accuracyMeters: ACCURACY_MAXIMA_METROS + 20,
      };

      const conRuido = consolidar([...buenos, malo]);
      const limpio = consolidar(buenos);

      expect(conRuido.distanceMeters).toBe(limpio.distanceMeters);
      expect(conRuido.discardedPoints).toBe(1);
    });

    it('descarta el salto imposible aunque venga con buena precision', () => {
      const puntos = recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 5 });
      // Un punto a 5 km del anterior, un segundo despues: 5000 m/s.
      puntos.splice(20, 0, {
        recordedAt: new Date(puntos[19]!.recordedAt.getTime() + 1000),
        lat: puntos[19]!.lat + 0.05,
        lng: 0,
        altitude: null,
        accuracyMeters: 5,
      });

      const m = consolidar(puntos);
      expect(m.distanceMeters).toBeLessThan(1200);
      expect(m.discardedPoints).toBeGreaterThan(0);
    });

    it('no une los dos lados de un hueco largo con una linea recta', () => {
      const antes = recta({ puntos: 21, metrosPorPunto: 25, segundosPorPunto: 5 });
      const despues = recta({ puntos: 21, metrosPorPunto: 25, segundosPorPunto: 5 }).map((p) => ({
        ...p,
        // Diez minutos despues y 2 km mas al norte: la app estuvo congelada.
        recordedAt: new Date(p.recordedAt.getTime() + 600_000 + 100_000),
        lat: p.lat + 2000 / METROS_POR_GRADO_LAT,
      }));

      const m = consolidar([...antes, ...despues]);
      // Los dos tramos de 500 m, sin los 2 km del hueco.
      expect(m.distanceMeters).toBeCloseTo(1000, -2);
    });

    it('el tiempo parado no cuenta como movimiento pero si como duracion', () => {
      const corriendo = recta({ puntos: 21, metrosPorPunto: 25, segundosPorPunto: 5 });
      const parado: Punto[] = Array.from({ length: 12 }, (_, i) => ({
        ...corriendo.at(-1)!,
        recordedAt: new Date(corriendo.at(-1)!.recordedAt.getTime() + (i + 1) * 5000),
      }));

      const m = consolidar([...corriendo, ...parado]);
      expect(m.durationSeconds).toBe(160); // 100 s corriendo + 60 s parado
      expect(m.movingSeconds).toBe(100);
    });

    it('el desnivel ignora el temblor del sensor y suma solo las subidas', () => {
      // 1 m por punto: por debajo del umbral de 3 m, pero acumulativo.
      const subiendo = consolidar(
        recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 5, altitudPorPunto: 1 }),
      );
      // 40 puntos x 1 m = 40 m reales de subida, contados en saltos de >=3 m.
      expect(subiendo.elevationGainMeters).toBeGreaterThan(30);
      expect(subiendo.elevationGainMeters).toBeLessThanOrEqual(40);

      const llano = consolidar(
        recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 5, altitudPorPunto: 0 }),
      );
      expect(llano.elevationGainMeters).toBe(0);
    });

    it('acepta puntos sin precision declarada', () => {
      const m = consolidar(
        recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 5, accuracy: null }),
      );
      expect(m.distanceMeters).toBeGreaterThan(900);
      expect(m.discardedPoints).toBe(0);
    });

    it('ordena los puntos: un lote que llega tarde no rompe la medicion', () => {
      const puntos = recta({ puntos: 41, metrosPorPunto: 25, segundosPorPunto: 5 });
      const desordenados = [...puntos.slice(20), ...puntos.slice(0, 20)];

      expect(consolidar(desordenados).distanceMeters).toBe(consolidar(puntos).distanceMeters);
    });
  });

  describe('calorias', () => {
    it('estima con el peso del corredor', () => {
      // 10 km/h durante 1 h, 70 kg -> ~10 MET x 70 kg x 1 h = 700 kcal.
      expect(calorias(10_000, 3600, 70_000)).toBe(700);
    });

    it('es null sin peso: no se inventa un corredor medio', () => {
      expect(calorias(10_000, 3600, null)).toBeNull();
      expect(calorias(10_000, 3600, 0)).toBeNull();
    });

    it('es null sin recorrido', () => {
      expect(calorias(0, 3600, 70_000)).toBeNull();
    });
  });
  describe('marcadores', () => {
    it('emite uno cada 5 km, con el tiempo acumulado desde la salida', () => {
      // 12 km a 5 m/s: la marca del km 5 cae a los 1000 s, la del 10 a los 2000.
      const marcas = marcadores(recta({ puntos: 2401, metrosPorPunto: 5, segundosPorPunto: 1 }));

      expect(marcas.map((m) => m.kmMark)).toEqual([5, 10]);
      expect(marcas[0]!.splitSeconds).toBe(1000);
      expect(marcas[1]!.splitSeconds).toBe(2000);
      expect(marcas[0]!.lat).toBeCloseTo(5000 / METROS_POR_GRADO_LAT, 6);
    });

    it('interpola dentro del tramo que cruza la marca', () => {
      // Un punto cada 100 m: la marca del km 1 cae en mitad de un tramo.
      const marcas = marcadores(
        recta({ puntos: 21, metrosPorPunto: 100, segundosPorPunto: 30 }),
        1000,
      );

      expect(marcas[0]!.kmMark).toBe(1);
      expect(marcas[0]!.splitSeconds).toBe(300);
    });

    it('no inventa marcas si no se llego a la primera', () => {
      expect(marcadores(recta({ puntos: 100, metrosPorPunto: 5, segundosPorPunto: 1 }))).toEqual(
        [],
      );
    });
  });
});
