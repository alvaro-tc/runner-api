import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { TrainingPlansService } from './training-plans.service';
import {
  CompleteSessionDto,
  CreatePlanDto,
  CurrentPlanQueryDto,
  CurrentPlanWeekDto,
  ListTemplatesQueryDto,
  MyPlansDto,
  PlanDto,
  PlanSessionDto,
  RescheduleSessionDto,
  RestartPlanDto,
  SuggestionDto,
  SuggestionsQueryDto,
  TemplateDetailDto,
  TemplateSummaryDto,
} from './dto/training-plan.dto';

/**
 * Planes de entrenamiento.
 *
 * El **catalogo** de plantillas es publico, por lo mismo que el de maratones:
 * es material de difusion y verlo no compromete nada. Todo lo que empieza en
 * `me`, `sessions` o un id de plan es del usuario y exige token.
 *
 * El orden de los metodos importa: Nest resuelve por orden de declaracion, asi
 * que `templates`, `suggestions`, `me` y `sessions` van **antes** que `:id`, o
 * la ruta comodin se los comeria.
 */
@ApiTags('training-plans')
@Controller('training-plans')
export class TrainingPlansController {
  constructor(private readonly plans: TrainingPlansService) {}

  // ─── Catalogo (publico) ──────────────────────────────────────────────────

  @Get('templates')
  @Public()
  @ApiOperation({
    summary: 'Catalogo de plantillas de plan',
    description: 'Sin paginar: son pocas y caben en una respuesta.',
  })
  @ApiResponse({ status: 200, type: [TemplateSummaryDto] })
  templates(@Query() query: ListTemplatesQueryDto) {
    return this.plans.plantillas(query);
  }

  @Get('templates/:slug')
  @Public()
  @ApiOperation({
    summary: 'Detalle de una plantilla, con todas sus sesiones',
    description:
      'Acepta el slug o el id. Las sesiones traen `paceFactor`, no ritmos: los ritmos concretos ' +
      'aparecen al instanciar el plan, cuando ya se conoce el ritmo base del corredor.',
  })
  @ApiParam({ name: 'slug', example: '10k-principiante-10s' })
  @ApiResponse({ status: 200, type: TemplateDetailDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  template(@Param('slug') slug: string) {
    return this.plans.plantilla(slug);
  }

  @Get('suggestions')
  @Public()
  @ApiOperation({
    summary: 'Plantillas que sirven para una maraton concreta',
    description:
      'Ordenadas por ajuste. `fits: false` no significa descartada: significa que entra recortando ' +
      'semanas de base, y `effectiveWeeks` dice cuantas quedarian.',
  })
  @ApiResponse({ status: 200, type: [SuggestionDto] })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  suggestions(@Query() query: SuggestionsQueryDto) {
    return this.plans.sugerencias(query.marathonId);
  }

  // ─── Plan del usuario ────────────────────────────────────────────────────

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Plan activo del usuario e historial de planes cerrados' })
  @ApiResponse({ status: 200, type: MyPlansDto })
  mine(@CurrentUser('sub') userId: string) {
    return this.plans.mios(userId);
  }

  @Get('me/current')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Una semana del plan activo',
    description: 'Sin `week`, la semana que corresponde a hoy. Fuera de rango se acota a 1..N.',
  })
  @ApiResponse({ status: 200, type: CurrentPlanWeekDto })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'NOT_FOUND: no hay plan activo',
  })
  current(@CurrentUser('sub') userId: string, @Query() query: CurrentPlanQueryDto) {
    return this.plans.semanaActual(userId, query.week);
  }

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Instanciar un plan a partir de una plantilla',
    description:
      'Con `marathonId`, el plan se ancla a la semana de la carrera y se recorta desde las semanas ' +
      'de base si no entra entero. Solo puede haber un plan activo: con otro en curso hay que ' +
      'mandar `replaceActive: true`.',
  })
  @ApiResponse({ status: 201, type: PlanDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'PLAN_ALREADY_ACTIVE, PLAN_DOES_NOT_FIT',
  })
  create(@CurrentUser('sub') userId: string, @Body() dto: CreatePlanDto) {
    return this.plans.crear(userId, dto);
  }

  // ─── Sesiones ────────────────────────────────────────────────────────────

  @Patch('sessions/:id/complete')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Marcar una sesion como hecha, o saltada con `skipped: true`',
    description: 'Cuando no queda ninguna sesion abierta, el plan pasa solo a `completed`.',
  })
  @ApiResponse({ status: 200, type: PlanSessionDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'SESSION_NOT_PENDING' })
  complete(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: CompleteSessionDto,
  ) {
    return this.plans.completarSesion(userId, id, dto);
  }

  @Patch('sessions/:id/reschedule')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Mover una sesion a otro dia dentro del plan',
    description: 'La semana no cambia. Se conserva la fecha original en `rescheduledFromDate`.',
  })
  @ApiResponse({ status: 200, type: PlanSessionDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'VALIDATION_ERROR' })
  reschedule(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: RescheduleSessionDto,
  ) {
    return this.plans.reprogramarSesion(userId, id, dto);
  }

  // ─── Ciclo de vida ───────────────────────────────────────────────────────

  @Patch(':id/abandon')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Abandonar el plan activo' })
  @ApiResponse({ status: 200, type: PlanDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'PLAN_NOT_ACTIVE' })
  abandon(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.plans.abandonar(userId, id);
  }

  @Post(':id/restart')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Volver a empezar el mismo plan desde otra fecha',
    description: 'Rehace las sesiones desde cero: se pierde el progreso anterior.',
  })
  @ApiResponse({ status: 200, type: PlanDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'PLAN_ALREADY_ACTIVE' })
  @HttpCode(HttpStatus.OK)
  restart(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: RestartPlanDto,
  ) {
    return this.plans.reiniciar(userId, id, dto);
  }

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Borrar un plan',
    description:
      'Borrado real: un plan se puede regenerar desde su plantilla. Los entrenamientos asociados ' +
      'no se tocan, solo pierden el vinculo con la sesion.',
  })
  @ApiResponse({ status: 204, description: 'Borrado' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    await this.plans.eliminar(userId, id);
  }
}
