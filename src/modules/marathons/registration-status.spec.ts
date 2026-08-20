import { MarathonRegistrationStatus } from '../../../generated/prisma/enums';
import { admiteInscripcion, cuposDisponibles, resolverEstado } from './registration-status';

describe('resolverEstado', () => {
  const ahora = new Date('2026-08-18T12:00:00Z');
  const enDias = (dias: number) => new Date(ahora.getTime() + dias * 86_400_000);

  const abierta = {
    registrationStatus: MarathonRegistrationStatus.open,
    capacity: 1000,
    slotsTaken: 100,
    startsAt: enDias(60),
    registrationClosesAt: null,
  };

  it('abierta cuando sobra cupo y falta tiempo', () => {
    expect(resolverEstado(abierta, ahora)).toBe('open');
  });

  it('cerrada por decision del admin, aunque queden cupos y tiempo', () => {
    const estado = resolverEstado(
      { ...abierta, registrationStatus: MarathonRegistrationStatus.closed },
      ahora,
    );

    expect(estado).toBe('closed');
  });

  it('llena cuando los cupos se agotaron', () => {
    expect(resolverEstado({ ...abierta, slotsTaken: 1000 }, ahora)).toBe('full');
  });

  it('llena tambien si el contador se paso de la capacidad', () => {
    expect(resolverEstado({ ...abierta, slotsTaken: 1001 }, ahora)).toBe('full');
  });

  it('por cerrar cuando queda menos del 10% del cupo', () => {
    expect(resolverEstado({ ...abierta, slotsTaken: 901 }, ahora)).toBe('closing_soon');
    // Justo el 10% todavia no dispara el aviso.
    expect(resolverEstado({ ...abierta, slotsTaken: 900 }, ahora)).toBe('open');
  });

  it('por cerrar cuando faltan menos de 7 dias para la largada', () => {
    expect(resolverEstado({ ...abierta, startsAt: enDias(6) }, ahora)).toBe('closing_soon');
    expect(resolverEstado({ ...abierta, startsAt: enDias(8) }, ahora)).toBe('open');
  });

  it('cerrada cuando la carrera ya paso', () => {
    expect(resolverEstado({ ...abierta, startsAt: enDias(-1) }, ahora)).toBe('closed');
  });

  it('cerrada cuando vencio el cierre de inscripciones, aunque falte la carrera', () => {
    const estado = resolverEstado(
      { ...abierta, startsAt: enDias(30), registrationClosesAt: enDias(-2) },
      ahora,
    );

    expect(estado).toBe('closed');
  });

  it('el cierre vencido gana sobre el cupo agotado: cerrada, no llena', () => {
    const estado = resolverEstado(
      { ...abierta, slotsTaken: 1000, registrationClosesAt: enDias(-1) },
      ahora,
    );

    expect(estado).toBe('closed');
  });
});

describe('cuposDisponibles', () => {
  it('nunca devuelve negativos', () => {
    expect(cuposDisponibles({ capacity: 100, slotsTaken: 130 })).toBe(0);
    expect(cuposDisponibles({ capacity: 100, slotsTaken: 40 })).toBe(60);
  });
});

describe('admiteInscripcion', () => {
  it('solo abierta y por cerrar dejan inscribirse', () => {
    expect(admiteInscripcion(MarathonRegistrationStatus.open)).toBe(true);
    expect(admiteInscripcion(MarathonRegistrationStatus.closing_soon)).toBe(true);
    expect(admiteInscripcion(MarathonRegistrationStatus.full)).toBe(false);
    expect(admiteInscripcion(MarathonRegistrationStatus.closed)).toBe(false);
  });
});
