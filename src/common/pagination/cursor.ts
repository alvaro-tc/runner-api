/**
 * Paginacion por cursor (keyset), no por offset.
 *
 * Con `?page=3` una fila insertada mientras el usuario scrollea le hace ver un
 * elemento repetido o saltarse otro, y `OFFSET 10000` obliga a Postgres a
 * contar y tirar diez mil filas. El cursor apunta a "el ultimo que viste" y la
 * consulta sigue desde ahi: estable e igual de rapida en la pagina 1 que en la
 * 500.
 *
 * El cursor es **opaco a proposito**: el cliente lo recibe, lo devuelve tal
 * cual y no lo interpreta. Asi cambiar el criterio de orden no rompe clientes
 * viejos, solo invalida cursores en vuelo.
 */

/** Lo que viaja dentro del cursor: el valor de la clave de orden y el id. */
export interface CursorPayload {
  /** Valor de la columna por la que se ordena, ya serializado. */
  v: string;
  /** Desempate. Sin el, dos filas con el mismo valor se pierden o se repiten. */
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Devuelve `null` ante cualquier cosa que no sea un cursor nuestro.
 *
 * Un cursor invalido no es un error del que valga la pena avisar: casi siempre
 * es uno viejo pegado a mano o de una version anterior. Se empieza desde el
 * principio, que es lo que el usuario esperaria.
 */
export function decodeCursor(raw: string | undefined): CursorPayload | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as CursorPayload).v === 'string' &&
      typeof (parsed as CursorPayload).id === 'string'
    ) {
      return parsed as CursorPayload;
    }
  } catch {
    // Cae al return de abajo: JSON roto o base64 invalido.
  }

  return null;
}

/**
 * Condicion "estrictamente despues del cursor" para un orden ascendente por
 * `campo`, con el id como desempate.
 *
 * Es la comparacion lexicografica de la tupla `(campo, id)`, escrita como el OR
 * que entiende Prisma. Comparar solo por `campo` perderia filas cada vez que
 * dos comparten valor — y dos maratones el mismo dia no es un caso raro.
 */
export function despuesDe<T>(campo: string, valor: T, id: string): Record<string, unknown>[] {
  return [{ [campo]: { gt: valor } }, { [campo]: valor, id: { gt: id } }];
}

export interface Pagina<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Recorta a `limit` la lista y arma el cursor siguiente.
 *
 * Se consulta siempre `limit + 1` filas: si vuelve la extra, hay pagina
 * siguiente. Es una fila de mas contra un `COUNT(*)` entero por peticion.
 */
export function armarPagina<T>(
  filas: T[],
  limit: number,
  aCursor: (fila: T) => CursorPayload,
): Pagina<T> {
  const hayMas = filas.length > limit;
  const items = hayMas ? filas.slice(0, limit) : filas;
  const ultimo = items.at(-1);

  return {
    items,
    nextCursor: hayMas && ultimo ? encodeCursor(aCursor(ultimo)) : null,
  };
}

/**
 * La misma comparacion que `despuesDe`, para un orden **descendente**.
 *
 * El historial de entrenamientos se lee del mas reciente al mas viejo, asi que
 * "lo que sigue" es lo estrictamente menor. Es la mitad simetrica de la de
 * arriba y existe para no escribir el OR a mano en cada listado que baja.
 */
export function antesDe<T>(campo: string, valor: T, id: string): Record<string, unknown>[] {
  return [{ [campo]: { lt: valor } }, { [campo]: valor, id: { lt: id } }];
}
