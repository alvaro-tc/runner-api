import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WorkoutSessionsService } from './workout-sessions.service';
import { WorkoutsService } from './workouts.service';
import {
  FinishSessionDto,
  FinishedSessionDto,
  StartSessionDto,
  StartedSessionDto,
  TrackingSessionDto,
  WorkoutDto,
} from './dto/workout.dto';
import {
  GroupedQueryDto,
  GroupedWorkoutsDto,
  ListWorkoutsQueryDto,
  SyncResponseDto,
  SyncWorkoutsDto,
  WeeklyStatsDto,
  WeeklyStatsQueryDto,
  WorkoutSummaryDto,
} from './dto/workout-history.dto';

/**
 * Sesiones de entrenamiento.
 *
 * Todo exige token: un entrenamiento es de una persona y de nadie mas. La
 * **ingesta de posiciones** no vive aqui sino en `/tracking` (Fase 11), y se
 * autentica con el `ingestToken` que devuelve el arranque, no con el JWT: asi
 * el credencial que viaja cada 20 segundos desde el telefono tiene alcance
 * minimo y vida corta.
 */
@ApiTags('workouts')
@ApiBearerAuth('access-token')
@Controller('workouts/sessions')
export class WorkoutSessionsController {
  constructor(private readonly sessions: WorkoutSessionsService) {}

  @Post()
  @ApiOperation({
    summary: 'Arrancar un entrenamiento y su sesion de tracking',
    description:
      'Idempotente por `clientUuid`: repetir la llamada devuelve la sesion existente con un ' +
      '`ingestToken` **nuevo** (el anterior queda invalidado). Solo puede haber una sesion ' +
      'abierta por usuario.',
  })
  @ApiResponse({ status: 201, type: StartedSessionDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'SESSION_ALREADY_ACTIVE: hay otra sesion abierta, ciérrala o descártala',
  })
  start(@CurrentUser('sub') userId: string, @Body() dto: StartSessionDto) {
    return this.sessions.iniciar(userId, dto);
  }

  @Patch(':id/pause')
  @ApiOperation({
    summary: 'Pausar la sesion',
    description:
      'La ingesta sigue abierta: un lote en vuelo trae puntos reales y perderlos seria peor. ' +
      'El tiempo parado no se descuenta aquí: sale de las posiciones al consolidar ' +
      '(`movingSeconds`).',
  })
  @ApiResponse({ status: 200, type: TrackingSessionDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'SESSION_NOT_ACTIVE' })
  pause(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.sessions.pausar(userId, id);
  }

  @Patch(':id/resume')
  @ApiOperation({ summary: 'Reanudar una sesion en pausa' })
  @ApiResponse({ status: 200, type: TrackingSessionDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'SESSION_NOT_ACTIVE' })
  resume(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.sessions.reanudar(userId, id);
  }

  @Post(':id/finish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cerrar la sesion y consolidar las metricas',
    description:
      'El servidor recalcula distancia, splits, ritmo, elevacion y calorias desde las posiciones. ' +
      '`clientReported` se guarda para comparar, pero nunca se publica como métrica.',
  })
  @ApiResponse({ status: 200, type: FinishedSessionDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'SESSION_NOT_ACTIVE' })
  finish(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: FinishSessionDto,
  ) {
    return this.sessions.finalizar(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Descartar la sesion',
    description:
      'El entrenamiento queda con `deletedAt` (recuperable desde el panel) y las posiciones se ' +
      'borran de verdad: son datos de ubicacion y el usuario pidió tirarlos.',
  })
  @ApiResponse({ status: 204, description: 'Descartada' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'SESSION_NOT_ACTIVE' })
  async discard(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    await this.sessions.descartar(userId, id);
  }
}

/**
 * Historial de entrenamientos.
 *
 * Todo lo de aqui filtra por el usuario del token dentro del `where`, no con un
 * `if` posterior: el recorrido de una persona no lo lee nadie mas, y un id
 * ajeno tiene que devolver 404 —no 403— para no confirmar que existe.
 */
@ApiTags('workouts')
@ApiBearerAuth('access-token')
@Controller('workouts')
export class WorkoutsController {
  constructor(private readonly workouts: WorkoutsService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Clave del lote, generada por el cliente. Reenviar el mismo lote es seguro: cada ' +
      'entrenamiento se identifica por su `clientUuid`, que es unico en la base.',
  })
  @ApiOperation({
    summary: 'Subida masiva de entrenamientos grabados sin red',
    description:
      'Un fallo no tumba el lote: cada entrenamiento se resuelve por separado y la respuesta ' +
      'dice, uno a uno, si quedo `created`, `duplicated` o `rejected`. Si el item trae ' +
      '`points`, el servidor recalcula distancia, splits y ritmo desde el recorrido; sin ' +
      'puntos se toma lo que declaro el usuario y el entrenamiento queda como `manual`.',
  })
  @ApiResponse({ status: 200, type: SyncResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'IDEMPOTENCY_KEY_REQUIRED',
  })
  sync(
    @CurrentUser('sub') userId: string,
    @Body() dto: SyncWorkoutsDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.workouts.sincronizar(userId, dto, idempotencyKey ?? '');
  }

  @Get('grouped')
  @ApiOperation({
    summary: 'Totales por semana o por mes',
    description:
      'Los cortes se hacen en la zona horaria del proyecto, no en UTC: en La Paz una carrera ' +
      'del domingo por la tarde es UTC del lunes, y contarla en la semana siguiente seria ' +
      'mentirle al usuario.',
  })
  @ApiResponse({ status: 200, type: GroupedWorkoutsDto })
  grouped(@CurrentUser('sub') userId: string, @Query() query: GroupedQueryDto) {
    return this.workouts.agrupar(userId, query);
  }

  @Get('stats/weekly')
  @ApiOperation({
    summary: 'Resumen semanal con la barra de cada dia',
    description:
      'Devuelve siempre las siete casillas de cada semana, incluidas las vacias: la tira ' +
      'Mon-Sun necesita los ceros tanto como los kilometros.',
  })
  @ApiResponse({ status: 200, type: WeeklyStatsDto })
  weekly(@CurrentUser('sub') userId: string, @Query() query: WeeklyStatsQueryDto) {
    return this.workouts.statsSemanales(userId, query);
  }

  @Get()
  @ApiOperation({
    summary: 'Historial filtrado, paginado por cursor',
    description: 'Del mas reciente al mas viejo. Sin splits: para eso esta el detalle.',
  })
  @ApiResponse({ status: 200, type: [WorkoutSummaryDto] })
  list(@CurrentUser('sub') userId: string, @Query() query: ListWorkoutsQueryDto) {
    return this.workouts.listar(userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un entrenamiento, con sus splits por kilometro' })
  @ApiResponse({ status: 200, type: WorkoutDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  detail(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.workouts.detalle(userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar un entrenamiento',
    description:
      'Borrado logico (`deletedAt`): deja de aparecer, pero se puede recuperar desde el panel. ' +
      'Los kilometros ya sumados a la zapatilla no se restan: el desgaste ocurrio igual.',
  })
  @ApiResponse({ status: 204, description: 'Borrado' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  async remove(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    await this.workouts.borrar(userId, id);
  }
}
