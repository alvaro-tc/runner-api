import { HttpStatus } from '@nestjs/common';
import { AppException } from './errors/app.exception';
import { ErrorCode } from './errors/error-codes';

/** Limites de la cabecera `Idempotency-Key`. Un uuid entra de sobra. */
const MINIMO = 8;
const MAXIMO = 128;

/**
 * Exige la cabecera `Idempotency-Key` en las operaciones que no se pueden
 * repetir a la ligera: cobrar y subir el historial offline.
 *
 * Se exige, no se genera: una clave que inventa el servidor cambia en cada
 * request y no protege de nada. Tiene que venir del cliente y sobrevivir a sus
 * propios reintentos.
 */
export function exigirClaveDeIdempotencia(clave: string): void {
  if (!clave || clave.trim().length < MINIMO || clave.length > MAXIMO) {
    throw new AppException(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      `Falta la cabecera Idempotency-Key (entre ${MINIMO} y ${MAXIMO} caracteres)`,
      HttpStatus.BAD_REQUEST,
    );
  }
}
