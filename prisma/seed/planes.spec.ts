import { PLANTILLAS, factorSemanal, sesionesDe } from './planes';

/**
 * Las plantillas se generan, no se escriben a mano: 378 sesiones tecleadas
 * serian 378 oportunidades de equivocarse. Lo que hay que probar es que el
 * generador produzca planes con sentido de entrenamiento, y sobre todo que no
 * viole el `@@unique([templateId, week, weekday])` — eso reventaria el seed
 * entero contra la base.
 */
describe('generador de plantillas de plan', () => {
  describe('factorSemanal', () => {
    it('afina en las dos ultimas semanas: la de la carrera es la mas suave', () => {
      expect(factorSemanal(15, 16)).toBe(0.65);
      expect(factorSemanal(16, 16)).toBe(0.45);
      expect(factorSemanal(16, 16)).toBeLessThan(factorSemanal(14, 16));
    });

    it('mete una semana de descarga cada cuatro', () => {
      expect(factorSemanal(4, 16)).toBeLessThan(factorSemanal(3, 16));
      expect(factorSemanal(5, 16)).toBeGreaterThan(factorSemanal(4, 16));
    });

    it('la carga sube de la primera semana a la ultima de construccion', () => {
      expect(factorSemanal(13, 16)).toBeGreaterThan(factorSemanal(1, 16));
    });
  });

  describe('sesionesDe', () => {
    it.each(PLANTILLAS.map((p) => [p.slug, p] as const))(
      '%s no repite dia dentro de una semana',
      (_slug, plantilla) => {
        const sesiones = sesionesDe(plantilla);
        const claves = sesiones.map((s) => `${s.week}-${s.weekday}`);

        expect(new Set(claves).size).toBe(sesiones.length);
      },
    );

    it.each(PLANTILLAS.map((p) => [p.slug, p] as const))(
      '%s cabe en el rango del PROMT: 8-16 semanas, 3-5 sesiones',
      (_slug, plantilla) => {
        expect(plantilla.totalWeeks).toBeGreaterThanOrEqual(8);
        expect(plantilla.totalWeeks).toBeLessThanOrEqual(16);
        expect(plantilla.patron.length).toBeGreaterThanOrEqual(3);
        expect(plantilla.patron.length).toBeLessThanOrEqual(5);
      },
    );

    it('ninguna tirada larga de un plan de maraton llega a la distancia de carrera', () => {
      const maraton = PLANTILLAS.find((p) => p.goalDistanceMeters === 42_195)!;
      const largas = sesionesDe(maraton).filter((s) => s.type === 'long');

      // A la maraton se llega con 30K de tope: los 42 los pone el dia de la
      // carrera. Un plan que te hace correr 42K entrenando produce lesionados.
      expect(Math.max(...largas.map((s) => s.targetDistanceMeters))).toBeLessThanOrEqual(30_000);
    });

    it.each(PLANTILLAS.map((p) => [p.slug, p] as const))(
      '%s entrega el volumen semanal que anuncia',
      (_slug, plantilla) => {
        const total = sesionesDe(plantilla).reduce((a, s) => a + s.targetDistanceMeters, 0);
        const medio = total / plantilla.totalWeeks;

        // ±5%, solo lo que mueven los redondeos a 500 m. El corredor elige la
        // plantilla POR este numero: si dice 38 km por semana y entrega 30, el
        // catalogo miente. Es lo que rompian el afinamiento sin normalizar y el
        // techo de la larga sin repartir el sobrante.
        expect(medio).toBeGreaterThan(plantilla.avgWeeklyDistanceMeters * 0.95);
        expect(medio).toBeLessThan(plantilla.avgWeeklyDistanceMeters * 1.05);
      },
    );

    it.each(PLANTILLAS.map((p) => [p.slug, p] as const))(
      '%s no manda a correr entrenando mas que el objetivo, salvo en distancias cortas',
      (_slug, plantilla) => {
        const largas = sesionesDe(plantilla).filter((s) => s.type === 'long');
        const maxima = Math.max(...largas.map((s) => s.targetDistanceMeters));

        // En 21K y 42K la larga se queda por debajo del objetivo. En 5K y 10K
        // lo pasa, y esta bien: ahi el limite no lo pone la carrera.
        if (plantilla.goalDistanceMeters >= 21_097) {
          expect(maxima).toBeLessThan(plantilla.goalDistanceMeters);
        } else {
          expect(maxima).toBeGreaterThanOrEqual(plantilla.goalDistanceMeters);
        }
      },
    );

    it('las sesiones de calidad y la larga quedan marcadas como clave', () => {
      const sesiones = sesionesDe(PLANTILLAS[0]!);

      expect(sesiones.filter((s) => s.type === 'long').every((s) => s.isKeySession)).toBe(true);
      expect(sesiones.filter((s) => s.type === 'easy').every((s) => !s.isKeySession)).toBe(true);
    });
  });
});
