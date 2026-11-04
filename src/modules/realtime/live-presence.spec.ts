import { LiveGateway } from './live.gateway';

describe('presencia en la sala de espera', () => {
  const findFirst = jest.fn();
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit }));
  const gateway = Object.assign(Object.create(LiveGateway.prototype) as object, {
    prisma: { registration: { findFirst } },
    server: { to },
    presentes: new Map(),
  }) as unknown as LiveGateway;

  const socket = (id: string, userId = 'u-1') => ({ id, userId }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue({ bibNumber: '7' });
  });

  it('cuenta al abrir la app, publica su punto y lo suelta al cerrar', async () => {
    const a = socket('s-1');
    expect(await gateway.presence(a, { marathonId: 'm-1' })).toEqual({ ok: true });
    expect(emit).toHaveBeenCalledWith('marathon:presence', { marathonId: 'm-1', count: 1 });

    await gateway.presence(a, { marathonId: 'm-1', lat: -12.0464, lng: -77.0428 });
    expect(emit).toHaveBeenCalledWith(
      'runner:position',
      expect.objectContaining({ bib: '7', lat: -12.0464, lng: -77.0428, distanceMeters: 0 }),
    );
    expect(gateway.posicionesDePresentes('m-1')).toHaveLength(1);

    // El mismo usuario en dos telefonos es una persona.
    const b = socket('s-2');
    await gateway.presence(b, { marathonId: 'm-1' });
    expect(gateway.contarPresentes('m-1')).toBe(1);

    gateway.handleDisconnect(a);
    gateway.handleDisconnect(b);
    expect(gateway.contarPresentes('m-1')).toBe(0);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('rechaza a quien no esta inscrito en una carrera en preparacion', async () => {
    findFirst.mockResolvedValue(null);
    const r = await gateway.presence(socket('s-3'), { marathonId: 'm-1', lat: 1, lng: 1 });
    expect(r.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
