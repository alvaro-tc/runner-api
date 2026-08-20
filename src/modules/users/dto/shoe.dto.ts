import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** 800 km: el rango habitual de vida util de una zapatilla de entrenamiento. */
export const UMBRAL_DESGASTE_POR_DEFECTO_METROS = 800_000;

export class CreateShoeDto {
  @ApiProperty({ example: 'Asics' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @trim()
  brand!: string;

  @ApiProperty({ example: 'Gel-Nimbus 26' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @trim()
  model!: string;

  @ApiPropertyOptional({
    example: 120000,
    description: 'Kilometraje ya recorrido antes de registrarla en la app. En metros.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  distanceMeters?: number;

  @ApiPropertyOptional({ example: UMBRAL_DESGASTE_POR_DEFECTO_METROS })
  @IsOptional()
  @IsInt()
  @Min(50_000)
  @Max(100_000_000)
  alertThresholdMeters?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'La principal es la que suma kilometros al consolidar un entrenamiento.',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateShoeDto {
  @ApiPropertyOptional({ example: 'Asics' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @trim()
  brand?: string;

  @ApiPropertyOptional({ example: 'Gel-Nimbus 26' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @trim()
  model?: string;

  @ApiPropertyOptional({ example: 250000, description: 'Correccion manual del kilometraje' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  distanceMeters?: number;

  @ApiPropertyOptional({ example: UMBRAL_DESGASTE_POR_DEFECTO_METROS })
  @IsOptional()
  @IsInt()
  @Min(50_000)
  @Max(100_000_000)
  alertThresholdMeters?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({
    description: 'true la retira (deja de ser principal). false la vuelve a poner en uso.',
  })
  @IsOptional()
  @IsBoolean()
  retired?: boolean;
}

export class ShoeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  brand!: string;

  @ApiProperty()
  model!: string;

  @ApiProperty({ example: 245300 })
  distanceMeters!: number;

  @ApiProperty({ example: UMBRAL_DESGASTE_POR_DEFECTO_METROS })
  alertThresholdMeters!: number;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty({ nullable: true })
  retiredAt!: string | null;

  @ApiProperty({
    example: 0.31,
    description: 'distanceMeters / alertThresholdMeters, redondeado a 2 decimales.',
  })
  wearRatio!: number;

  @ApiProperty({ description: 'true cuando ya paso el umbral: toca sugerir el cambio.' })
  wearAlert!: boolean;

  @ApiProperty()
  createdAt!: string;
}
