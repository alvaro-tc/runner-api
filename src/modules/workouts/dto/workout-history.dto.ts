import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { WorkoutSource, WorkoutType } from '../../../../generated/prisma/enums';
import { PositionPointDto } from '../../tracking/dto/tracking.dto';

/** El punto de GPS es el mismo de la ingesta; se define una sola vez, en tracking. */
export { PositionPointDto };

export const LIMITE_MAXIMO = 50;
export const LIMITE_POR_DEFECTO = 20;

/** Semanas que devuelve `/workouts/stats/weekly` si no piden otra cosa. */
export const SEMANAS_POR_DEFECTO = 4;
export const SEMANAS_MAXIMAS = 26;

export const GRUPOS_POR_DEFECTO = 12;
export const GRUPOS_MAXIMOS = 52;

/**
 * Tope de entrenamientos por lote de sincronizacion.
 *
 * Un mes entero sin red son ~20 entrenamientos: 50 sobra. El tope existe para
 * que un cliente con un bug en la cola no mande su historial completo en un
 * request y para que el trabajo por peticion sea acotado.
 */
export const MAX_WORKOUTS_POR_SYNC = 50;

/**
 * Tope de puntos por entrenamiento sincronizado.
 *
 * A 1 Hz son mas de cinco horas de carrera. Por encima casi seguro es un
 * cliente que no esta limpiando su cola local.
 */
export const MAX_PUNTOS_POR_WORKOUT = 20_000;

// ─── Entrada ───────────────────────────────────────────────────────────────

export class ListWorkoutsQueryDto {
  @ApiPropertyOptional({ enum: WorkoutType })
  @IsOptional()
  @IsEnum(WorkoutType)
  type?: WorkoutType;

