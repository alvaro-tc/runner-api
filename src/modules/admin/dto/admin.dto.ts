import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ServiceFeeType } from '../../../../generated/prisma/enums';

// ─── Cargo por servicio ────────────────────────────────────────────────────

export class ServiceFeeConfigDto {
  @ApiProperty({
    description:
      'Interruptor maestro. En `false` el total no lleva cargo **y la línea no se muestra**: ' +
      'un "Bs 0,00" le promete al usuario un cargo que hoy no se le cobra.',
  })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ enum: ServiceFeeType, example: 'percent' })
  @IsEnum(ServiceFeeType)
  type!: ServiceFeeType;

  @ApiPropertyOptional({ example: 1000, description: 'Puntos básicos: 1000 = 10%' })
  @IsOptional()
  @IsInt()
  @Min(0)
  percentBps?: number | null;

  @ApiPropertyOptional({ example: 500, description: 'Parte fija, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  fixedCents?: number | null;

  @ApiPropertyOptional({ example: 500, description: 'Suelo del cargo, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minCents?: number | null;

  @ApiPropertyOptional({ example: 5000, description: 'Techo del cargo, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxCents?: number | null;

  @ApiPropertyOptional({ example: 'Cargo por servicio' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class FeePreviewQueryDto {
  @ApiPropertyOptional({ example: 20_000, description: 'Subtotal de ejemplo, en centavos' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  subtotalCents?: number;

  @ApiPropertyOptional({ description: 'Sin esto se previsualiza la config global' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  marathonId?: string;
}

// ─── Resultados de carrera ─────────────────────────────────────────────────

export class RaceResultRowDto {
  @ApiProperty({ example: 'MLP-0042', description: 'Dorsal, que es como llegan los tiempos' })
  @IsString()
  @MaxLength(40)
  bibNumber!: string;

  @ApiProperty({ example: 13_140, description: 'Tiempo oficial desde la largada, en segundos' })
  @IsInt()
  @Min(1)
  finishTimeSeconds!: number;

  @ApiPropertyOptional({ example: 13_020, description: 'Tiempo de chip, si hubo cronometraje' })
  @IsOptional()
  @IsInt()
  @Min(1)
  chipTimeSeconds?: number;

  @ApiPropertyOptional({ example: 42_195, description: 'Por defecto, la distancia de la maratón' })
  @IsOptional()
  @IsInt()
  @Min(1)
  distanceMeters?: number;

  @ApiPropertyOptional({ description: 'Hora de llegada. Por defecto, largada + tiempo oficial' })
  @IsOptional()
  @IsISO8601()
  finishedAt?: string;
}

export class ImportResultsDto {
  @ApiProperty({ type: [RaceResultRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RaceResultRowDto)
  results!: RaceResultRowDto[];
}

// ─── Pago por transferencia ────────────────────────────────────────────────

export class ConfirmTransferDto {
  @ApiPropertyOptional({
    example: 'BNB-88213',
    description: 'Referencia del comprobante bancario. Queda en `methodDetails`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

// ─── Salidas ───────────────────────────────────────────────────────────────

export class FeePreviewDto {
  @ApiProperty({ example: 20_000 })
  subtotalCents!: number;

  @ApiProperty({ nullable: true, example: 2000, description: 'null = no se cobra ni se pinta' })
  serviceFeeCents!: number | null;

  @ApiProperty({ nullable: true, example: 'Cargo por servicio' })
  serviceFeeLabel!: string | null;

  @ApiProperty({ example: 22_000 })
  totalCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ enum: ['global', 'marathon', 'none'], description: 'De dónde salió la config' })
  source!: string;
}

export class ImportResultsResponseDto {
  @ApiProperty({ example: 128 })
  imported!: number;

  @ApiProperty({ example: 2, description: 'Dorsales que no corresponden a ninguna inscripción' })
  skipped!: number;

  @ApiProperty({ type: [String], example: ['MLP-9999'] })
  unknownBibs!: string[];
}

export class AdminActionResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ description: 'Qué quedó, para que el panel repinte sin recargar' })
  data!: unknown;
}
