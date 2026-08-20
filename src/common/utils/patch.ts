/**
 * Se queda solo con las claves que el cliente **envio de verdad**.
 *
 * En un PATCH, `undefined` (ausente) y `null` (borrar) significan cosas
 * distintas, y Prisma no las distingue: pasarle `city: undefined` lo ignora,
 * que es justo lo que queremos para lo ausente, pero armar el objeto con
 * `city: dto.city` mete la clave siempre y hace imposible saber si el cliente
 * pidio vaciar el campo. Este helper filtra por presencia real de la propiedad.
 */
export function camposPresentes<T extends object, K extends keyof T>(
  dto: T,
  claves: readonly K[],
): Pick<T, K> {
  const salida: Partial<Pick<T, K>> = {};

  for (const clave of claves) {
    if (Object.prototype.hasOwnProperty.call(dto, clave) && dto[clave] !== undefined) {
      salida[clave] = dto[clave];
    }
  }

  return salida as Pick<T, K>;
}
