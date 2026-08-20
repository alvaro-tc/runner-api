import { PlanLevel } from '../../../generated/prisma/enums';
import { riegel, ritmoBase } from './pace-basis';

describe('pace-basis', () => {
  describe('riegel', () => {
    it('proyecta mas lento a mayor distancia', () => {
      const diezK = { distanceMeters: 10_000, durationSeconds: 50 * 60 }; // 5:00/km
      expect(riegel(diezK, 10_000)).toBeCloseTo(300, 0);
      expect(riegel(diezK, 21_097)).toBeGreaterThan(300);
      expect(riegel(diezK, 42_195)).toBeGreaterThan(riegel(diezK, 21_097));
    });

    it('reproduce el ejemplo clasico: 10K en 50:00 -> maraton ~3:50', () => {
      const segundos = riegel({ distanceMeters: 10_000, durationSeconds: 3000 }, 42_195) * 42.195;
      expect(segundos / 60).toBeCloseTo(230, 0);
    });
  });

  describe('ritmoBase', () => {
    const rapido = { distanceMeters: 10_000, durationSeconds: 45 * 60 };
    const lento = { distanceMeters: 10_000, durationSeconds: 60 * 60 };

    it('cae al nivel declarado con menos de 3 entrenamientos', () => {
      expect(ritmoBase([rapido, rapido], 10_000, PlanLevel.beginner)).toEqual({
        paceBasisSecPerKm: 420,
        source: 'declared_level',
      });
    });

    it('toma el mejor esfuerzo, no el promedio', () => {
      const { paceBasisSecPerKm, source } = ritmoBase(
        [lento, lento, rapido],
        10_000,
        PlanLevel.beginner,
      );
      expect(source).toBe('recent_efforts');
      expect(paceBasisSecPerKm).toBe(270);
    });

    it('ignora los tramos demasiado cortos para proyectar', () => {
      const cortito = { distanceMeters: 800, durationSeconds: 180 };
      expect(ritmoBase([cortito, cortito, cortito], 10_000, PlanLevel.advanced).source).toBe(
        'declared_level',
      );
    });

    it('acota los datos imposibles en vez de propagarlos', () => {
      const absurdo = { distanceMeters: 10_000, durationSeconds: 60 };
      expect(
        ritmoBase([absurdo, absurdo, absurdo], 10_000, PlanLevel.advanced).paceBasisSecPerKm,
      ).toBe(150);
    });
  });
});
