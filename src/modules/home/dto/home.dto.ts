import { ApiProperty } from '@nestjs/swagger';
import { MarathonSummaryDto } from '../../marathons/dto/marathon.dto';
import { PlanDto, PlanSessionDto } from '../../training-plans/dto/training-plan.dto';

/**
 * Solo para Swagger. La forma real la arma `HomeService` cosiendo lo que
 * devuelven maratones, planes, entrenamientos y la predicción, así que estas
 * clases documentan el contrato — no lo definen.
 */
export class FeaturedMarathonDto extends MarathonSummaryDto {
  @ApiProperty({ nullable: true, description: 'Inscripción del usuario, si ya se apuntó' })
  registrationId!: string | null;

  @ApiProperty({ nullable: true, example: 'MLP-0042' })
  bibNumber!: string | null;

  @ApiProperty({ description: 'true = es su carrera; false = es una invitación del catálogo' })
  isRegistered!: boolean;
}

export class PredictionBasisDto {
  @ApiProperty({ example: 24, description: 'Entrenamientos útiles que entraron en el cálculo' })
  workouts!: number;

  @ApiProperty({ example: 10_000 })
  bestEffortDistanceMeters!: number;

  @ApiProperty({ example: 3000 })
  bestEffortDurationSeconds!: number;

  @ApiProperty({ example: 32_000 })
  avgWeeklyDistanceMeters!: number;

  @ApiProperty({ example: 12 })
  weeksAnalyzed!: number;
}

export class PredictionDto {
  @ApiProperty({ nullable: true, example: 13_140, description: 'Tiempo estimado, en segundos' })
  finishTimeSeconds!: number | null;

  @ApiProperty({ nullable: true, example: 311 })
  paceSecPerKm!: number | null;

  @ApiProperty({
    enum: ['high', 'medium', 'low'],
    nullable: true,
    description: 'Baja cuanto más lejos se extrapola del mejor esfuerzo real',
  })
  confidence!: string | null;

  @ApiProperty({ type: PredictionBasisDto, nullable: true })
  basedOn!: PredictionBasisDto | null;

  @ApiProperty({
    enum: ['insufficient_data'],
    nullable: true,
    description: 'Con menos de 3 entrenamientos de 2 km o más no se predice nada',
  })
  reason!: string | null;
}

export class HomeDayDto {
  @ApiProperty({ example: 1, description: '1 = lunes, 7 = domingo' })
  weekday!: number;

  @ApiProperty()
  startsAt!: string;

  @ApiProperty({ example: 8200, description: 'Lo que se corrió de verdad ese día' })
  distanceMeters!: number;

  @ApiProperty({ example: 2640 })
  movingSeconds!: number;

  @ApiProperty({ example: 1 })
  workouts!: number;

  @ApiProperty({ nullable: true, example: 8000, description: 'Lo que el plan pedía ese día' })
  plannedDistanceMeters!: number | null;

  @ApiProperty({ nullable: true })
  sessionId!: string | null;

  @ApiProperty({ nullable: true, example: 'tempo' })
  sessionType!: string | null;

  @ApiProperty({ nullable: true, example: 'completed' })
  sessionStatus!: string | null;
}

export class HomeWeekDto {
  @ApiProperty({ description: 'Lunes 00:00 local, como instante UTC' })
  weekStartsAt!: string;

  @ApiProperty({ description: 'Lunes siguiente 00:00 local. **Exclusivo**' })
  weekEndsAt!: string;

  @ApiProperty({ example: 'America/La_Paz' })
  timezone!: string;

  @ApiProperty({ example: 32_400 })
  distanceMeters!: number;

  @ApiProperty({ example: 10_800 })
  movingSeconds!: number;

  @ApiProperty({ example: 11_100 })
  durationSeconds!: number;

  @ApiProperty({ example: 4 })
  workouts!: number;

  @ApiProperty({ nullable: true, example: 333 })
  avgPaceSecPerKm!: number | null;

  @ApiProperty({ type: [HomeDayDto], description: 'Siempre las siete casillas, ceros incluidos' })
  days!: HomeDayDto[];
}

export class HomePlanWeekDto {
  @ApiProperty({ example: 6 })
  week!: number;

  @ApiProperty({ type: [PlanSessionDto] })
  sessions!: PlanSessionDto[];
}

export class HomeSummaryDto {
  @ApiProperty({
    type: FeaturedMarathonDto,
    nullable: true,
    description:
      'La carrera del usuario si tiene una pagada por delante; si no, la próxima del catálogo. ' +
      'La cuenta regresiva la calcula el cliente contra `meta.timestamp`.',
  })
  featuredMarathon!: FeaturedMarathonDto | null;

  @ApiProperty({
    type: PredictionDto,
    nullable: true,
    description: 'Tiempo estimado para la distancia de la maratón destacada',
  })
  prediction!: PredictionDto | null;

  @ApiProperty({ type: PlanDto, nullable: true, description: 'Plan activo, o null' })
  plan!: PlanDto | null;

  @ApiProperty({ type: HomePlanWeekDto, nullable: true, description: 'Semana en curso del plan' })
  planWeek!: HomePlanWeekDto | null;

  @ApiProperty({ type: PlanSessionDto, nullable: true, description: 'La sesión de hoy, si la hay' })
  todaySession!: PlanSessionDto | null;

  @ApiProperty({ type: HomeWeekDto, description: 'Tira Mon–Sun: lo hecho contra lo planificado' })
  week!: HomeWeekDto;
}
