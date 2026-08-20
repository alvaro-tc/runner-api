/**
 * Formato de moneda boliviana para el comprobante.
 *
 * Se escribe a mano y no con `Intl.NumberFormat` a proposito: el resultado de
 * `Intl` depende de los datos ICU que traiga el binario de Node, y un VPS con
 * `small-icu` devolveria `Bs 1,234.56` en vez de `Bs 1.234,56`. Un comprobante
 * que cambia de formato segun donde corra el proceso no es un comprobante.
 */

/** `1234567` centavos → `"Bs 12.345,67"`. */
export function formatearBs(centavos: number): string {
  return `Bs ${formatearMonto(centavos)}`;
}

/** Igual, pero sin el simbolo: para las columnas de una tabla. */
export function formatearMonto(centavos: number): string {
  const negativo = centavos < 0;
  const absoluto = Math.abs(Math.round(centavos));

  const entero = Math.floor(absoluto / 100);
  const decimales = String(absoluto % 100).padStart(2, '0');

  return `${negativo ? '-' : ''}${conSeparadorDeMiles(entero)},${decimales}`;
}

function conSeparadorDeMiles(entero: number): string {
  return String(entero).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `2026-08-19T15:04:00Z` → `"19/08/2026 11:04"` en la zona indicada. */
export function formatearFecha(fecha: Date, zona: string): string {
  const partes = new Intl.DateTimeFormat('es-BO', {
    timeZone: zona,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);

  const buscar = (tipo: Intl.DateTimeFormatPartTypes) =>
    partes.find((p) => p.type === tipo)?.value ?? '';

  // Se arma parte a parte en vez de usar `format()` porque el separador que
  // mete cada version de ICU entre fecha y hora varia (coma, "a las", espacio
  // fino). Aqui el separador lo ponemos nosotros.
  return `${buscar('day')}/${buscar('month')}/${buscar('year')} ${buscar('hour')}:${buscar('minute')}`;
}
