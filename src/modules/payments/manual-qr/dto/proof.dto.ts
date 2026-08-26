import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaymentProofStatus } from '../../../../../generated/prisma/enums';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

// --- Entrada -----------------------------------------------------------------

/**
 * TEMPORAL — lo que acompana a la imagen del comprobante.
 * Ver `docs/pago-qr-manual.md`.
 */
export class UploadProofDto {
  @ApiPropertyOptional({
    example: '00123456789',
    description:
      'Numero de transaccion que devolvio el banco. Es lo que le permite al organizador ' +
      'cuadrarlo contra su extracto sin abrir la imagen.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @trim()
  reference?: string;
}

/** Motivo del rechazo. Obligatorio: un rechazo sin motivo no se puede corregir. */
export class RejectProofDto {
  @ApiProperty({ example: 'La captura es de otra transferencia' })
  @IsString()
  @IsNotEmpty({ message: 'Hace falta decir por que se rechaza' })
  @MaxLength(300)
  @trim()
  note!: string;
}

export class ApproveProofDto {
  @ApiPropertyOptional({ description: 'Nota interna opcional del organizador' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @trim()
  note?: string;
}

// --- Salida ------------------------------------------------------------------

export class ProofDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  paymentId!: string;

  @ApiProperty({
    enum: PaymentProofStatus,
    description:
      '`in_review` = subido y esperando al organizador; el cobro sigue `pending`. ' +
      '`approved` = el cobro paso a `paid` y la inscripcion quedo confirmada. ' +
      '`rejected` = hay que subir otro; el cobro sigue `pending`.',
  })
  status!: PaymentProofStatus;

  @ApiProperty({ description: 'URL publica de la imagen ya procesada (WebP, sin EXIF)' })
  imageUrl!: string;

  @ApiProperty({ nullable: true })
  reference!: string | null;

  @ApiProperty({ nullable: true, description: 'Motivo del rechazo o nota del organizador' })
  note!: string | null;

  @ApiProperty({ nullable: true })
  reviewedAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}

/** Una fila de la cola de revision del panel. */
export class PendingProofDto extends ProofDto {
  @ApiProperty({ example: 20000 })
  amountCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty()
  registrationId!: string;

  @ApiProperty({ example: 'Maraton de La Paz' })
  marathon!: string;

  @ApiProperty({ example: 'Alvaro Quispe' })
  runner!: string;

  @ApiProperty({ nullable: true, example: '1234567LP' })
  runnerCi!: string | null;

  @ApiProperty({ nullable: true })
  runnerEmail!: string | null;
}
