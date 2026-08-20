import {
  SEMANAS_TAPERING,
  diaIso,
  fechaLocal,
  lunesDe,
  lunesDesde,
  materializar,
  rangoRitmo,
  semanasConservadas,
  semanasDisponibles,
} from './plan-schedule';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('plan-schedule', () => {
  describe('fechaLocal', () => {
    it('usa el dia del reloj de pared, no el de UTC', () => {
      // 2026-06-08 01:30 UTC es todavia el domingo 7 en La Paz (UTC-4).
      expect(fechaLocal(new Date('2026-06-08T01:30:00Z'), 'America/La_Paz')).toEqual(
        d('2026-06-07'),
      );
      expect(fechaLocal(new Date('2026-06-08T01:30:00Z'), 'UTC')).toEqual(d('2026-06-08'));
    });
  });

  describe('lunes', () => {
    it('lunesDe retrocede al lunes de la semana', () => {
      expect(lunesDe(d('2026-06-11'))).toEqual(d('2026-06-08')); // jueves -> lunes
      expect(lunesDe(d('2026-06-08'))).toEqual(d('2026-06-08')); // ya es lunes
      expect(lunesDe(d('2026-06-14'))).toEqual(d('2026-06-08')); // domingo
    });

    it('lunesDesde avanza: un plan no arranca en el pasado', () => {
      expect(lunesDesde(d('2026-06-11'))).toEqual(d('2026-06-15'));
      expect(lunesDesde(d('2026-06-08'))).toEqual(d('2026-06-08'));
    });

    it('diaIso pone el domingo en 7, no en 0', () => {
      expect(diaIso(d('2026-06-08'))).toBe(1);
      expect(diaIso(d('2026-06-14'))).toBe(7);
    });
  });

  describe('semanasDisponibles', () => {
    it('cuenta la semana de la carrera entera', () => {
      // Lunes 8 a domingo 14: una sola semana.
      expect(semanasDisponibles(d('2026-06-08'), d('2026-06-14'))).toBe(1);
      expect(semanasDisponibles(d('2026-06-08'), d('2026-06-15'))).toBe(2);
    });

    it('arranca desde el lunes siguiente si hoy no es lunes', () => {
      expect(semanasDisponibles(d('2026-06-10'), d('2026-06-21'))).toBe(1);
    });
  });

  describe('semanasConservadas', () => {
    it('devuelve el plan entero cuando hay sitio de sobra', () => {
      expect(semanasConservadas(4, 10)).toEqual([1, 2, 3, 4]);
    });

    it('recorta del medio, nunca la primera ni el tapering', () => {
      const semanas = semanasConservadas(12, 8);
      expect(semanas).toHaveLength(8);
      expect(semanas[0]).toBe(1);
      expect(semanas.slice(-SEMANAS_TAPERING)).toEqual([11, 12]);
      // Las que faltan son las de base mas tempranas.
      expect(semanas).toEqual([1, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('no deja plan cuando ni recortando todo el medio entra', () => {
      expect(semanasConservadas(12, 2)).toEqual([]);
      expect(semanasConservadas(4, 3)).toEqual([1, 3, 4]);
    });
  });

  describe('rangoRitmo', () => {
    it('aplica el factor y abre +-4%', () => {
      // 300 s/km base, factor 1.15 -> 345 s/km objetivo.
      expect(rangoRitmo(300, 1.15)).toEqual({ paceMinSecPerKm: 331, paceMaxSecPerKm: 359 });
    });

    it('min es el ritmo mas rapido', () => {
      const { paceMinSecPerKm, paceMaxSecPerKm } = rangoRitmo(300, 1);
      expect(paceMinSecPerKm).toBeLessThan(paceMaxSecPerKm);
    });
  });

  describe('materializar', () => {
    const plantilla = [
      { week: 1, weekday: 2 },
      { week: 1, weekday: 6 },
      { week: 2, weekday: 2 },
      { week: 3, weekday: 3 },
    ];

    it('ubica cada sesion en su dia real', () => {
      const sesiones = materializar(plantilla, [1, 2, 3], d('2026-06-08'));
      expect(sesiones.map((s) => s.scheduledDate)).toEqual([
        d('2026-06-09'), // semana 1, martes
        d('2026-06-13'), // semana 1, sabado
        d('2026-06-16'), // semana 2, martes
        d('2026-06-24'), // semana 3, miercoles
      ]);
    });

    it('renumera las semanas conservadas desde 1', () => {
      const sesiones = materializar(plantilla, [1, 3], d('2026-06-08'));
      expect(sesiones.map((s) => [s.plantilla.week, s.week])).toEqual([
        [1, 1],
        [1, 1],
        [3, 2],
      ]);
      // La semana 3 de la plantilla cae en la segunda semana del plan.
      expect(sesiones.at(-1)!.scheduledDate).toEqual(d('2026-06-17'));
    });
  });
});
