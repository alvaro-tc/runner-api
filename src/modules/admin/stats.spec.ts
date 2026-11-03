import { perfilInscritas, serieDiaria } from './stats';

describe('stats del resumen', () => {
  it('agrupa por dia de La Paz y rellena huecos', () => {
    const pagos = [
      // 02:00 UTC del 3 = 22:00 del 2 en La Paz
      { paidAt: new Date('2026-10-03T02:00:00Z'), amountCents: 100 },
      { paidAt: new Date('2026-10-04T15:00:00Z'), amountCents: 200 },
      { paidAt: null, amountCents: 999 },
    ];
    const s = serieDiaria(pagos, new Date('2026-10-05T15:00:00Z'));
    expect(s).toEqual([
      { date: '2026-10-02', confirmed: 1, revenueCents: 100 },
      { date: '2026-10-03', confirmed: 0, revenueCents: 0 },
      { date: '2026-10-04', confirmed: 1, revenueCents: 200 },
      { date: '2026-10-05', confirmed: 0, revenueCents: 0 },
    ]);
  });

  it('recorta la serie a maxDias y devuelve hoy aunque no haya cobros', () => {
    expect(serieDiaria([], new Date('2026-10-05T15:00:00Z'))).toHaveLength(1);
    const viejo = [{ paidAt: new Date('2025-01-01T15:00:00Z'), amountCents: 1 }];
    expect(serieDiaria(viejo, new Date('2026-10-05T15:00:00Z'), 7)).toHaveLength(7);
  });

  it('perfila edades a la fecha de largada', () => {
    const p = perfilInscritas(
      [
        { personalData: { knowsCam: true }, category: null, birthDate: new Date('2000-11-23') },
        { personalData: {}, category: '10K', birthDate: new Date('1960-01-01') },
        { personalData: null, category: '10K', birthDate: null },
      ],
      new Date('2026-11-22'),
    );
    expect(p.ages).toEqual({ '18-29': 1, '60+': 1, sin_dato: 1 });
    expect(p.knowsCam).toEqual({ si: 1, sin_dato: 2 });
    expect(p.categories).toEqual({ 'Sin categoría': 1, '10K': 2 });
  });
});
