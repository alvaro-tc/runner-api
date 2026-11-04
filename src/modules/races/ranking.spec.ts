import { calcularPuestos, type FilaPuesto } from './ranking';

const fila = (id: string, t: number, extra: Partial<FilaPuesto> = {}): FilaPuesto => ({
  id,
  finishTimeSeconds: t,
  finishedAt: new Date(t * 1000),
  manualOverallRank: null,
  categoryId: 'A',
  llego: true,
  ...extra,
});

const puestos = (filas: FilaPuesto[]) =>
  Object.fromEntries([...calcularPuestos(filas)].map(([id, p]) => [id, p.overallRank]));

describe('calcularPuestos', () => {
  it('ordena por tiempo y los empates comparten puesto', () => {
    expect(puestos([fila('c', 300), fila('a', 100), fila('b', 100)])).toEqual({ a: 1, b: 1, c: 3 });
  });

  it('quien no llego a la meta va detras aunque su tiempo sea menor', () => {
    expect(puestos([fila('retirado', 50, { llego: false }), fila('x', 200)])).toEqual({
      x: 1,
      retirado: 2,
    });
  });

  it('respeta un orden manual completo', () => {
    const filas = [
      fila('a', 100, { manualOverallRank: 3 }),
      fila('b', 200, { manualOverallRank: 1 }),
      fila('c', 300, { manualOverallRank: 2 }),
    ];
    expect(puestos(filas)).toEqual({ a: 3, b: 1, c: 2 });
  });

  it('los automaticos ocupan los huecos que dejan los manuales', () => {
    expect(puestos([fila('a', 100), fila('b', 200), fila('m', 999, { manualOverallRank: 1 })])).toEqual({
      m: 1,
      a: 2,
      b: 3,
    });
  });

  it('la categoria sigue el orden general corregido', () => {
    const r = calcularPuestos([
      fila('a', 100, { manualOverallRank: 2 }),
      fila('b', 200, { manualOverallRank: 1 }),
      fila('c', 300, { categoryId: 'B' }),
    ]);
    expect(r.get('b')!.categoryRank).toBe(1);
    expect(r.get('a')!.categoryRank).toBe(2);
    expect(r.get('c')).toEqual({ overallRank: 3, categoryRank: 1 });
  });
});
