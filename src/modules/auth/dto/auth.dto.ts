import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Gender } from '../../../../generated/prisma/enums';

/**
 * Reglas de contrasena.
 *
 * Longitud minima 8 y al menos una letra y un numero. No se exigen simbolos ni
 * mayusculas obligatorias: las reglas barrocas empujan a la gente a
 * `Password1!` y a reutilizarla, que es peor que una frase larga.
 *
 * Se exportan porque el panel de admin da de alta cuentas y resetea
 * contrasenas: una segunda regla, aunque sea mas laxa por descuido, seria una
 * puerta de atras a la politica de contrasenas de la app.
 */
export const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
export const PASSWORD_MESSAGE =
  'La contrasena debe tener al menos 8 caracteres, con al menos una letra y un numero';

/** Identifica el dispositivo. La app lo persiste y lo manda siempre. */
export class DeviceDto {
  @ApiProperty({ example: '9f1c8d2e-4b7a-4c11-9f3e-2a1b5c6d7e8f' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  deviceId!: string;

  @ApiPropertyOptional({ example: 'Pixel 8 de Alvaro' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;

  @ApiPropertyOptional({ example: 'android' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;
}

/**
 * Alta de cuenta. Hace falta **email o CI**, no los dos.
 *
 * El email es opcional porque hay corredores que no tienen o no lo quieren dar,
 * y la inscripcion no puede depender de eso. La CI es la otra credencial: es lo
 * que permite entrar en la app a quien se dio de alta desde la web, y lo que
 * cruza un pago hecho en la web con la cuenta que ya existia en la app.
 *
 * `@ValidateIf` es lo que hace que "uno de los dos" sea una regla de verdad y
 * no un comentario: sin CI, el email pasa a ser obligatorio y al reves.
 */
export class RegisterDto extends DeviceDto {
  @ApiPropertyOptional({
    example: 'runner@test.com',
    description: 'Opcional si mandas `ci`.',
  })
  @ValidateIf((o: RegisterDto) => !o.ci || o.email !== undefined)
  @IsEmail({}, { message: 'El email no tiene un formato valido' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  email?: string;

  @ApiPropertyOptional({
    example: '1234567 LP',
    description:
      'Cedula de identidad. Opcional si mandas `email`. Se guarda normalizada ' +
      '(sin espacios ni guiones, en mayusculas), asi que `1234567 lp` y `1234567-LP` son la misma.',
  })
  @ValidateIf((o: RegisterDto) => !o.email || o.ci !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'Hace falta un email o una CI' })
  @MaxLength(40)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  ci?: string;

  @ApiProperty({ example: 'Test1234!', minLength: 8 })
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password!: string;

  @ApiProperty({ example: 'Alvaro Quispe' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiPropertyOptional({ example: '1995-04-17', description: 'Fecha ISO. Va al perfil.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  birthDate?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;
}

/**
 * Un solo campo para las dos credenciales.
 *
 * Se decide que es por el `@`, no preguntando a la base. Dos campos ("email" y
 * "CI") obligarian al usuario a saber con cual se dio de alta, que es
 * exactamente lo que no recuerda.
 */
export class LoginDto extends DeviceDto {
  @ApiProperty({
    example: 'runner@test.com',
    description: 'Email o CI. Con `@` se trata como email; sin `@`, como CI.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  identifier!: string;

  @ApiProperty({ example: 'Test1234!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export class RefreshDto extends DeviceDto {
  @ApiProperty({ description: 'El refresh token entregado en el login o en el refresh anterior' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refreshToken!: string;
}

export class LogoutDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refreshToken!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'runner@test.com' })
  @IsEmail({}, { message: 'El email no tiene un formato valido' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'El token que viaja en el enlace del correo' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token!: string;

  @ApiProperty({ example: 'NuevaClave123', minLength: 8 })
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password!: string;
}

/**
 * Cambio de contrasena con sesion abierta.
 *
 * Existe por el alta desde la web: ahi la contrasena inicial **es la CI**, que
 * la sabe cualquiera que vea el documento. `mustChangePassword` obliga a pasar
 * por aqui antes de nada. Pide la actual aunque haya token: un telefono
 * desbloqueado un minuto no puede convertirse en un cambio de credenciales.
 */
export class ChangePasswordDto {
  @ApiProperty({ description: 'La contrasena actual. En un alta desde la web, la CI.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({ example: 'NuevaClave123', minLength: 8 })
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  newPassword!: string;
}

// ─── Respuestas (solo para que Swagger las documente) ──────────────────────

export class TokenPairDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ description: 'Cadena opaca. Guardala en flutter_secure_storage.' })
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'Segundos de vida del access token' })
  expiresIn!: number;
}

export class AuthUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true, description: 'Null si la cuenta se dio de alta solo con CI.' })
  email!: string | null;

  @ApiProperty({ nullable: true, example: '1234567LP', description: 'CI normalizada.' })
  ci!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['runner', 'organizer', 'admin'] })
  role!: string;

  @ApiProperty({
    description:
      'True cuando la contrasena la puso otro (alta desde la web: usuario CI, contrasena CI). ' +
      'La app tiene que mandar al usuario a cambiarla antes de dejarle usar nada.',
  })
  mustChangePassword!: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Null = el usuario aun no vio el onboarding. Sobrevive a reinstalaciones.',
  })
  onboardingSeenAt!: string | null;
}

export class AuthSessionResponseDto extends TokenPairDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class SessionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  deviceId!: string;

  @ApiProperty({ nullable: true })
  deviceName!: string | null;

  @ApiProperty({ nullable: true })
  platform!: string | null;

  @ApiProperty()
  lastUsedAt!: string;

  @ApiProperty()
  expiresAt!: string;

  @ApiProperty({ description: 'True si es la sesion desde la que estas llamando' })
  current!: boolean;
}
