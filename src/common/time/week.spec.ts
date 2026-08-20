import { rangoSemanal } from './week';

/**
 * Lo que se prueba es justamente el caso que rompe el calculo ingenuo en UTC:
 * la noche del domingo en La Paz, que en UTC ya es lunes.
 */
describe('rangoSemanal', () => {
  const LA_PAZ = 'America/La_Paz';

  it('empieza el lunes a las 00:00 locales (04:00 UTC en La Paz)', () => {
    // Miercoles 19 de agosto de 2026, 15:00 UTC = 11:00 en La Paz.
    const { start, end } = rangoSemanal(new Date('2026-08-19T15:00:00Z'), LA_PAZ);

    expect(start.toISOString()).toBe('2026-08-17T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-24T04:00:00.000Z');
  });

  it('cuenta la noche del domingo local en la semana que termina, no en la siguiente', () => {
    // Domingo 23/08 a las 22:00 en La Paz = lunes 24/08 02:00 UTC.
    const domingoDeNoche = new Date('2026-08-24T02:00:00Z');
    const { start, end } = rangoSemanal(domingoDeNoche, LA_PAZ);

    expect(start.toISOString()).toBe('2026-08-17T04:00:00.000Z');
    expect(domingoDeNoche.getTime()).toBeLessThan(end.getTime());
  });

  it('el lunes a las 00:00 locales pertenece a su propia semana', () => {
    const lunesCero = new Date('2026-08-17T04:00:00Z');
    const { start } = rangoSemanal(lunesCero, LA_PAZ);

    expect(start.getTime()).toBe(lunesCero.getTime());
  });

  it('funciona en una zona con horario de verano', () => {
    const { start, end } = rangoSemanal(new Date('2026-08-19T15:00:00Z'), 'Europe/Madrid');

    // Madrid en agosto va en UTC+2: el lunes local arranca a las 22:00 del domingo UTC.
    expect(start.toISOString()).toBe('2026-08-16T22:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('en UTC la semana empieza a medianoche exacta', () => {
    const { start, end } = rangoSemanal(new Date('2026-08-19T15:00:00Z'), 'UTC');

    expect(start.toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });
});
