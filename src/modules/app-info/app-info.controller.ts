import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  Controller,
  Get,
  HttpStatus,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { StorageService } from '../storage/storage.service';
import { ACCURACY_MAXIMA_METROS } from '../workouts/metrics';
import { ServiceFeeConfigService } from '../pricing/service-fee.service';
import { AppInfoDto } from './dto/app-info.dto';

/** Umbral de desgaste por defecto de una zapatilla: el mismo que el default de
 *  la columna en `schema.prisma` (800 km). */
const UMBRAL_ZAPATILLA_METROS = 800_000;

/** Cada cuanto conviene drenar la cola de posiciones. Ver `docs/tracking.md`. */
const SEGUNDOS_POR_LOTE = 30;

/** Carpeta de `UPLOADS_DIR` donde vive el APK de Android. */
const CARPETA_APK = 'app';
const TOPE_APK = 200 * 1024 * 1024;

@ApiTags('config')
@Controller('config')
export class AppInfoController {
  constructor(
    private readonly config: AppConfigService,
    private readonly fees: ServiceFeeConfigService,
    private readonly storage: StorageService,
  ) {}

  @Get('app/apk')
  @Public()
  @ApiOperation({
    summary: 'Descargar el APK de Android más reciente',
    description:
      'Redirige (302) al último APK subido. Es la URL estable del QR y del botón de la web: ' +
      'cada subida lleva nombre nuevo porque `/uploads` se cachea como inmutable.',
  })
  async descargarApk(@Res() res: Response): Promise<void> {
    const actual = await this.apkActual();
    if (!actual) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Aún no se subió el APK', HttpStatus.NOT_FOUND);
    }

    // La redireccion no se cachea: si no, el telefono seguiria bajando la version vieja.
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, actual.url);
  }

  @Get('app/apk/info')
  @ApiBearerAuth('access-token')
  @Roles('admin')
  @ApiOperation({ summary: 'Datos del APK publicado (o null si no hay)' })
  infoApk() {
    return this.apkActual();
  }

  @Post('app/apk')
  @ApiBearerAuth('access-token')
  @Roles('admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: TOPE_APK, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Publicar una versión nueva del APK',
    description: 'Reemplaza al anterior: `GET /config/app/apk` pasa a apuntar a este.',
  })
  async subirApk(@UploadedFile() file?: Express.Multer.File) {
    // Un APK es un ZIP: sin la firma de ZIP (bytes 50 4B 03 04) no es un APK, se llame como se llame.
    const esZip = file?.buffer?.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (!file || !esZip || !/\.apk$/i.test(file.originalname)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Falta el archivo en el campo `file` o no es un .apk válido',
        HttpStatus.BAD_REQUEST,
      );
    }

    const anteriores = await this.apks();
    await this.storage.save(`${CARPETA_APK}/cam-run-${Date.now()}.apk`, file.buffer);
    await Promise.all(anteriores.map((n) => this.storage.delete(`${CARPETA_APK}/${n}`)));

    return this.apkActual();
  }

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

  /**
   * ponytail: lee el directorio del driver local en vez de guardar la clave en
   * la BD. Con S3 habria que listar el bucket o persistir la clave.
   */
  private async apks(): Promise<string[]> {
    const dir = join(resolve(this.config.get('UPLOADS_DIR')), CARPETA_APK);
    const nombres = await readdir(dir).catch(() => [] as string[]);
    // El timestamp va en el nombre: el orden alfabetico es el cronologico.
    return nombres.filter((n) => n.endsWith('.apk')).sort();
  }

  private async apkActual() {
    const nombre = (await this.apks()).at(-1);
    if (!nombre) return null;

    const clave = `${CARPETA_APK}/${nombre}`;
    const info = await stat(join(resolve(this.config.get('UPLOADS_DIR')), clave));

    return { url: this.storage.url(clave), bytes: info.size, uploadedAt: info.mtime.toISOString() };
  }
}