  @ApiPropertyOptional({ description: 'Desde (ISO). Compara contra `startedAt`. Inclusivo' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Hasta (ISO). Exclusivo' })
  @IsOptional()
  @IsISO8601()
  to?: string;

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
  @MaxLength(500)
  cursor?: string;
}

export enum GroupBy {
  week = 'week',
  month = 'month',
}

export class GroupedQueryDto {
  @ApiPropertyOptional({ enum: GroupBy, default: GroupBy.week })
  @IsOptional()
  @IsEnum(GroupBy)
  by?: GroupBy;

  @ApiPropertyOptional({
    default: GRUPOS_POR_DEFECTO,
    maximum: GRUPOS_MAXIMOS,
    description: 'Cuantos grupos, del mas reciente hacia atras',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GRUPOS_MAXIMOS)
  limit?: number;
}

export class WeeklyStatsQueryDto {
  @ApiPropertyOptional({
    default: SEMANAS_POR_DEFECTO,
    maximum: SEMANAS_MAXIMAS,
    description: 'Cuantas semanas hacia atras, incluida la actual',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEMANAS_MAXIMAS)
  weeks?: number;
}

export class SyncWorkoutDto {
  @ApiProperty({ description: 'El uuid que el cliente le puso al crearlo en local' })
  @IsUUID()
  clientUuid!: string;

  @ApiPropertyOptional({ enum: WorkoutType, default: WorkoutType.free_run })
  @IsOptional()
  @IsEnum(WorkoutType)
  type?: WorkoutType;

  @ApiPropertyOptional({ enum: WorkoutSource, default: WorkoutSource.app })
  @IsOptional()
  @IsEnum(WorkoutSource)
  source?: WorkoutSource;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  planSessionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  registrationId?: string;

  @ApiPropertyOptional({ description: '`uniqueId` del dispositivo que lo grabo' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;

  @ApiProperty({ description: 'ISO-8601' })
  @IsISO8601()
  startedAt!: string;

  @ApiProperty({ description: 'ISO-8601. Un entrenamiento que se sincroniza ya termino.' })
  @IsISO8601()
  endedAt!: string;

  @ApiPropertyOptional({
    type: [PositionPointDto],
    maxItems: MAX_PUNTOS_POR_WORKOUT,
    description:
      'El recorrido. Si viene, **manda el servidor**: distancia, splits y ritmo se recalculan ' +
      'desde aqui y se ignoran los numeros del cliente.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PUNTOS_POR_WORKOUT)
  @ValidateNested({ each: true })
  @Type(() => PositionPointDto)
  points?: PositionPointDto[];

  @ApiPropertyOptional({
    description:
      'Solo para entrenamientos **sin recorrido** (`source: manual`): ahi no hay nada que ' +
      'recalcular y el dato del usuario es el unico que existe.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  distanceMeters?: number;

  @ApiPropertyOptional({ description: 'Idem: solo se usa sin recorrido' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  durationSeconds?: number;

  @ApiPropertyOptional({ description: 'Los numeros del cliente. Se guardan para comparar.' })
  @IsOptional()
  @IsObject()
  clientReported?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  feeling?: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class SyncWorkoutsDto {
  @ApiProperty({ type: [SyncWorkoutDto], maxItems: MAX_WORKOUTS_POR_SYNC })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WORKOUTS_POR_SYNC)
  @ValidateNested({ each: true })
  @Type(() => SyncWorkoutDto)
  workouts!: SyncWorkoutDto[];
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class WorkoutSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() clientUuid!: string;
  @ApiProperty({ enum: WorkoutType }) type!: WorkoutType;
  @ApiProperty({ enum: WorkoutSource }) source!: WorkoutSource;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ nullable: true }) endedAt!: string | null;
  @ApiProperty() distanceMeters!: number;
  @ApiProperty() durationSeconds!: number;
  @ApiProperty() movingSeconds!: number;
  @ApiProperty({ nullable: true }) avgPaceSecPerKm!: number | null;
  @ApiProperty() elevationGainMeters!: number;
  @ApiProperty({ nullable: true }) calories!: number | null;
  @ApiProperty({ nullable: true }) feeling!: number | null;
  @ApiProperty({ nullable: true }) planSessionId!: string | null;
  @ApiProperty({ nullable: true }) registrationId!: string | null;
}

export class WorkoutGroupDto {
  @ApiProperty({ description: 'Inicio del grupo (lunes 00:00 o dia 1 del mes, hora local)' })
  startsAt!: string;

  @ApiProperty() distanceMeters!: number;
  @ApiProperty() movingSeconds!: number;
  @ApiProperty() durationSeconds!: number;
  @ApiProperty() elevationGainMeters!: number;
  @ApiProperty() workouts!: number;
  @ApiProperty({ nullable: true }) avgPaceSecPerKm!: number | null;
}

export class GroupedWorkoutsDto {
  @ApiProperty({ enum: GroupBy }) by!: GroupBy;

  @ApiProperty({ example: 'America/La_Paz', description: 'Zona en la que se cortaron los grupos' })
  timezone!: string;

  @ApiProperty({ type: [WorkoutGroupDto] }) groups!: WorkoutGroupDto[];
}

export class DayStatsDto {
  @ApiProperty({ example: 1, description: '1 = lunes, 7 = domingo' }) weekday!: number;
  @ApiProperty() startsAt!: string;
  @ApiProperty() distanceMeters!: number;
  @ApiProperty() movingSeconds!: number;
  @ApiProperty() workouts!: number;
}

export class WeekStatsDto {
  @ApiProperty() weekStartsAt!: string;

  @ApiProperty({ description: 'Lunes de la semana siguiente. **Exclusivo**' })
  weekEndsAt!: string;

  @ApiProperty() distanceMeters!: number;
  @ApiProperty() movingSeconds!: number;
  @ApiProperty() durationSeconds!: number;
  @ApiProperty() workouts!: number;
  @ApiProperty({ nullable: true }) avgPaceSecPerKm!: number | null;
  @ApiProperty({ type: [DayStatsDto] }) days!: DayStatsDto[];
}

export class WeeklyStatsDto {
  @ApiProperty({ example: 'America/La_Paz' }) timezone!: string;

  @ApiProperty({
    type: [WeekStatsDto],
    description: 'De la mas vieja a la mas reciente: la ultima es la semana en curso',
  })
  weeks!: WeekStatsDto[];
}

export class SyncResultDto {
  @ApiProperty() clientUuid!: string;

  @ApiProperty({
    enum: ['created', 'duplicated', 'rejected'],
    description:
      '`duplicated` no es un error: ese entrenamiento ya estaba y el cliente puede marcarlo ' +
      'como sincronizado igual.',
  })
  status!: 'created' | 'duplicated' | 'rejected';

  @ApiProperty({ nullable: true }) workoutId!: string | null;

  @ApiProperty({ nullable: true, example: 'La sesion del plan no existe' })
  reason!: string | null;

  @ApiProperty({ nullable: true, description: 'Puntos que el servidor descarto por ruido' })
  discardedPoints!: number | null;
}

export class SyncResponseDto {
  @ApiProperty() created!: number;
  @ApiProperty() duplicated!: number;
  @ApiProperty() rejected!: number;
  @ApiProperty({ type: [SyncResultDto] }) results!: SyncResultDto[];
}
