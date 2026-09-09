import { bloqueaAlInscrito, estadoEnVivo } from './live-status';

const fechas = (
  preparingAt: Date | null,
  liveStartedAt: Date | null,
  liveFinishedAt: Date | null,
) => ({
  preparingAt,
  liveStartedAt,
  liveFinishedAt,
});

const t = new Date('2026-09-02T10:00:00Z');

describe('estadoEnVivo', () => {
  it('sin ninguna fecha, no ha empezado', () => {
    expect(estadoEnVivo(fechas(null, null, null))).toBe('not_started');
  });

  it('solo con preparingAt, esta en preparacion', () => {
    expect(estadoEnVivo(fechas(t, null, null))).toBe('preparing');
  });

  it('la largada manda sobre la preparacion', () => {
    expect(estadoEnVivo(fechas(t, t, null))).toBe('in_progress');
  });

  it('el corte manda sobre todo lo demas', () => {
    expect(estadoEnVivo(fechas(t, t, t))).toBe('finished');
    expect(estadoEnVivo(fechas(null, null, t))).toBe('finished');
  });

  it('bloquea al inscrito solo mientras prepara o corre', () => {
    expect(bloqueaAlInscrito('not_started')).toBe(false);
    expect(bloqueaAlInscrito('preparing')).toBe(true);
    expect(bloqueaAlInscrito('in_progress')).toBe(true);
    expect(bloqueaAlInscrito('finished')).toBe(false);
  });
});
