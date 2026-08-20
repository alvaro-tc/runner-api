import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma HMAC de los webhooks, con el mismo formato que usa un PSP real.
 *
 * La cabecera se ve asi:
 *
 * ```
 * X-Paceup-Signature: t=1755600000,v1=9f86d081884c7d65...
 * ```
 *
 * y lo que se firma es `${t}.${cuerpo crudo}`. Los tres detalles que importan,
 * y que son los que la gente se salta:
 *
 * 1. **Se firma el cuerpo crudo**, byte a byte, no el objeto reserializado.
 *    `JSON.stringify(JSON.parse(x))` no devuelve `x`: cambia el orden de las
 *    claves, los espacios y los escapes, y la firma deja de cuadrar.
 * 2. **La marca de tiempo entra en la firma.** Sin ella, quien capture un
 *    webhook valido puede reenviarlo indefinidamente: la firma sigue siendo
 *    correcta porque el cuerpo no cambio.
 * 3. **La comparacion es en tiempo constante.** Un `===` sobre el digest filtra,
 *    por lo que tarda en fallar, cuantos bytes iniciales acerto quien prueba:
 *    con suficientes intentos se reconstruye la firma byte a byte.
 */

/** Nombre de la cabecera. Con prefijo propio, como hacen todos los PSP. */
export const CABECERA_DE_FIRMA = 'x-paceup-signature';

export interface FirmaDeWebhook {
  /** Segundos desde epoch en los que se firmo. */
  timestamp: number;
  /** Digest hexadecimal del esquema `v1`. */
  v1: string;
}

/** Arma la cabecera. La usan el emisor mock y los tests. */
export function firmar(cuerpo: string, secreto: string, ahora = new Date()): string {
  const timestamp = Math.floor(ahora.getTime() / 1000);

  return `t=${timestamp},v1=${digest(timestamp, cuerpo, secreto)}`;
}

/**
 * Descompone la cabecera. Devuelve `null` si no tiene la forma esperada, sin
 * intentar adivinar: una cabecera malformada es una peticion invalida.
 */
export function parsearFirma(cabecera: string | undefined): FirmaDeWebhook | null {
  if (!cabecera) return null;

  const partes = new Map<string, string>();

  for (const trozo of cabecera.split(',')) {
    const separador = trozo.indexOf('=');
    if (separador <= 0) continue;

    partes.set(trozo.slice(0, separador).trim(), trozo.slice(separador + 1).trim());
  }

  const t = Number(partes.get('t'));
  const v1 = partes.get('v1');

  if (!Number.isInteger(t) || t <= 0 || !v1) return null;

  return { timestamp: t, v1 };
}

export const ResultadoDeVerificacion = {
  ok: 'ok',
  /** Falta la cabecera o no tiene la forma `t=...,v1=...`. */
  malformed: 'malformed',
  /** La firma no cuadra con el cuerpo recibido. */
  mismatch: 'mismatch',
  /** La firma es correcta pero llego demasiado tarde (o demasiado pronto). */
  stale: 'stale',
} as const;

export type ResultadoDeVerificacion =
  (typeof ResultadoDeVerificacion)[keyof typeof ResultadoDeVerificacion];

export interface OpcionesDeVerificacion {
  cabecera: string | undefined;
  cuerpo: string;
  secreto: string;
  /** Ventana de tolerancia, en segundos, a ambos lados del reloj. */
  toleranciaSegundos: number;
  ahora?: Date;
}

/**
 * Verifica la firma.
 *
 * El orden es deliberado: primero la firma y despues la frescura. Al reves, la
 * respuesta distinguiria "firma valida pero vieja" de "firma invalida" para
 * quien no conoce el secreto, que es informacion que no hay por que regalar.
 */
export function verificar(opciones: OpcionesDeVerificacion): ResultadoDeVerificacion {
  const firma = parsearFirma(opciones.cabecera);

  if (!firma) return ResultadoDeVerificacion.malformed;

  const esperado = digest(firma.timestamp, opciones.cuerpo, opciones.secreto);

  if (!igualesEnTiempoConstante(esperado, firma.v1)) {
    return ResultadoDeVerificacion.mismatch;
  }

  const ahora = Math.floor((opciones.ahora ?? new Date()).getTime() / 1000);

  return Math.abs(ahora - firma.timestamp) <= opciones.toleranciaSegundos
    ? ResultadoDeVerificacion.ok
    : ResultadoDeVerificacion.stale;
}

function digest(timestamp: number, cuerpo: string, secreto: string): string {
  return createHmac('sha256', secreto).update(`${timestamp}.${cuerpo}`).digest('hex');
}

/**
 * Comparacion en tiempo constante.
 *
 * `timingSafeEqual` exige longitudes iguales y revienta si no lo son, asi que
 * se comprueba antes. Esa comprobacion no filtra nada util: la longitud del
 * digest es publica y siempre la misma.
 */
function igualesEnTiempoConstante(a: string, b: string): boolean {
  const uno = Buffer.from(a, 'utf8');
  const dos = Buffer.from(b, 'utf8');

  return uno.length === dos.length && timingSafeEqual(uno, dos);
}
