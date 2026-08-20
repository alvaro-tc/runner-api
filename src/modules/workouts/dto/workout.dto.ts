import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
} from 'class-validator';
import { TrackingSessionStatus, WorkoutType } from '../../../../generated/prisma/enums';

// ─── Entrada ───────────────────────────────────────────────────────────────

export class StartSessionDto {
  @ApiProperty({
    example: '3f1c1b6e-9a1e-4b3a-9f5d-2c7e8a0b1d42',
    description:
      'UUID que genera el cliente ANTES de tener red. Es la clave de idempotencia: repetir la ' +
      'llamada con el mismo valor devuelve la sesion existente, no una segunda.',
  })
  @IsUUID()
  clientUuid!: string;

  @ApiPropertyOptional({ enum: WorkoutType, default: WorkoutType.free_run })
  @IsOptional()
  @IsEnum(WorkoutType)
  type?: WorkoutType;

  @ApiPropertyOptional({ description: 'Sesion del plan que este entrenamiento viene a cumplir' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  planSessionId?: string;

  @ApiPropertyOptional({ description: 'Inscripcion, cuando el entrenamiento es una carrera' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  registrationId?: string;

  @ApiPropertyOptional({ description: '`uniqueId` del dispositivo, el mismo que usa OsmAnd' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;

  @ApiPropertyOptional({
    description: 'Cuando arranco de verdad. Por defecto, ahora. Sirve para arranques sin red.',
  })
  @IsOptional()
  @IsISO8601()
  startedAt?: string;
}

export class FinishSessionDto {
  @ApiPropertyOptional({
    description:
      'Los numeros que calculo el cliente. Se guardan para comparar, pero NO se publican: la ' +
      'fuente de verdad son las metricas del servidor.',
    example: { distanceMeters: 10_120, durationSeconds: 3005, movingSeconds: 2980 },
  })
  @IsOptional()
  @IsObject()
  clientReported?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Como se sintio el corredor' })
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

// ─── Salida ────────────────────────────────────────────────────────────────

export class WorkoutSplitDto {
  @ApiProperty({ example: 0, description: 'Base 0: el split 0 es el primer kilometro' })
  index!: number;

  @ApiProperty({ example: 1000 }) distanceMeters!: number;
  @ApiProperty({ example: 298 }) durationSeconds!: number;
  @ApiProperty({ example: 298 }) paceSecPerKm!: number;
  @ApiProperty({ example: 12 }) elevationGainMeters!: number;
}

export class WorkoutDto {
  @ApiProperty() id!: string;
  @ApiProperty() clientUuid!: string;
  @ApiProperty({ enum: WorkoutType }) type!: WorkoutType;
  @ApiProperty({ nullable: true }) planSessionId!: string | null;
  @ApiProperty({ nullable: true }) registrationId!: string | null;
  @ApiProperty({ description: 'ISO-8601 UTC' }) startedAt!: string;
  @ApiProperty({ nullable: true }) endedAt!: string | null;

  @ApiProperty({ example: 3005, description: 'Reloj de pared del primer al ultimo punto' })
  durationSeconds!: number;

  @ApiProperty({ example: 2980, description: 'Excluye el tiempo parado' })
  movingSeconds!: number;

  @ApiProperty({ example: 10_043, description: 'Metros, medidos por el servidor' })
  distanceMeters!: number;

  @ApiProperty({ nullable: true, example: 297 }) avgPaceSecPerKm!: number | null;
  @ApiProperty({ nullable: true, example: 3.37 }) avgSpeedMps!: number | null;
  @ApiProperty({ example: 148 }) elevationGainMeters!: number;
  @ApiProperty({ nullable: true, example: 412 }) calories!: number | null;

  @ApiProperty({ nullable: true, example: 4, description: 'Indice del kilometro mas rapido' })
  bestKmIndex!: number | null;

  @ApiProperty({ nullable: true, minimum: 1, maximum: 5 }) feeling!: number | null;
  @ApiProperty({ nullable: true }) notes!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Lo que reporto el cliente, para comparar. Nunca es la fuente de verdad.',
  })
  clientReported!: unknown;

  @ApiProperty({ type: [WorkoutSplitDto] }) splits!: WorkoutSplitDto[];
}

export class TrackingSessionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: TrackingSessionStatus }) status!: TrackingSessionStatus;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ nullable: true }) lastPositionAt!: string | null;
  @ApiProperty({ nullable: true }) finishedAt!: string | null;
}

export class StartedSessionDto {
  @ApiProperty({ type: TrackingSessionDto }) session!: TrackingSessionDto;
  @ApiProperty({ type: WorkoutDto }) workout!: WorkoutDto;

  @ApiProperty({
    description:
      'Token de ingesta en claro. **Solo se devuelve aqui**: en la base solo queda su hash. ' +
      'Autentica `POST /tracking/sessions/:id/positions` en lugar del JWT del usuario.',
  })
  ingestToken!: string;
}

export class FinishedSessionDto {
  @ApiProperty({ type: TrackingSessionDto }) session!: TrackingSessionDto;
  @ApiProperty({ type: WorkoutDto }) workout!: WorkoutDto;

  @ApiProperty({
    example: 3,
    description: 'Puntos que el servidor descarto por precision o por salto imposible',
  })
  discardedPoints!: number;

  @ApiProperty({
    nullable: true,
    description: 'La zapatilla a la que se sumo la distancia, si habia una principal',
    example: { id: 'ckv...', distanceMeters: 812_000, wearAlert: true },
  })
  shoe!: unknown;
}
