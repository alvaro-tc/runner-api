import { RegistrationStatus, UserRole } from '../../../generated/prisma/enums';
import { LiveGateway } from './live.gateway';

describe('suscripcion del corredor', () => {
  const count = jest.fn();
  const findFirst = jest.fn();
  const emit = jest.fn();
  const to = jest.fn((rooms: string | string[]) => {
    void rooms;
    return { emit };
  });
  const gateway = Object.assign(Object.create(LiveGateway.prototype) as object, {
    prisma: { marathon: { count }, registration: { findFirst } },
    server: { to },
  }) as unknown as LiveGateway;

  function client() {
    return {
      userId: 'user-1',
      role: UserRole.runner,
      join: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    count.mockResolvedValue(1);
    findFirst.mockResolvedValue({ bibNumber: 'A-007' });
  });

  it('recibe el estado y su propio dorsal sin entrar al mapa completo', async () => {
    const socket = client();
    await gateway.spectate(socket as never, { marathonId: 'm-1', positions: false });
    expect(socket.join.mock.calls.map(([room]: [string]) => room)).toEqual([
      'marathon:m-1:state',
      'marathon:m-1:runner:A-007',
    ]);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        marathonId: 'm-1',
        userId: 'user-1',
        status: RegistrationStatus.confirmed,
        deletedAt: null,
      },
      select: { bibNumber: true },
    });
  });

  it('no permite elegir un dorsal de otro usuario ni entrar sin inscripcion', async () => {
    findFirst.mockResolvedValue(null);
    const socket = client();
    const result = await gateway.spectate(socket as never, {
      marathonId: 'm-1',
      positions: false,
    });
    expect(result.ok).toBe(false);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('espera el handshake antes de aceptar una suscripcion inmediata', async () => {
    let authenticate!: () => void;
    const authenticated = new Promise<void>((resolve) => {
      authenticate = resolve;
    });
    const socket = { ...client(), authenticated };
    const pending = gateway.spectate(socket as never, { marathonId: 'm-1', positions: false });
    await Promise.resolve();
    expect(count).not.toHaveBeenCalled();
    authenticate();
    expect((await pending).ok).toBe(true);
  });

  it('cerrar la pantalla durante la consulta no deja una sala viva', async () => {
    let resolve!: (value: { bibNumber: string }) => void;
    findFirst.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const socket = client();
    const pending = gateway.spectate(socket as never, { marathonId: 'm-1', positions: false });
    await Promise.resolve();
    await Promise.resolve();
    await gateway.leave(socket as never, { marathonId: 'm-1', positions: false });
    resolve({ bibNumber: 'A-007' });
    expect((await pending).ok).toBe(false);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('conserva el canal completo para espectadores existentes', async () => {
    const socket = client();
    expect(await gateway.spectate(socket as never, { marathonId: 'm-1' })).toEqual({
      ok: true,
      room: 'marathon:m-1',
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('publica posicion y llegada solo al mapa y al dorsal correspondiente', () => {
    const payload = { bib: 'A-007', lat: 0, lng: 0, distanceMeters: 10, lap: 1, t: '' };
    gateway.emitirPosicion('m-1', payload);
    gateway.emitirLlegada('m-1', payload);
    expect(to.mock.calls).toEqual([
      [['marathon:m-1', 'marathon:m-1:runner:A-007']],
      [['marathon:m-1', 'marathon:m-1:runner:A-007']],
    ]);
    expect(emit.mock.calls.map(([event]: [string, unknown]) => event)).toEqual([
      'runner:position',
      'runner:finish',
    ]);
  });

  it('envia preparacion, largada y corte a todos los canales necesarios', () => {
    gateway.emitirEstado(
      'm-1',
      {
        marathonId: 'm-1',
        state: 'in_progress',
        preparingAt: null,
        preparingMessage: null,
        startedAt: '2026-09-30T12:00:00Z',
        finishedAt: null,
      },
      ['user-1'],
    );
    expect(to).toHaveBeenCalledWith(['marathon:m-1', 'marathon:m-1:state', 'user:user-1']);
  });

  it('soltar la suscripcion propia no suelta el mapa de otro consumidor', async () => {
    const socket = client();
    await gateway.spectate(socket as never, { marathonId: 'm-1', positions: false });
    await gateway.leave(socket as never, { marathonId: 'm-1', positions: false });
    expect(socket.leave.mock.calls.map(([room]: [string]) => room)).toEqual([
      'marathon:m-1:state',
      'marathon:m-1:runner:A-007',
    ]);
  });
});
