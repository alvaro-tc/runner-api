import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PlanLevel,
  TrainingPlanSessionStatus,
  TrainingPlanStatus,
  TrainingSessionType,
} from '../../../../generated/prisma/enums';

// ─── Entrada ───────────────────────────────────────────────────────────────

export class ListTemplatesQueryDto {
  @ApiPropertyOptional({ example: 21097, description: 'Distancia objetivo en metros' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(100_000)
  goalDistance?: number;

  @ApiPropertyOptional({ enum: PlanLevel })
  @IsOptional()
  @IsEnum(PlanLevel)
  level?: PlanLevel;

  @ApiPropertyOptional({ example: 12, description: 'Duracion exacta en semanas' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  weeks?: number;
}

export class SuggestionsQueryDto {
  @ApiProperty({ description: 'Id o slug de la maraton objetivo' })
  @IsString()
  @MaxLength(120)
  marathonId!: string;
}

export class CreatePlanDto {
  @ApiProperty()
  @IsString()
  @MaxLength(60)
  templateId!: string;

  @ApiPropertyOptional({
    description:
      'Maraton objetivo. Si viene, el plan se ancla a la semana de la carrera y `startDate` se ignora.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  marathonId?: string;

  @ApiPropertyOptional({
    example: '2026-09-07',
    description:
      'Solo sin maraton objetivo. Por defecto, el lunes siguiente. Se redondea al lunes.',
  })
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Confirma abandonar el plan activo. Sin esto, crear un segundo plan responde PLAN_ALREADY_ACTIVE.',
  })
  @IsOptional()
  @IsBoolean()
  replaceActive?: boolean;
}

export class RestartPlanDto {
  @ApiPropertyOptional({ example: '2026-09-07', description: 'Por defecto, el lunes siguiente' })
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  replaceActive?: boolean;
}

export class CompleteSessionDto {
  @ApiPropertyOptional({ description: 'El entrenamiento que cumplio la sesion, si lo hubo' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  workoutId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'True marca la sesion como saltada en vez de completada',
  })
  @IsOptional()
  @IsBoolean()
  skipped?: boolean;
}

export class RescheduleSessionDto {
  @ApiProperty({ example: '2026-09-10', description: 'Nueva fecha, dentro del plan' })
  @IsISO8601()
  scheduledDate!: string;
}

export class CurrentPlanQueryDto {
  @ApiPropertyOptional({ description: 'Semana a mostrar. Por defecto, la que corresponde a hoy' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  week?: number;
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class TemplateSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '10k-principiante-10s' }) slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ example: 10_000 }) goalDistanceMeters!: number;
  @ApiProperty({ enum: PlanLevel }) level!: PlanLevel;
  @ApiProperty() totalWeeks!: number;
  @ApiProperty({ example: 4 }) weeklySessions!: number;
  @ApiProperty({ example: 32_000 }) avgWeeklyDistanceMeters!: number;
  @ApiProperty({ nullable: true }) coverUrl!: string | null;
}

export class TemplateSessionDto {
  @ApiProperty() id!: string;
  @ApiProperty() week!: number;
  @ApiProperty({ example: 2, description: '1 = lunes ... 7 = domingo' }) weekday!: number;
  @ApiProperty({ enum: TrainingSessionType }) type!: TrainingSessionType;
  @ApiProperty({ nullable: true }) targetDistanceMeters!: number | null;
  @ApiProperty({ nullable: true }) targetDurationSeconds!: number | null;
  @ApiProperty({ example: 1.15, description: 'Multiplicador sobre el ritmo base' })
  paceFactor!: number;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() isKeySession!: boolean;
}

export class TemplateDetailDto extends TemplateSummaryDto {
  @ApiProperty({ type: [TemplateSessionDto] }) sessions!: TemplateSessionDto[];
}

export class SuggestionDto {
  @ApiProperty({ type: TemplateSummaryDto }) template!: TemplateSummaryDto;
  @ApiProperty({ example: 9, description: 'Semanas completas hasta la semana de la carrera' })
  weeksAvailable!: number;
  @ApiProperty({ description: 'False = entra recortando semanas de base' }) fits!: boolean;
  @ApiProperty({ description: 'Semanas que quedarian tras el recorte' }) effectiveWeeks!: number;
}

export class PlanSessionDto {
  @ApiProperty() id!: string;
  @ApiProperty() week!: number;
  @ApiProperty() weekday!: number;
  @ApiProperty({ example: '2026-09-08', description: 'Fecha de calendario, sin hora' })
  scheduledDate!: string;
  @ApiProperty({ enum: TrainingSessionType }) type!: TrainingSessionType;
  @ApiProperty({ nullable: true }) targetDistanceMeters!: number | null;
  @ApiProperty({ nullable: true }) targetDurationSeconds!: number | null;
  @ApiProperty({ nullable: true, description: 'El extremo rapido del rango' })
  paceMinSecPerKm!: number | null;
  @ApiProperty({ nullable: true }) paceMaxSecPerKm!: number | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() isKeySession!: boolean;
  @ApiProperty({ enum: TrainingPlanSessionStatus }) status!: TrainingPlanSessionStatus;
  @ApiProperty({ nullable: true }) rescheduledFromDate!: string | null;
  @ApiProperty({ nullable: true }) workoutId!: string | null;
}

export class PlanDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) templateId!: string | null;
  @ApiProperty({ nullable: true }) marathonId!: string | null;
  @ApiProperty({ nullable: true, example: 'Maraton La Paz 3600' }) marathonName!: string | null;
  @ApiProperty() totalWeeks!: number;
  @ApiProperty({ example: '2026-09-07' }) startDate!: string;
  @ApiProperty({ example: '2026-11-29' }) endDate!: string;
  @ApiProperty({ example: 330 }) paceBasisSecPerKm!: number;
  @ApiProperty({ enum: TrainingPlanStatus }) status!: TrainingPlanStatus;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ example: 1, description: 'Semana en curso, o null si aun no empezo o ya termino' })
  currentWeek!: number | null;
  @ApiProperty({ example: 12 }) totalSessions!: number;
  @ApiProperty({ example: 3 }) completedSessions!: number;
}

export class MyPlansDto {
  @ApiProperty({ type: PlanDto, nullable: true }) active!: PlanDto | null;
  @ApiProperty({ type: [PlanDto], description: 'Planes cerrados, del mas reciente al mas viejo' })
  history!: PlanDto[];
}

export class CurrentPlanWeekDto {
  @ApiProperty({ type: PlanDto }) plan!: PlanDto;
  @ApiProperty({ example: 2 }) week!: number;
  @ApiProperty({ type: [PlanSessionDto], description: 'Las sesiones de esa semana, ordenadas' })
  sessions!: PlanSessionDto[];
}
