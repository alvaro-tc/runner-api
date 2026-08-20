import { MarathonRegistrationStatus } from '../../../generated/prisma/enums';

/**
 * El estado de inscripcion se **deriva al leer**, no se guarda.
 *
 * La columna `registrationStatus` guarda la INTENCION del admin, y solo se
 * respeta cuando dice `closed`: es el interruptor manual para cerrar una
 * maraton antes de tiempo. Todo lo demas (llena, por cerrar, abierta) sale de
 * los datos que ya existen — cupos, fecha de largada, cierre de inscripciones.
 *
 * La alternativa era un job que recorriera la tabla actualizando la columna.
 * Se descarto: entre dos corridas del job la columna miente, y "miente durante
 * 5 minutos" en un dato que decide si alguien puede pagar o no es exactamente
 * el bug que nadie reproduce. Derivar cuesta cero consultas extra y no puede
 * quedar desincronizado.
 */

/** Queda `closing_soon` cuando resta menos de este porcentaje del cupo. */
export const UMBRAL_CUPO_RESTANTE = 0.1;
/** ...o cuando faltan menos de estos dias para la largada. */
export const DIAS_PARA_CIERRE_PROXIMO = 7;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

export interface DatosDeEstado {
  registrationStatus: MarathonRegistrationStatus;
  capacity: number;
  slotsTaken: number;
  startsAt: Date;
  registrationClosesAt: Date | null;
}

export function resolverEstado(
  maraton: DatosDeEstado,
  ahora: Date = new Date(),
): MarathonRegistrationStatus {
  // El cierre manual manda sobre todo lo demas: si el organizador cerro las
  // inscripciones, que queden cupos no las reabre.
  if (maraton.registrationStatus === MarathonRegistrationStatus.closed) {
    return MarathonRegistrationStatus.closed;
  }

  const cierre = maraton.registrationClosesAt ?? maraton.startsAt;
  if (cierre.getTime() <= ahora.getTime()) {
    return MarathonRegistrationStatus.closed;
  }

  if (maraton.slotsTaken >= maraton.capacity) {
    return MarathonRegistrationStatus.full;
  }

  const restantes = maraton.capacity - maraton.slotsTaken;
  const pocoCupo = restantes < maraton.capacity * UMBRAL_CUPO_RESTANTE;
  const pocoTiempo =
    maraton.startsAt.getTime() - ahora.getTime() < DIAS_PARA_CIERRE_PROXIMO * MS_POR_DIA;

  return pocoCupo || pocoTiempo
    ? MarathonRegistrationStatus.closing_soon
    : MarathonRegistrationStatus.open;
}

/** Cupos libres, nunca negativo aunque la columna se haya pasado de rosca. */
export function cuposDisponibles(maraton: Pick<DatosDeEstado, 'capacity' | 'slotsTaken'>): number {
  return Math.max(0, maraton.capacity - maraton.slotsTaken);
}

/** True si todavia se puede inscribir. Lo usara el checkout en la Fase 7. */
export function admiteInscripcion(estado: MarathonRegistrationStatus): boolean {
  return (
    estado === MarathonRegistrationStatus.open || estado === MarathonRegistrationStatus.closing_soon
  );
}
