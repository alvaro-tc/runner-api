import { RegistrationStatus } from '../../../generated/prisma/enums';
import { LiveService } from './live.service';
import type { EstadoCorredor, PuntoLive } from './live-state';

/**
 * La posicion de antes de la largada.
 *
 * Es el unico camino de la ingesta que publica **sin guardar**, y el que decide
 * si el organizador ve o no a la gente en la salida. Lo que se prueba es lo que
 * rompe en silencio: que solo publique quien esta inscrito en una maraton en
 * preparacion, que no consulte la base una vez por punto, y que la distancia
 * salga en cero —nadie ha corrido nada todavia—.
 */
describe('posicion en preparacion', () => {
  const deviceFindUnique = jest.fn();
  const registrationFindFirst = jest.fn();
  const emitirPosicion = jest.fn();

  const estados = new Map<string, EstadoCorredor>();
  const calentamientos = new Map<string, unknown>();

  const live = Object.assign(Object.create(LiveService.prototype) as object, {
    prisma: {
      device: { findUnique: deviceFindUnique },
      registration: { findFirst: registrationFindFirst },
    },
    config: { get: () => 5_000 },
    gateway: { emitirPosicion },
    logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    estados,
    cursos: new Map(),
    calentamientos,
  }) as unknown as LiveService;

  const punto = (segundo: number): PuntoLive => ({
    recordedAt: new Date(Date.UTC(2026, 7, 19, 10, 0, segundo)),
    lat: -16.5 + segundo / 1e4,
    lng: -68.15,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    estados.clear();
    calentamientos.clear();
    deviceFindUnique.mockResolvedValue({ id: 'dev_1', userId: 'user_1' });
    registrationFindFirst.mockResolvedValue({ marathonId: 'mar_1', bibNumber: 'A-007' });
  });

  it('publica al inscrito en una maraton en preparacion, con distancia cero', async () => {
    const publicado = await live.publicarCalentamiento('uuid-1', [punto(0)]);

    expect(publicado).toBe(true);
    expect(emitirPosicion).toHaveBeenCalledWith(
      'mar_1',
      expect.objectContaining({ bib: 'A-007', distanceMeters: 0 }),
    );
    expect(registrationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: RegistrationStatus.confirmed }),
      }),
    );
  });

  it('no vuelve a consultar la base en el siguiente punto', async () => {
    await live.publicarCalentamiento('uuid-1', [punto(0)]);
    await live.publicarCalentamiento('uuid-1', [punto(1)]);

    expect(deviceFindUnique).toHaveBeenCalledTimes(1);
    // El segundo punto cae dentro de la ventana de throttling: no se reenvia.
    expect(emitirPosicion).toHaveBeenCalledTimes(1);
  });

  it('no publica nada de un dispositivo sin carrera preparando', async () => {
    registrationFindFirst.mockResolvedValue(null);

    expect(await live.publicarCalentamiento('uuid-1', [punto(0)])).toBe(false);
    expect(emitirPosicion).not.toHaveBeenCalled();
  });

  it('la sesion de carrera se lleva por delante el estado de calentamiento', async () => {
    await live.publicarCalentamiento('uuid-1', [punto(0)]);
    expect(estados.has('device:dev_1')).toBe(true);

    // Sin puntos no publica nada, pero el marcador duplicado tiene que irse
    // igual: es lo primero que hace `publicar`.
    await live.publicar({ id: 'ses_1', workoutId: null, marathonId: 'mar_1', deviceId: 'dev_1' }, [
      punto(2),
    ]);

    expect(estados.has('device:dev_1')).toBe(false);
  });
});
