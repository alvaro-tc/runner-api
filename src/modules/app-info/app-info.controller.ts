import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from '../../config/app-config.service';
import { Public } from '../auth/decorators/public.decorator';
import { ACCURACY_MAXIMA_METROS } from '../workouts/metrics';
import { ServiceFeeConfigService } from '../pricing/service-fee.service';
import { AppInfoDto } from './dto/app-info.dto';

/** Umbral de desgaste por defecto de una zapatilla: el mismo que el default de
 *  la columna en `schema.prisma` (800 km). */
const UMBRAL_ZAPATILLA_METROS = 800_000;

/** Cada cuanto conviene drenar la cola de posiciones. Ver `docs/tracking.md`. */
const SEGUNDOS_POR_LOTE = 30;

@ApiTags('config')
@Controller('config')
export class AppInfoController {
  constructor(
    private readonly config: AppConfigService,
    private readonly fees: ServiceFeeConfigService,
  ) {}

  @Get('app')
  @Public()
  @ApiOperation({
    summary: 'Constantes que el cliente no debe hardcodear',
    description:
      'Se pide una vez al arrancar. Todo lo que hay aqui puede cambiar sin publicar una version ' +
      'de la app: el cargo por servicio se apaga desde el panel, la version minima sube por ' +
      'entorno y los limites de tracking se calibran en el VPS. Un valor copiado dentro del APK ' +
      'seria una mentira el dia que alguien lo cambie.',
  })
  @ApiResponse({ status: 200, type: AppInfoDto })
  async app(): Promise<AppInfoDto> {
    const fee = await this.fees.global();

    return {
      currency: 'BOB',
      timezone: this.config.get('DEFAULT_TIMEZONE'),
      defaultLocale: 'es-BO',
      minAppVersion: this.config.get('MIN_APP_VERSION'),
      deepLinkScheme: this.config.get('APP_LINK_SCHEME'),
      // Solo la etiqueta: cuanto se cobra depende del subtotal y de la maraton,
      // y esa cuenta la hace `/pricing/quote`, que es la unica fuente del total.
      // Publicar aqui el porcentaje invitaria al cliente a calcularlo por su
      // cuenta, que es exactamente lo que el modulo de precios existe para
      // evitar.
      serviceFee: fee?.enabled ? { label: fee.label } : null,
      tracking: {
        maxAccuracyMeters: ACCURACY_MAXIMA_METROS,
        maxBatchesPerMinute: this.config.get('TRACKING_INGEST_BATCHES_PER_MINUTE'),
        suggestedBatchSeconds: SEGUNDOS_POR_LOTE,
      },
      limits: {
        avatarMaxBytes: this.config.get('AVATAR_MAX_BYTES'),
        requestsPerMinute: this.config.get('GLOBAL_RATE_LIMIT_PER_MINUTE'),
        shoeAlertThresholdMeters: UMBRAL_ZAPATILLA_METROS,
      },
      features: {
        gpsSimulation: !this.config.isProduction,
        liveTracking: true,
        // Los botones sociales son UI: la estrategia sigue siendo un stub.
        socialLogin: false,
      },
    };
  }
}
