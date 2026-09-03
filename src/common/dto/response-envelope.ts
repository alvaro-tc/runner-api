import { ApiProperty } from '@nestjs/swagger';
import type { Request } from 'express';
import type { ErrorCode } from '../errors/error-codes';

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  /** Solo en listados paginados por cursor. */
  nextCursor?: string | null;
  /** Solo en listados paginados por pagina: sirven para pintar "1-20 de 340". */
  total?: number;
  page?: number;
  pageSize?: number;
}

/**
 * Marca una respuesta paginada.
 *
 * Un servicio que pagina devuelve `new Paginated(items, nextCursor)` y el
 * interceptor del sobre lo desarma: los items van a `data` y el cursor a
 * `meta.nextCursor`. La alternativa —que cada controlador arme el sobre a
 * mano— es como se acaba con tres formas distintas de decir "hay mas".
 */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly nextCursor: string | null,
    /**
     * Paginacion por pagina, la excepcion. Solo la usa el listado de usuarios
     * del panel, que necesita saltar de pagina y decir cuantos hay en total;
     * un cursor opaco no da ninguna de las dos cosas.
     */
    readonly total?: number,
    readonly page?: number,
    readonly pageSize?: number,
  ) {}
}

/** `req.id` lo pone pino-http; el fallback cubre contextos sin logger. */
export function buildMeta(req: Request): ResponseMeta {
  const { id } = req as Request & { id?: string | number };
  return {
    requestId: id === undefined ? '-' : String(id),
    timestamp: new Date().toISOString(),
  };
}

// ─── Solo para que Swagger documente la forma del sobre ────────────────────

export class ResponseMetaDto implements ResponseMeta {
  @ApiProperty({ example: 'c1f3a0d2-9b7e-4a11-8f2c-5d6e7a8b9c0d' })
  requestId!: string;

  @ApiProperty({
    example: '2026-08-18T14:03:22.118Z',
    description: 'Hora del servidor, ISO-8601 UTC',
  })
  timestamp!: string;

  @ApiProperty({ required: false, nullable: true, description: 'Cursor de la pagina siguiente' })
  nextCursor?: string | null;

  @ApiProperty({
    required: false,
    description: 'Filas que cumplen el filtro, no las de esta pagina',
  })
  total?: number;

  @ApiProperty({ required: false })
  page?: number;

  @ApiProperty({ required: false })
  pageSize?: number;
}

export class ApiErrorDto {
  @ApiProperty({
    example: 'VALIDATION_ERROR',
    description: 'Codigo estable; mapea por este campo, no por el mensaje',
  })
  code!: ErrorCode;

  @ApiProperty({ example: 'El campo email no es valido' })
  message!: string;

  @ApiProperty({ type: [Object], example: [] })
  details!: unknown[];
}

export class ErrorResponseDto {
  @ApiProperty({ type: ApiErrorDto })
  error!: ApiErrorDto;

  @ApiProperty({ type: ResponseMetaDto })
  meta!: ResponseMetaDto;
}
