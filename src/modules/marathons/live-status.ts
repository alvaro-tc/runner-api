/**
 * En que punto de su dia esta una maraton.
 *
 * **Sale de las tres fechas, no de una columna.** Guardar ademas un enum
 * significaria dos sitios que pueden discrepar: una carrera con `liveStartedAt`
 * puesto y el enum diciendo `preparing` no tiene arreglo automatico, porque no
 * hay forma de saber cual de los dos mintio. Derivarlo no puede desincronizarse.
 *
 * El orden de las comprobaciones es el orden real del dia: una vez cortada ya
 * no importa que estuviera corriendo, y una vez largada ya no importa que
 * estuviera en preparacion.
 */
export type EstadoEnVivo = 'not_started' | 'preparing' | 'in_progress' | 'finished';

export interface FechasEnVivo {
  preparingAt: Date | null;
  liveStartedAt: Date | null;
  liveFinishedAt: Date | null;
}

export function estadoEnVivo(m: FechasEnVivo): EstadoEnVivo {
  if (m.liveFinishedAt) return 'finished';
  if (m.liveStartedAt) return 'in_progress';
  if (m.preparingAt) return 'preparing';
  return 'not_started';
}

/**
 * Si el inscrito tiene la app bloqueada por esta maraton.
 *
 * `preparing` e `in_progress` son los dos estados en los que el corredor no
 * puede estar en otra pantalla. Lo de despues —"ya llegue pero la carrera
 * sigue"— no se decide aqui: eso depende de si esa persona tiene resultado, y
 * esto solo sabe de la maraton.
 */
export function bloqueaAlInscrito(estado: EstadoEnVivo): boolean {
  return estado === 'preparing' || estado === 'in_progress';
}
