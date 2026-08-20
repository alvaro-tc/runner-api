import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
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
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AvatarService } from './avatar.service';
import { UsersService } from './users.service';
import {
  AvatarDto,
  HealthProfileDto,
  HighlightsDto,
  MeDto,
  UpdateHealthDto,
  UpdateMeDto,
} from './dto/user.dto';
import { PreferencesDto, UpdatePreferencesDto } from './dto/preferences.dto';

/**
 * Corte duro del multipart, antes de que el archivo entre en memoria.
 *
 * Se lee de `process.env` y no de `AppConfigService` porque `@UseInterceptors`
 * es un decorador: se evalua al cargar la clase, cuando todavia no existe el
 * contenedor de inyeccion. `env.schema.ts` sigue siendo quien valida el valor,
 * y `AvatarService` lo vuelve a comprobar con la config tipada.
 */
const AVATAR_MAX_BYTES = Number(process.env['AVATAR_MAX_BYTES'] ?? 5 * 1024 * 1024);

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('users/me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly avatars: AvatarService,
  ) {}

  // ─── Perfil ──────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Perfil completo del usuario autenticado',
    description:
      'No incluye los campos de salud ni las preferencias: viven en /users/me/health y ' +
      '/users/me/preferences, que la app pide solo cuando abre esas pantallas.',
  })
  @ApiResponse({ status: 200, type: MeDto })
  getMe(@CurrentUser('sub') userId: string) {
    return this.users.getMe(userId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Actualiza datos personales',
    description:
      'PATCH parcial. Mandar `null` en un campo opcional lo vacia; omitirlo lo deja como esta.',
  })
  @ApiResponse({ status: 200, type: MeDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'EMAIL_ALREADY_REGISTERED' })
  updateMe(@CurrentUser('sub') userId: string, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(userId, dto);
  }

  // ─── Avatar ──────────────────────────────────────────────────────────────

  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Sube o reemplaza el avatar',
    description:
      'Campo `file`, maximo 5 MB. Se valida decodificando la imagen (no por Content-Type), se ' +
      'recorta a cuadrado y se reencoda a WebP, lo que ademas elimina el EXIF con la ubicacion.',
  })
  @ApiResponse({ status: 201, type: AvatarDto })
  @ApiResponse({ status: 413, type: ErrorResponseDto, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 415, type: ErrorResponseDto, description: 'INVALID_IMAGE' })
  async uploadAvatar(
    @CurrentUser('sub') userId: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<AvatarDto> {
    if (!file) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Falta el archivo en el campo `file`',
        HttpStatus.BAD_REQUEST,
      );
    }

    return { avatarUrl: await this.avatars.replace(userId, file) };
  }

  @Delete('avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Quita el avatar. Idempotente: sin avatar responde ok igual.' })
  async removeAvatar(@CurrentUser('sub') userId: string): Promise<{ ok: true }> {
    await this.avatars.remove(userId);
    return { ok: true };
  }

  // ─── Preferencias ────────────────────────────────────────────────────────

  @Get('preferences')
  @ApiOperation({ summary: 'Unidades, tema, idioma, notificaciones, privacidad y onboarding' })
  @ApiResponse({ status: 200, type: PreferencesDto })
  getPreferences(@CurrentUser('sub') userId: string) {
    return this.users.getPreferences(userId);
  }

  @Patch('preferences')
  @ApiOperation({
    summary: 'Actualiza preferencias',
    description:
      '`notifications` y `privacy` se mezclan con lo guardado, no lo reemplazan: una app vieja ' +
      'no borra las banderas que todavia no conoce.',
  })
  @ApiResponse({ status: 200, type: PreferencesDto })
  updatePreferences(@CurrentUser('sub') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.users.updatePreferences(userId, dto);
  }

  // ─── Salud ───────────────────────────────────────────────────────────────

  @Get('health')
  @ApiOperation({ summary: 'Lesiones declaradas, sueno e hidratacion' })
  @ApiResponse({ status: 200, type: HealthProfileDto })
  getHealth(@CurrentUser('sub') userId: string) {
    return this.users.getHealth(userId);
  }

  @Patch('health')
  @ApiOperation({
    summary: 'Actualiza los datos de salud',
    description: '`injuryFlags` reemplaza la lista entera: es una lista editable, no un merge.',
  })
  @ApiResponse({ status: 200, type: HealthProfileDto })
  updateHealth(@CurrentUser('sub') userId: string, @Body() dto: UpdateHealthDto) {
    return this.users.updateHealth(userId, dto);
  }

  // ─── Borrado de cuenta ───────────────────────────────────────────────────

  @Delete('data')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Borra la cuenta y todos sus datos',
    description:
      'Irreversible y sin papelera. Cancela primero las inscripciones a carreras que todavia no ' +
      'ocurrieron —para que el cupo vuelva al organizador— y despues borra en cascada perfil, ' +
      'entrenamientos, posiciones GPS, planes, sesiones y archivos subidos. Las sesiones se van ' +
      'con el usuario, asi que no hay refresh posible; el access token que ya estuviera en la ' +
      'calle caduca solo en 15 minutos y mientras tanto no resuelve a nadie.',
  })
  @ApiResponse({ status: 200, description: 'La cuenta ya no existe' })
  deleteAccount(@CurrentUser('sub') userId: string): Promise<{ ok: true }> {
    return this.users.borrarCuenta(userId);
  }

  // ─── Highlights ──────────────────────────────────────────────────────────

  @Get('highlights')
  @ApiOperation({
    summary: 'Kilometraje de la semana y carrera mas larga',
    description:
      'La semana es Lunes-Domingo en la zona horaria de la app (DEFAULT_TIMEZONE), no en UTC: ' +
      'en La Paz, correr un domingo por la noche caeria en la semana siguiente si fuera UTC.',
  })
  @ApiResponse({ status: 200, type: HighlightsDto })
  getHighlights(@CurrentUser('sub') userId: string) {
    return this.users.getHighlights(userId);
  }
}
