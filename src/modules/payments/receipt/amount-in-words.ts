const UNIDADES = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const DECENAS = [
  '',
  '',
  '',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const CENTENAS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

function apocopar(texto: string): string {
  return texto.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');
}

function entero(n: number): string {
  if (n < 30) return UNIDADES[n]!;
  if (n < 100) return DECENAS[Math.floor(n / 10)] + (n % 10 ? ` y ${entero(n % 10)}` : '');
  if (n === 100) return 'cien';
  if (n < 1000) return CENTENAS[Math.floor(n / 100)] + (n % 100 ? ` ${entero(n % 100)}` : '');
  if (n < 1_000_000)
    return (
      (n < 2000 ? 'mil' : `${apocopar(entero(Math.floor(n / 1000)))} mil`) +
      (n % 1000 ? ` ${entero(n % 1000)}` : '')
    );
  return (
    (n < 2_000_000 ? 'un millón' : `${apocopar(entero(Math.floor(n / 1_000_000)))} millones`) +
    (n % 1_000_000 ? ` ${entero(n % 1_000_000)}` : '')
  );
}

/** Centavos enteros, sin redondeo flotante ni conversion de moneda. */
export function montoLiteral(centavos: number): string {
  if (!Number.isSafeInteger(centavos) || centavos < 0 || centavos > 2_147_483_647) {
    throw new Error('Importe fuera del rango de un pago');
  }
  const letras = entero(Math.floor(centavos / 100));
  return `${letras.charAt(0).toUpperCase()}${letras.slice(1)} ${String(centavos % 100).padStart(2, '0')}/100`;
}
