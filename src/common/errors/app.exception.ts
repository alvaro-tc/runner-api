import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './error-codes';

/**
 * Excepcion de dominio: siempre lleva un `code` del catalogo.
 *
 * Se lanza desde los servicios (`throw new AppException(ErrorCode.MARATHON_FULL,
 * 'No quedan cupos', HttpStatus.CONFLICT)`) y el filtro global la convierte en
 * el sobre de error de la API.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details: unknown[] = [],
  ) {
    super({ code, message, details }, status);
  }
}
