import {
  Body,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
  createParamDecorator,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Public } from '../auth/decorators/public.decorator';
import { IngestThrottlerGuard } from './ingest-throttler.guard';
import { IngestTokenGuard, type IngestRequest } from './ingest-token.guard';
import { TrackingService } from './tracking.service';
import { AppBatchSource, OsmAndSource } from './sources/position-ingestion-source';
import {
  IngestPositionsDto,
  IngestResultDto,
  OsmAndQueryDto,
  SimulateDto,
} from './dto/tracking.dto';

/**
 * Lotes por minuto y por sesion.
 *
 * El ritmo normal son 2-4 (un lote cada 15-30 s); el margen esta para el
 * cliente que drena su cola de golpe al salir de un tunel. Se lee de
 * `process.env` y no de `AppConfigService` porque `@Throttle` es un decorador y
 * se evalua al cargar la clase, antes de que exista el contenedor de Nest.
 */
const LIMITE_LOTES = {
  corto: {
    limit: Number(process.env.TRACKING_INGEST_BATCHES_PER_MINUTE ?? 20),
    ttl: 60_000,
  },
};

/**
 * Un punto por peticion y en la URL: OsmAnd es asi. El limite se cuenta por
 * dispositivo y tiene que ser mucho mas alto que el de los lotes porque aqui
 * cada punto es una peticion; a 1 Hz un tracker manda 60 por minuto.
 */
const LIMITE_OSMAND = {
  corto: { limit: Number(process.env.TRACKING_OSMAND_POINTS_PER_MINUTE ?? 120), ttl: 60_000 },
};

/**
 * Query de OsmAnd validada **sin** `forbidNonWhitelisted`.
 *
 * Traccar Client manda extras que no pedimos (`hdop`, `charge`, `cell`...) y no
 * podemos decirle que no lo haga: la regla global de rechazar campos de mas
 * convertiria cada version nueva del cliente en un 400. Este decorador los
 * descarta antes, y lo que sale de aqui —ya limpio— vuelve a pasar por la
 * validacion global sin sorpresas.
 */
const TOLERANTE = new ValidationPipe({ whitelist: true, transform: true });

const OsmAndQuery = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  TOLERANTE.transform(ctx.switchToHttp().getRequest<IngestRequest>().query, {
    type: 'query',
    metatype: OsmAndQueryDto,
  }),
);

/**
 * Ingesta de posiciones.
 *
 * **`@Public()` no significa abierto**: significa que no se autentica con el
 * JWT del usuario. La puerta la pone `IngestTokenGuard` con el `ingestToken` de
 * la sesion, que es un credencial de alcance minimo y vida corta.
 */
@ApiTags('tracking')
@Public()
@Controller('tracking')
export class TrackingController {
  private readonly appBatch = new AppBatchSource();
  private readonly osmand = new OsmAndSource();

  constructor(
    private readonly tracking: TrackingService,
    private readonly config: AppConfigService,
  ) {}

