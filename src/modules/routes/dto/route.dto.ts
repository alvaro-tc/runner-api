import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

// ─── Entrada ───────────────────────────────────────────────────────────────

export class ListRoutesQueryDto {
  @ApiPropertyOptional({ example: 'La Paz', description: 'Coincidencia parcial' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @trim()
  city?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Incluye los archivados. Solo sirve para el panel: la app nunca ofrece un recorrido ' +
      'retirado para una carrera nueva.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includeArchived?: boolean;
}

export class RouteFieldsDto {
  @ApiPropertyOptional({ example: 'Circuito Zona Sur' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  @trim()
  name?: string;

  @ApiPropertyOptional({ example: 'Sale de la plaza y sube por la avenida principal.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @trim()
  description?: string;

  @ApiPropertyOptional({ example: 'La Paz' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @trim()
  city?: string;

  @ApiPropertyOptional({ example: 'BO' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiPropertyOptional({
    example: {
      type: 'LineString',
      coordinates: [
        [-68.13, -16.5],
        [-68.12, -16.51],
      ],
    },
    description:
      '`LineString` GeoJSON, **`[lng, lat]`**. La distancia NO se manda: se mide sobre esta ' +
      'geometria, porque un numero escrito a mano que no cuadre con el trazado deja una ' +
      'carrera cuyo mapa no llega a la meta.',
  })
  @IsOptional()
  @IsObject()
  geoJson?: unknown;

  @ApiPropertyOptional({ example: 320, description: 'Desnivel positivo acumulado, en metros' })
  @IsOptional()
  @IsInt()
  @Min(0)
  elevationGainMeters?: number;
}

export class CreateRouteDto extends RouteFieldsDto {
  @ApiProperty({ example: 'Circuito Zona Sur' })
  @IsString()
  @MaxLength(140)
  @trim()
  declare name: string;

  @ApiProperty({ example: 'La Paz' })
  @IsString()
  @MaxLength(120)
  @trim()
  declare city: string;

  @ApiProperty({
    example: {
      type: 'LineString',
      coordinates: [
        [-68.13, -16.5],
        [-68.12, -16.51],
      ],
    },
  })
  @IsObject()
  declare geoJson: unknown;

  @ApiPropertyOptional({ description: 'Se deriva del nombre si no viene' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  @trim()
  slug?: string;
}

export class UpdateRouteDto extends RouteFieldsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(140)
  @trim()
  slug?: string;

  @ApiPropertyOptional({
    description: 'Archiva o desarchiva. Un recorrido archivado no se ofrece para carreras nuevas.',
  })
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class RouteSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'circuito-zona-sur' })
  slug!: string;

  @ApiProperty({ example: 'Circuito Zona Sur' })
  name!: string;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ example: 'La Paz' })
  city!: string;

  @ApiProperty({ example: 'BO' })
  country!: string;

  @ApiProperty({ example: 10_000, description: 'Medido sobre la geometria' })
  distanceMeters!: number;

  @ApiProperty({ example: -16.5 })
  startLat!: number;

  @ApiProperty({ example: -68.13 })
  startLng!: number;

  @ApiProperty({ nullable: true, example: 320 })
  elevationGainMeters!: number | null;

  @ApiProperty({ example: false })
  archived!: boolean;
}

export class RouteDetailDto extends RouteSummaryDto {
  @ApiProperty({
    description: '`LineString` GeoJSON ya simplificado para dibujar en el movil',
    example: {
      type: 'LineString',
      coordinates: [
        [-68.13, -16.5],
        [-68.12, -16.51],
      ],
    },
  })
  geoJson!: unknown;
}

/** Query de `GET /routes/:id`, para pedir la geometria sin simplificar. */
export class RouteDetailQueryDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Devuelve la geometria tal como se cargo, sin simplificar. Para el panel.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  full?: boolean;
}
