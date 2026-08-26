import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { Public } from '../auth/decorators/public.decorator';
import { ProofDto } from '../payments/manual-qr/dto/proof.dto';
import { PublicRegistrationService } from './public-registration.service';
import {
  PublicRegistrationDto,
  PublicRegistrationResultDto,
  PublicRegistrationStatusDto,
} from './dto/public-registration.dto';

/**
 * Techo apretado. Este endpoint **crea cuentas sin token**, asi que sin limite
 * es una fabrica de usuarios: 5 por minuto por IP no molesta a nadie que se
 * este inscribiendo y corta el guion automatizado.
 */
const LIMITE_PUBLICO = { corto: { limit: 5, ttl: 60_000 } };

/** Cabecera con la que la web presenta su token. Tambien se acepta `?token=`. */
const CABECERA_TOKEN = 'X-Public-Token';

/** Segunda linea del limite de subida; el mensaje bueno lo da el servicio. */
const TOPE_MULTIPART = 12 * 1024 * 1024;

/**
 * TEMPORAL — inscripcion desde la web publica. Ver `docs/pago-qr-manual.md`.
 *
 * Es el unico sitio de la API donde se inscribe alguien sin sesion, y existe
 * por un motivo concreto: la web de inscripcion tiene que funcionar para quien
 * nunca instalo la app. La contrapartida es que **crea cuentas**, y por eso
 * lleva su propio limite, su propio interruptor (`PUBLIC_REGISTRATION_ENABLED`)
 * y su propia autorizacion por token de un solo recurso.
 */
@ApiTags('public')
@Public()
@Throttle(LIMITE_PUBLICO)
@Controller('public/registrations')
export class PublicRegistrationController {
  constructor(private readonly publico: PublicRegistrationService) {}

  @Post()
  @ApiOperation({
    summary: 'Inscribe a un corredor desde la web y abre el cobro por QR',
    description:
      'Identifica al corredor por su **CI**: si ya tenia cuenta en la app se cuelga de ella, y ' +
      'si no, se le crea una con usuario y contrasena iguales a su CI (la app le exigira ' +
      'cambiarla). Devuelve el QR del organizador y un `publicToken` que **solo se entrega ' +
      'aqui**: es lo que despues autoriza a subir el comprobante.',
  })
  @ApiResponse({ status: 201, type: PublicRegistrationResultDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'ALREADY_REGISTERED / MARATHON_FULL / REGISTRATION_CLOSED / QR_NOT_CONFIGURED',
  })
  inscribir(@Body() dto: PublicRegistrationDto) {
    return this.publico.inscribir(dto);
  }

  @Post(':id/proof')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: TOPE_MULTIPART, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: CABECERA_TOKEN, required: false, description: 'El `publicToken` del alta' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        reference: { type: 'string', example: '00123456789' },
      },
    },
  })
  @ApiOperation({
    summary: 'Sube el comprobante del pago',
    description:
      'El cobro **sigue pendiente**: queda `in_review` hasta que un organizador lo apruebe. ' +
      'Un token que no cuadra responde 404, igual que una inscripcion que no existe.',
  })
  @ApiResponse({ status: 201, type: ProofDto })
  subirComprobante(
    @Param('id') id: string,
    @Body('reference') reference: string | undefined,
    @Headers(CABECERA_TOKEN.toLowerCase()) cabecera?: string,
    @Query('token') query?: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Falta el archivo en el campo `file`',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.publico.subirComprobante(id, this.token(cabecera, query), file, reference);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: CABECERA_TOKEN, required: false, description: 'El `publicToken` del alta' })
  @ApiOperation({
    summary: 'Estado de la inscripcion y del comprobante',
    description:
      'Lo que la web sondea despues de subir el comprobante: `paymentStatus` pasa a `paid` y ' +
      'aparece el dorsal cuando el organizador aprueba.',
  })
  @ApiResponse({ status: 200, type: PublicRegistrationStatusDto })
  estado(
    @Param('id') id: string,
    @Headers(CABECERA_TOKEN.toLowerCase()) cabecera?: string,
    @Query('token') query?: string,
  ) {
    return this.publico.estado(id, this.token(cabecera, query));
  }

  /**
   * Cabecera primero, query despues.
   *
   * El query existe porque una pagina que abre un enlace de vuelta no siempre
   * puede poner cabeceras; la cabecera se prefiere porque no acaba en los logs
   * del servidor ni en el historial del navegador.
   */
  private token(cabecera?: string, query?: string): string {
    const token = cabecera ?? query;

    if (!token) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No se encontro esa inscripcion',
        HttpStatus.NOT_FOUND,
      );
    }

    return token;
  }
}
