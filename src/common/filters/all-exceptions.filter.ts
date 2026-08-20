import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { buildMeta } from '../dto/response-envelope';

/** Mapeo por defecto de status HTTP a codigo, para excepciones de Nest. */
const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.FILE_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ErrorCode.INVALID_IMAGE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

interface NormalizedError {
  status: number;
  code: ErrorCode;
  message: string;
  details: unknown[];
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const { status, code, message, details } = this.normalize(exception);

    // 5xx es un fallo nuestro: se loguea entero. 4xx es culpa del cliente y
    // solo deja una linea, para no llenar los logs de ruido.
    if (status >= 500) {
      this.logger.error(
        { err: exception, path: req.url, method: req.method },
        `${code}: ${message}`,
      );
    } else {
      this.logger.debug(`${status} ${code} ${req.method} ${req.url}`);
    }

    res.status(status).json({ error: { code, message, details }, meta: buildMeta(req) });
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // El ValidationPipe devuelve `{ message: string[] }`: cada string es un
      // fallo de un campo, y va a `details` para que el cliente los liste.
      if (typeof body === 'object' && body !== null) {
        const raw = body as {
          message?: unknown;
          error?: unknown;
          code?: unknown;
          details?: unknown;
        };
        const messages = Array.isArray(raw.message) ? (raw.message as unknown[]) : [];
        // Un `details` explicito (lo que lanza el codigo nuestro) manda sobre la
        // lista del ValidationPipe; si no, se usan los mensajes de campo.
        const details = Array.isArray(raw.details) ? (raw.details as unknown[]) : messages;
        return {
          status,
          code:
            typeof raw.code === 'string'
              ? (raw.code as ErrorCode)
              : (STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL_ERROR),
          message: messages.length
            ? 'La peticion no paso la validacion'
            : typeof raw.message === 'string'
              ? raw.message
              : exception.message,
          details,
        };
      }

      return {
        status,
        code: STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL_ERROR,
        message: typeof body === 'string' ? body : exception.message,
        details: [],
      };
    }

    // Cualquier otra cosa es un bug: al cliente le llega un mensaje generico,
    // el detalle real queda en los logs con su requestId.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Ocurrio un error inesperado',
      details: [],
    };
  }
}
