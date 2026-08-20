import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ReceiptDto } from '../payments/dto/payment.dto';
import { RacesService } from './races.service';
import {
  ListMyRacesQueryDto,
  MyRacesSummaryDto,
  RaceDetailDto,
  RaceSplitsDto,
  RaceSummaryDto,
  ShareCardDto,
} from './dto/race.dto';

/**
 * Carreras del usuario.
 *
 * Todo se direcciona por **`registrationId`**: es lo unico que existe desde que
 * el corredor se inscribe hasta mucho despues de la meta. El `RaceResult` nace
 * al cruzarla, y colgar las rutas de su id dejaria sin URL a la mitad de la
 * pantalla —la mitad de las proximas carreras.
 */
@ApiTags('races')
@ApiBearerAuth('access-token')
@Controller('races')
export class RacesController {
  constructor(private readonly races: RacesService) {}

  @Get('me/summary')
  @ApiOperation({
    summary: 'Cuántas corriste, cuánto sumaste y cuánto gastaste',
    description:
      'El gasto sale de los pagos cobrados, no de los precios del catálogo: un precio cambia y ' +
      'un cobro no. Incluye la próxima carrera para la cuenta regresiva de la cabecera.',
  })
  @ApiResponse({ status: 200, type: MyRacesSummaryDto })
  summary(@CurrentUser('sub') userId: string) {
    return this.races.resumen(userId);
  }

  @Get('me')
  @ApiOperation({
    summary: 'Mis carreras, próximas y pasadas',
    description:
      'Solo inscripciones confirmadas. El corte lo pone la hora de largada, no el resultado: ' +
      'una carrera de ayer sin tiempos cargados sigue siendo pasada.',
  })
  @ApiResponse({ status: 200, type: [RaceSummaryDto] })
  list(@CurrentUser('sub') userId: string, @Query() query: ListMyRacesQueryDto) {
    return this.races.listar(userId, query);
  }

  @Get(':registrationId')
  @ApiOperation({
    summary: 'Detalle de una carrera',
    description:
      'Métricas completas, marcadores cada 5 km y el recorrido simplificado con ' +
      'Douglas-Peucker (máx. 2.000 vértices). Sin resultado todavía, `result` es `null` y ' +
      'el resto viene igual: dorsal, logística y hora de largada.',
  })
  @ApiResponse({ status: 200, type: RaceDetailDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  detail(@CurrentUser('sub') userId: string, @Param('registrationId') id: string) {
    return this.races.detalle(userId, id);
  }

  @Get(':registrationId/splits')
  @ApiOperation({ summary: 'Parciales por kilómetro y marcadores de paso' })
  @ApiResponse({ status: 200, type: RaceSplitsDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'RESULT_NOT_AVAILABLE: la carrera aún no tiene resultado',
  })
  splits(@CurrentUser('sub') userId: string, @Param('registrationId') id: string) {
    return this.races.splits(userId, id);
  }

  @Get(':registrationId/receipt')
  @ApiOperation({
    summary: 'Comprobante de la inscripción en PDF',
    description:
      'Atajo sobre `/payments/:id/receipt`: resuelve cuál fue el cobro y devuelve el mismo ' +
      'documento. **No es una factura**.',
  })
  @ApiResponse({ status: 200, type: ReceiptDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'RECEIPT_NOT_AVAILABLE: ningún pago de esta inscripción llegó a `paid`',
  })
  receipt(@CurrentUser('sub') userId: string, @Param('registrationId') id: string) {
    return this.races.comprobante(userId, id);
  }

  @Post(':registrationId/share-card')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tarjeta PNG del resultado, para compartir',
    description:
      'Se regenera en cada llamada sobre la misma URL: el puesto cambia cuando el organizador ' +
      'carga los resultados que faltaban, y una imagen cacheada seguiría mostrando el viejo.',
  })
  @ApiResponse({ status: 200, type: ShareCardDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'RESULT_NOT_AVAILABLE' })
  shareCard(@CurrentUser('sub') userId: string, @Param('registrationId') id: string) {
    return this.races.tarjeta(userId, id);
  }
}