  @Post('sessions/:id/positions')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(IngestTokenGuard, IngestThrottlerGuard)
  @Throttle(LIMITE_LOTES)
  @ApiBearerAuth('ingest-token')
  @ApiParam({ name: 'id', description: 'Id de la sesion, el mismo que devolvio el arranque' })
  @ApiOperation({
    summary: 'Sube un lote de posiciones',
    description:
      'Se autentica con el `ingestToken` de la sesion (`Authorization: Bearer <ingestToken>`), ' +
      '**no** con el JWT del usuario. Manda lotes de 15-30 s, nunca punto por punto: una ' +
      'peticion por segundo destroza la bateria y no aporta nada. Reenviar un lote es seguro: ' +
      'los repetidos se cuentan en `duplicated` y no se duplican. Responde `202` sin calcular ' +
      'metricas — eso pasa al cerrar la sesion.',
  })
  @ApiResponse({ status: 202, type: IngestResultDto })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: 'INVALID_INGEST_TOKEN: el token no existe o no es de esta sesion',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'SESSION_NOT_ACTIVE: la sesion ya se cerro o se descarto',
  })
  @ApiResponse({ status: 429, type: ErrorResponseDto, description: 'RATE_LIMITED' })
  positions(@Req() req: IngestRequest, @Param('id') _id: string, @Body() dto: IngestPositionsDto) {
    // El guard ya resolvio y valido la sesion; si no estuviera, no llegariamos.
    const sesion = req.trackingSession!;
    return this.tracking.ingerir(sesion, this.appBatch.aPuntos(dto.points), this.appBatch.source);
  }

  /**
   * Protocolo OsmAnd: un punto por peticion, en la query string.
   *
   * Lo hablan Traccar Client, varios relojes y casi cualquier tracker barato,
   * asi que soportarlo abre la app a hardware que no vamos a escribir nunca. Se
   * acepta en GET y en POST porque los clientes se reparten entre los dos, y
   * los parametros van en la URL en ambos casos: asi los manda el protocolo.
   *
   * **El `id` del dispositivo es el credencial.** Es lo que hay: el protocolo
   * no tiene sitio para nada mejor. Por eso el `uniqueId` es un UUID y no un
   * numero de serie, y por eso un punto solo entra si ese dispositivo tiene una
   * sesion abierta — la ventana de abuso es la duracion de un entrenamiento, no
   * la vida de la cuenta.
   */
  @Get('osmand')
  @HttpCode(HttpStatus.OK)
  @UseGuards(IngestThrottlerGuard)
  @Throttle(LIMITE_OSMAND)
  @ApiOperation({
    summary: 'Ingesta compatible con OsmAnd/Traccar Client',
    description:
      'Un punto por peticion, parametros en la query string. Se identifica con el `uniqueId` ' +
      'del dispositivo (`id`) y necesita que ese dispositivo tenga una sesion de tracking ' +
      'abierta, o una inscripcion confirmada en una maraton en preparacion: en ese caso el ' +
      'punto se publica a los espectadores y no se guarda (`accepted: 0`). `timestamp` acepta ' +
      'unix en segundos, en milisegundos o ISO-8601.',
  })
  @ApiResponse({ status: 200, type: IngestResultDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'SESSION_NOT_ACTIVE: el dispositivo no tiene sesion abierta ni carrera preparando',
  })
  osmandIngest(@OsmAndQuery() query: OsmAndQueryDto) {
    return this.tracking.ingerirDeDispositivo(
      query.id,
      this.osmand.aPuntos(query),
      this.osmand.source,
    );
  }

  /** Los clientes se reparten entre GET y POST; los parametros van igual en la URL. */
  @Post('osmand')
  @HttpCode(HttpStatus.OK)
  @UseGuards(IngestThrottlerGuard)
  @Throttle(LIMITE_OSMAND)
  @ApiOperation({ summary: 'Ingesta compatible con OsmAnd/Traccar Client (POST)' })
  @ApiResponse({ status: 200, type: IngestResultDto })
  osmandIngestPost(@OsmAndQuery() query: OsmAndQueryDto) {
    return this.osmandIngest(query);
  }

  /**
   * Reproduce un track en la sesion, sin salir a correr.
   *
   * Se autentica con el mismo `ingestToken`, porque hace exactamente lo mismo
   * que la ingesta normal: mete puntos en una sesion. Fuera de produccion y
   * punto — en produccion ni existe.
   */
  @Post('simulate')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(IngestTokenGuard)
  @ApiBearerAuth('ingest-token')
  @ApiOperation({
    summary: 'Simula un recorrido (solo fuera de produccion)',
    description:
      'Genera puntos a partir de un `LineString` GeoJSON y los mete por el mismo camino que la ' +
      'ingesta real. Los tiempos se cuentan hacia atras desde ahora, y si el track no cabe en la ' +
      'sesion se retrasa su `startedAt`. En produccion responde 404.',
  })
  @ApiResponse({ status: 202, type: IngestResultDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND: en produccion' })
  simulate(@Req() req: IngestRequest, @Body() dto: SimulateDto) {
    if (this.config.isProduction) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Ruta no encontrada', HttpStatus.NOT_FOUND);
    }
    return this.tracking.simular(req.trackingSession!, dto);
  }
}
