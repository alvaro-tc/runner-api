/**
 * Dorsales: prefijo derivado del nombre de la carrera + correlativo.
 *
 * `MLP-0001` para "Maraton La Paz 3600". El prefijo es cosmetico —lo que
 * garantiza unicidad es el constraint `(marathonId, bibNumber)`— pero un dorsal
 * legible sirve en la mesa de acreditacion y en la foto de llegada.
 */

const LARGO_PREFIJO = 3;
const DIGITOS = 4;
const PREFIJO_POR_DEFECTO = 'RUN';

/**
 * Conectores que no aportan a un prefijo de tres letras.
 *
 * La lista es corta a proposito. Una version anterior filtraba tambien "la", y
 * "Maraton **La** Paz" perdia justo la letra que hace reconocible el dorsal: el
 * articulo de un nombre propio no es un articulo.
 */
const CONECTORES = new Set(['de', 'del', 'y']);

/** Marcas diacriticas, para sacar tildes despues de normalizar en NFD. */
const DIACRITICOS = /[̀-ͯ]/g;

/**
 * Iniciales de las palabras del nombre, en mayusculas.
 *
 * "Maraton La Paz 3600" → `MLP`. Si las iniciales no llegan a tres letras se
 * usan las primeras de la primera palabra ("Nocturna" → `NOC`); si el nombre no
 * tiene ni una letra, cae a `RUN`.
 */
export function prefijoDorsal(nombreMaraton: string): string {
  const palabras = nombreMaraton
    .normalize('NFD')
    // Sin tildes: un dorsal acentuado da problemas en cada sistema por el que
    // pase despues (impresion, exportacion a CSV, lector de chip).
    .replace(DIACRITICOS, '')
    .split(/[^A-Za-z]+/)
    .filter((p) => p.length > 0 && !CONECTORES.has(p.toLowerCase()));

  if (palabras.length === 0) return PREFIJO_POR_DEFECTO;

  const iniciales = palabras.map((p) => p[0]!).join('');
  const candidato = iniciales.length >= LARGO_PREFIJO ? iniciales : palabras[0]!;

  return candidato.slice(0, LARGO_PREFIJO).toUpperCase().padEnd(LARGO_PREFIJO, 'X');
}

/**
 * Arma el dorsal numero `correlativo` (base 1) de esa maraton.
 *
 * Mas alla de 9999 el numero simplemente crece y el dorsal queda de cinco
 * digitos: es preferible un dorsal feo a una carrera que no deja inscribir a
 * nadie mas.
 */
export function armarDorsal(nombreMaraton: string, correlativo: number): string {
  return `${prefijoDorsal(nombreMaraton)}-${String(correlativo).padStart(DIGITOS, '0')}`;
}
