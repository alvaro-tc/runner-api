import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AccessTokenPayload, DeviceInfo } from './token.service';
import { DISPOSITIVO_DESCONOCIDO } from '../../common/devices';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import {
  AuthSessionResponseDto,
  AuthUserDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  SessionDto,
  TokenPairDto,
} from './dto/auth.dto';

/**
 * Limite estricto para los endpoints que aceptan credenciales.
 *
 * Sin esto, `/login` es un oraculo de fuerza bruta: argon2 encarece cada
 * intento pero no impide diez mil. 10 intentos por minuto por IP no molesta a
 * nadie que escriba mal la clave y corta el ataque automatizado.
 *
 * El valor se lee de `process.env` y no de `AppConfigService` porque `@Throttle`
 * es un decorador: se evalua al cargar la clase, cuando todavia no existe el
 * contenedor de inyeccion. `env.schema.ts` sigue siendo quien lo valida.
 */
const LIMITE_CREDENCIALES = {
  corto: {
    limit: Number(process.env['AUTH_RATE_LIMIT_PER_MINUTE'] ?? 10),
    ttl: 60_000,
  },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @Throttle(LIMITE_CREDENCIALES)
  @ApiOperation({ summary: 'Crea una cuenta y devuelve la sesion iniciada' })
  @ApiResponse({ status: 201, type: AuthSessionResponseDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'EMAIL_ALREADY_REGISTERED' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, this.device(dto, req));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(LIMITE_CREDENCIALES)
  @ApiOperation({ summary: 'Inicia sesion en un dispositivo' })
  @ApiResponse({ status: 200, type: AuthSessionResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'INVALID_CREDENTIALS' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.device(dto, req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rota el refresh token',
    description:
      'Invalida el token usado y emite uno nuevo con 60 dias desde ahora. Si llega un token ' +
      'ya rotado responde TOKEN_REUSE_DETECTED y revoca todas las sesiones del dispositivo.',
  })
  @ApiResponse({ status: 200, type: TokenPairDto })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: 'INVALID_REFRESH_TOKEN o TOKEN_REUSE_DETECTED',
  })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, this.device(dto, req));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cierra la sesion de este dispositivo',
    description: 'Idempotente: cerrar una sesion ya cerrada responde ok igual.',
  })
  logout(@Body() dto: LogoutDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('sessions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Lista los dispositivos con sesion activa' })
  @ApiResponse({ status: 200, type: [SessionDto] })
  sessions(@CurrentUser() user: AccessTokenPayload) {
    return this.auth.listSessions(user.sub, user.sessionId);
  }

  @Delete('sessions/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cierra la sesion de otro dispositivo' })
  revokeSession(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.auth.revokeSession(userId, id);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle(LIMITE_CREDENCIALES)
  @ApiOperation({
    summary: 'Pide un enlace de recuperacion',
    description:
      'Responde siempre lo mismo, exista el email o no: si distinguiera, seria un comprobador ' +
      'gratuito de quien tiene cuenta.',
  })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle(LIMITE_CREDENCIALES)
  @ApiOperation({
    summary: 'Cambia la contrasena con el token del correo',
    description: 'Cierra TODAS las sesiones del usuario: si alguien habia entrado, queda fuera.',
  })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @Throttle(LIMITE_CREDENCIALES)
  @ApiOperation({
    summary: 'Cambia la contrasena con la sesion abierta',
    description:
      'Obligatorio cuando `/auth/me` devuelve `mustChangePassword: true` (alta desde la web: ' +
      'usuario CI, contrasena CI). Cierra **las demas** sesiones y deja viva la actual.',
  })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'INVALID_CREDENTIALS' })
  changePassword(@CurrentUser() user: AccessTokenPayload, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.sub, user.sessionId, dto);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Datos del usuario autenticado' })
  @ApiResponse({ status: 200, type: AuthUserDto })
  me(@CurrentUser('sub') userId: string) {
    return this.auth.me(userId);
  }

  /** Junta lo que declara el cliente con lo que se ve de la conexion. */
  private device(
    dto: { deviceId?: string; deviceName?: string; platform?: string },
    req: Request,
  ): DeviceInfo {
    return {
      deviceId: dto.deviceId ?? DISPOSITIVO_DESCONOCIDO,
      deviceName: dto.deviceName,
      platform: dto.platform,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
  }
}
