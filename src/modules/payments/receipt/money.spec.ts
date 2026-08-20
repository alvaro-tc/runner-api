import { formatearBs, formatearFecha, formatearMonto } from './money';

describe('formatearMonto', () => {
  it('usa coma decimal y punto de miles, como se escribe en Bolivia', () => {
    expect(formatearMonto(1_234_567)).toBe('12.345,67');
    expect(formatearMonto(100_000)).toBe('1.000,00');
    expect(formatearMonto(20_000)).toBe('200,00');
  });

  it('siempre lleva dos decimales', () => {
    expect(formatearMonto(500)).toBe('5,00');
    expect(formatearMonto(505)).toBe('5,05');
    expect(formatearMonto(550)).toBe('5,50');
  });

  it('maneja el cero y los importes pequenos', () => {
    expect(formatearMonto(0)).toBe('0,00');
    expect(formatearMonto(1)).toBe('0,01');
    expect(formatearMonto(99)).toBe('0,99');
  });

  it('pone el signo delante en un reembolso', () => {
    expect(formatearMonto(-20_000)).toBe('-200,00');
  });

  it('separa los miles en importes grandes', () => {
    expect(formatearMonto(123_456_789)).toBe('1.234.567,89');
  });

  it('anade el simbolo', () => {
    expect(formatearBs(20_000)).toBe('Bs 200,00');
  });
});

describe('formatearFecha', () => {
  it('formatea en dd/mm/aaaa hh:mm y en la zona pedida', () => {
    // 15:04 UTC son las 11:04 en La Paz (UTC-4, sin horario de verano).
    const fecha = new Date('2026-08-19T15:04:00.000Z');

    expect(formatearFecha(fecha, 'America/La_Paz')).toBe('19/08/2026 11:04');
  });

  it('cruza el dia hacia atras cuando toca', () => {
    const fecha = new Date('2026-08-19T02:30:00.000Z');

    expect(formatearFecha(fecha, 'America/La_Paz')).toBe('18/08/2026 22:30');
  });

  it('usa reloj de 24 horas', () => {
    const fecha = new Date('2026-08-19T23:00:00.000Z');

    expect(formatearFecha(fecha, 'America/La_Paz')).toBe('19/08/2026 19:00');
  });
});
