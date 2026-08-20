/**
 * Serializacion a CSV.
 *
 * Funcion pura y sin dependencia: un CSV son comas, comillas y saltos de linea,
 * y las tres reglas caben en veinte lineas. Traerse una libreria para esto
 * seria pagar un `node_modules` entero por un `join`.
 *
 * Lo que **no** es negociable es el escapado: un nombre con una coma —"Quispe,
 * Ana"— parte la fila en dos y desplaza todas las columnas siguientes sin que
 * nadie se entere hasta que el organizador imprime los dorsales mal.
 */

/** Valores que sabemos poner en una celda. `null` y `undefined` salen vacios. */
export type CeldaCsv = string | number | boolean | Date | null | undefined;

/**
 * Prefijos que Excel y Google Sheets interpretan como formula.
 *
 * Una celda que empieza por `=` se ejecuta al abrir el archivo. Es una
 * inyeccion de verdad —CSV injection— y el vector es un campo que rellena el
 * usuario: basta con llamarse `=HYPERLINK(...)` para que el organizador que
 * abre el listado de inscritos ejecute lo que le pongan.
 */
const PELIGROSOS = ['=', '+', '-', '@', '\t', '\r'];

function escapar(valor: CeldaCsv): string {
  if (valor === null || valor === undefined) return '';

  let texto = valor instanceof Date ? valor.toISOString() : String(valor);

  // Se antepone una comilla simple: la hoja de calculo la trata como texto y
  // el usuario ve su valor tal cual, sin ejecutarlo.
  if (PELIGROSOS.some((p) => texto.startsWith(p))) texto = `'${texto}`;

  return /[",\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/**
 * Arma el CSV con su cabecera.
 *
 * Se emite **BOM UTF-8** al principio: sin el, Excel en Windows abre el archivo
 * en la codificacion del sistema y "Cochabamba" sale con la tilde rota. Es un
 * detalle de tres bytes que decide si el organizador puede usar el archivo.
 */
export function aCsv<T>(
  filas: readonly T[],
  columnas: readonly { header: string; valor: (fila: T) => CeldaCsv }[],
): string {
  const lineas = [
    columnas.map((c) => escapar(c.header)).join(','),
    ...filas.map((fila) => columnas.map((c) => escapar(c.valor(fila))).join(',')),
  ];

  // El BOM va como escape y no como caracter literal: un byte invisible en el
  // codigo fuente es justo lo que nadie ve al revisar un diff.
  return `\ufeff${lineas.join('\r\n')}\r\n`;
}
