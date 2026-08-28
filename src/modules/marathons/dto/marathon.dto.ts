import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Gender, MarathonRegistrationStatus } from '../../../../generated/prisma/enums';

/** Tope duro de pagina. Mas alto solo sirve para que alguien se baje el catalogo entero. */
export const LIMITE_MAXIMO = 50;
export const LIMITE_POR_DEFECTO = 20;

// ─── Entrada ───────────────────────────────────────────────────────────────

export class ListMarathonsQueryDto {
  @ApiPropertyOptional({
    example: 'La Paz',
    description: 'Coincidencia parcial, sin acentos ni mayusculas',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  city?: string;

  @ApiPropertyOptional({ example: '2026-09-01', description: 'Largada desde (ISO). Inclusivo' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'Largada hasta (ISO). Inclusivo' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    enum: MarathonRegistrationStatus,
    description:
      'Filtra por el estado YA RESUELTO. Como se deriva al leer, el filtrado se hace despues ' +
      'de traer las filas: por eso no se combina con paginas enormes.',
  })
  @IsOptional()
  @IsEnum(MarathonRegistrationStatus)
  status?: MarathonRegistrationStatus;

  @ApiPropertyOptional({ default: LIMITE_POR_DEFECTO, maximum: LIMITE_MAXIMO })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO)
  limit?: number;

  @ApiPropertyOptional({ description: 'El `meta.nextCursor` de la pagina anterior. Opaco.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class UpcomingQueryDto {
  @ApiPropertyOptional({ default: 5, maximum: LIMITE_MAXIMO })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO)
  limit?: number;
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class MarathonSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'maraton-la-paz-3600' })
  slug!: string;

  @ApiProperty({ example: 'Maraton La Paz 3600' })
  name!: string;

  @ApiProperty({ description: 'ISO-8601 UTC. La cuenta regresiva la calcula el cliente' })
  startsAt!: string;

  @ApiProperty({ example: 'America/La_Paz', description: 'Zona IANA para mostrar la hora local' })
  timezone!: string;

  @ApiProperty({ example: 'La Paz' })
  city!: string;

  @ApiProperty({ example: 'BO' })
  country!: string;

  @ApiProperty({ example: 42195, description: 'Metros' })
  distanceMeters!: number;

  @ApiProperty({ example: 25000, description: 'Centavos' })
  priceCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ nullable: true })
  coverUrl!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'TEMPORAL — QR de cobro del organizador. `null` = esta carrera no admite el metodo ' +
      '`qr_manual`, asi que la app no debe ofrecerlo. Ver `docs/pago-qr-manual.md`.',
  })
  paymentQrUrl!: string | null;

  @ApiProperty({ nullable: true, description: 'TEMPORAL — instrucciones junto al QR.' })
  paymentQrInstructions!: string | null;

  @ApiProperty({
    nullable: true,
    example: '00020101021226...5802BO6304A1B2',
    description:
      'TEMPORAL — contenido del QR **como texto**, para que la app lo dibuje ella misma. ' +
      '`null` = esta carrera no admite `qr_manual`. Ver `docs/pago-qr-manual.md`.',
  })
  paymentQrPayload!: string | null;

  @ApiProperty({ enum: MarathonRegistrationStatus, description: 'Derivado al leer' })
  registrationStatus!: MarathonRegistrationStatus;

  @ApiProperty()
  capacity!: number;

  @ApiProperty()
  slotsTaken!: number;

  @ApiProperty({ description: 'capacity - slotsTaken, nunca negativo' })
  slotsAvailable!: number;

  @ApiProperty({ nullable: true, description: 'Null = se cierra al largar' })
  registrationClosesAt!: string | null;
}

export class MarathonCategoryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Elite masculino' })
  name!: string;

  @ApiProperty({ nullable: true, example: 18 })
  minAge!: number | null;

  @ApiProperty({ nullable: true, example: 39 })
  maxAge!: number | null;

  @ApiProperty({ enum: Gender, nullable: true, description: 'Null = abierta a cualquier genero' })
  gender!: Gender | null;

  @ApiProperty({ example: 0, description: 'Recargo sobre el precio base, en centavos' })
  extraPriceCents!: number;
}

export class MarathonExtraDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Remera tecnica' })
  name!: string;

  @ApiProperty({ example: 12000 })
  priceCents!: number;

  @ApiProperty({ nullable: true, description: 'Null = sin limite de stock' })
  stock!: number | null;

  @ApiProperty({ description: 'False cuando stock llego a 0' })
  available!: boolean;
}

export class MarathonDetailDto extends MarathonSummaryDto {
  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ nullable: true })
  lat!: number | null;

  @ApiProperty({ nullable: true })
  lng!: number | null;

  @ApiProperty({ nullable: true, description: 'Recorrido en GeoJSON' })
  routeGeoJson!: unknown;

  @ApiProperty({ example: [{ time: '06:00', title: 'Acreditacion' }] })
  schedule!: unknown;

  @ApiProperty({ example: ['remera', 'medalla', 'hidratacion'] })
  includes!: unknown;

  @ApiProperty({ nullable: true, example: { from: '...', to: '...', address: 'Av. Arce 123' } })
  kitPickup!: unknown;

  @ApiProperty({ type: [MarathonCategoryDto] })
  categories!: MarathonCategoryDto[];

  @ApiProperty({ type: [MarathonExtraDto] })
  extras!: MarathonExtraDto[];
}
