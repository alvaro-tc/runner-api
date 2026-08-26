import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Tope de puntos por lote.
 *
 * A 1 Hz, 30 s de carrera son 30 puntos: 1000 deja sitio de sobra para un lote
 * atrasado que se drena de golpe al recuperar la senal, y acota lo que puede
 * llegar en un solo request.
 */
export const MAX_PUNTOS_POR_LOTE = 1000;

/**
 * Un punto de GPS tal como lo manda el cliente.
 *
 * Vive aqui, en tracking, porque es la moneda de la ingesta; la
 * sincronizacion offline de `workouts` lo reutiliza para no tener dos
 * definiciones del mismo punto que se separen en la primera revision.
 */
export class PositionPointDto {
  @ApiProperty({
    example: '3f1c1b6e-1',
    description:
      'Identificador que pone el cliente a cada punto. Es lo que hace seguro reenviar un lote: ' +
      'los repetidos se ignoran en vez de duplicarse.',
  })
  @IsString()
  @MaxLength(80)
  clientPointId!: string;

  @ApiProperty({ description: 'Hora del reloj del dispositivo, ISO-8601' })
  @IsISO8601()
  recordedAt!: string;

  @ApiProperty({ example: -16.4957 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -68.1335 })
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({ example: 3625, description: 'Metros sobre el nivel del mar' })
  @IsOptional()
  @IsNumber()
  altitude?: number;

  @ApiPropertyOptional({ example: 3.4, description: 'm/s segun el dispositivo' })
  @IsOptional()
  @IsNumber()
  speed?: number;

  @ApiPropertyOptional({ example: 8, description: 'Error estimado en metros' })
  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @ApiPropertyOptional({ example: 187 })
  @IsOptional()
  @IsNumber()
  heading?: number;

  @ApiPropertyOptional({ example: 74, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  battery?: number;
}

export class IngestPositionsDto {
  @ApiProperty({
    type: [PositionPointDto],
    maxItems: MAX_PUNTOS_POR_LOTE,
    description: 'Los puntos de los ultimos 15-30 s. **Lotes, nunca punto por punto.**',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PUNTOS_POR_LOTE)
  @ValidateNested({ each: true })
  @Type(() => PositionPointDto)
  points!: PositionPointDto[];
}

export class IngestResultDto {
  @ApiProperty({ example: 28, description: 'Puntos guardados' })
  accepted!: number;

  @ApiProperty({
    example: 2,
    description: 'Ya estaban (mismo `clientPointId`). No es un error: el reintento funciono.',
  })
  duplicated!: number;

  @ApiProperty({
    example: 0,
    description: 'Descartados por fecha imposible o coordenada invalida. Ver `reasons`.',
  })
  rejected!: number;

  @ApiProperty({
    example: { future: 0, before_session: 1, invalid_coordinates: 0 },
    description: 'Por que se descarto cada uno. Un numero alto aqui es un sintoma del cliente.',
  })
  reasons!: Record<string, number>;
}

/**
 * Parametros del protocolo OsmAnd, tal como los manda Traccar Client.
 *
 * Llegan siempre por query string —tambien en el POST— porque asi los manda el
 * cliente. Todo es texto: no hay `@Type(() => Number)` porque los nombres son
 * ajenos y prefiero parsear en la fuente antes que confiar en la coercion.
 */
export class OsmAndQueryDto {
  @ApiProperty({ description: 'El `uniqueId` del dispositivo. Aqui hace de credencial.' })
  @IsString()
  @MaxLength(120)
  id!: string;

  @ApiProperty({ example: '-16.4957' })
  @IsString()
  lat!: string;

  @ApiProperty({ example: '-68.1335', description: 'Se llama `lon`, no `lng`: es el protocolo.' })
  @IsString()
  lon!: string;

  @ApiPropertyOptional({
    description:
      'Unix en segundos o en milisegundos, o ISO-8601. Si falta, se usa la hora del servidor.',
  })
  @IsOptional()
  @IsString()
  timestamp?: string;

  @ApiPropertyOptional({
    description: 'Se guarda tal cual, asumiendo m/s. Ver `docs/tracking.md`.',
  })
  @IsOptional()
  @IsString()
  speed?: string;

  @ApiPropertyOptional({ description: 'Rumbo en grados.' })
  @IsOptional()
  @IsString()
  bearing?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  altitude?: string;

  @ApiPropertyOptional({ description: 'Error estimado en metros.' })
  @IsOptional()
  @IsString()
  accuracy?: string;

  @ApiPropertyOptional({ description: 'Bateria en porcentaje.' })
  @IsOptional()
  @IsString()
  batt?: string;
}

/**
 * Un track para reproducir. Solo fuera de produccion.
 *
 * Las coordenadas van en orden GeoJSON —`[lng, lat]`, longitud primero— para
 * poder pegar un `LineString` de geojson.io sin darle la vuelta a nada.
 */
export class SimulateDto {
  @ApiProperty({
    example: [
      [-68.1335, -16.4957],
      [-68.1336, -16.4958],
    ],
    description: 'Pares `[lng, lat]`, como en un `LineString` de GeoJSON.',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_PUNTOS_POR_LOTE)
  coordinates!: [number, number][];

  @ApiPropertyOptional({ default: 1, description: 'Segundos entre punto y punto.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  intervalSeconds?: number;
}
