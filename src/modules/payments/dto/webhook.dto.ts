import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Eventos que emite el proveedor.
 *
 * Los nombres imitan los de un PSP real (`recurso.accion`) para que migrar sea
 * mapear cadenas y no reescribir el manejador.
 */
export const EventoDeWebhook = {
  payment_paid: 'payment.paid',
  payment_failed: 'payment.failed',
  payment_refunded: 'payment.refunded',
} as const;

export type EventoDeWebhook = (typeof EventoDeWebhook)[keyof typeof EventoDeWebhook];

export const EVENTOS = Object.values(EventoDeWebhook);

export class WebhookDataDto {
  @ApiProperty({
    example: 'mock_pi_a1b2c3',
    description: 'Id del cobro del lado del proveedor. Es la unica forma de localizarlo.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  externalId!: string;

  @ApiPropertyOptional({
    example: 'card_declined',
    description: 'Solo en `payment.failed`. Codigo estable del motivo.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  failureReason?: string;
}

export class WebhookEventDto {
  @ApiProperty({ example: 'evt_a1b2c3', description: 'Id del evento del lado del proveedor' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  id!: string;

  @ApiProperty({ enum: EVENTOS, example: EventoDeWebhook.payment_paid })
  @IsIn(EVENTOS)
  type!: EventoDeWebhook;

  @ApiProperty({ example: '2026-08-19T15:04:00.000Z' })
  @IsISO8601()
  createdAt!: string;

  @ApiProperty({ type: WebhookDataDto })
  @ValidateNested()
  @Type(() => WebhookDataDto)
  data!: WebhookDataDto;
}

/**
 * Lo que se responde. Siempre 200 mientras la firma sea valida, aunque el
 * evento no se haya podido aplicar: un PSP que recibe un error reintenta, y
 * reintentar un evento que nunca vamos a poder procesar es un bucle.
 */
export class WebhookResultDto {
  @ApiProperty({ example: true })
  received!: boolean;

  @ApiProperty({ example: true, description: 'false = se acepto pero no cambio nada' })
  handled!: boolean;

  @ApiPropertyOptional({
    example: 'unknown_payment',
    description: 'Por que no se aplico: `unknown_payment`, `already_settled`, `duplicate`',
  })
  reason?: string;
}
