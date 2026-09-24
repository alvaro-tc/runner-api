import { AdminService } from './admin.service';

/** El buscador de la cola de cobros del organizador. */
describe('listado de cobros del panel', () => {
  const count = jest.fn().mockResolvedValue(0);
  const findMany = jest
    .fn<Promise<unknown[]>, [{ where: Record<string, unknown> }]>()
    .mockResolvedValue([]);
  const admin = Object.assign(Object.create(AdminService.prototype) as object, {
    prisma: {
      payment: { count, findMany },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    },
  }) as unknown as AdminService;

  beforeEach(() => findMany.mockClear());

  const where = () => findMany.mock.lastCall![0].where;

  it('sin busqueda no mete un OR', async () => {
    await admin.listarPagos({ marathonId: 'm1', q: '   ' });
    expect(where()).toEqual({ registration: { deletedAt: null, marathonId: 'm1' } });
  });

  it('busca en la inscripcion, el dorsal y el numero de transaccion', async () => {
    await admin.listarPagos({ q: ' 4521 ' });
    const ramas = where().OR as Record<string, unknown>[];
    expect(ramas).toHaveLength(3);
    expect(ramas[2]).toEqual({
      proofs: { some: { reference: { contains: '4521', mode: 'insensitive' } } },
    });
  });
});
