import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_CANTIDAD_POR_EXTRA } from '../quote.service';

/** Cuantos adicionales distintos se pueden pedir de una. */
const MAX_EXTRAS_DISTINTOS = 20;

export class QuoteExtraDto {
  @ApiProperty({ description: 'Id del extra, de GET /marathons/:id/extras' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  extraId!: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_CANTIDAD_POR_EXTRA })
  @IsInt()
  @Min(1)
  @Max(MAX_CANTIDAD_POR_EXTRA)
  quantity!: number;
}

export class QuoteRequestDto {
  @ApiProperty({ description: 'Id o slug de la maraton' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  marathonId!: string;

  @ApiPropertyOptional({ description: 'Id de la categoria elegida, si ya la eligio' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  categoryId?: string;

  @ApiPropertyOptional({ type: [QuoteExtraDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXTRAS_DISTINTOS)
  @ValidateNested({ each: true })
  @Type(() => QuoteExtraDto)
  extras?: QuoteExtraDto[];
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class QuoteLineDto {
  @ApiProperty({ enum: ['base', 'category', 'extra'] })
  type!: string;

  @ApiProperty({ nullable: true, description: 'Id de la categoria o del extra. Null en la base' })
  refId!: string | null;

  @ApiProperty({ example: 'Remera tecnica' })
  label!: string;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: 12000, description: 'Centavos' })
  unitPriceCents!: number;

  @ApiProperty({ example: 12000, description: 'unitPriceCents * quantity' })
  amountCents!: number;
}

export class ServiceFeeLineDto {
  @ApiProperty({ example: 'Cargo por servicio' })
  label!: string;

  @ApiProperty({ example: 2500 })
  amountCents!: number;
}

export class QuoteResponseDto {
  @ApiProperty()
  marathonId!: string;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ type: [QuoteLineDto] })
  items!: QuoteLineDto[];

  @ApiProperty({ example: 49000, description: 'Suma de los items, sin el cargo' })
  subtotalCents!: number;

  @ApiProperty({
    type: ServiceFeeLineDto,
    nullable: true,
    description:
      'null = no hay cargo. La UI **no debe pintar la linea**: un "Bs 0,00" anuncia un cargo ' +
      'que nadie quiso anunciar.',
  })
  serviceFee!: ServiceFeeLineDto | null;

  @ApiProperty({ example: 49000, description: 'subtotalCents + el cargo, si lo hay' })
  totalCents!: number;
}
