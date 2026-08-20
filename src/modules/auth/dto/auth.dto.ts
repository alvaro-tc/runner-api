import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Reglas de contrasena.
 *
 * Longitud minima 8 y al menos una letra y un numero. No se exigen simbolos ni
 * mayusculas obligatorias: las reglas barrocas empujan a la gente a
 * `Password1!` y a reutilizarla, que es peor que una frase larga.
 */
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
const PASSWORD_MESSAGE =
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

export class RegisterDto extends DeviceDto {
  @ApiProperty({ example: 'runner@test.com' })
  @IsEmail({}, { message: 'El email no tiene un formato valido' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  email!: string;

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
}

export class LoginDto extends DeviceDto {
  @ApiProperty({ example: 'runner@test.com' })
  @IsEmail({}, { message: 'El email no tiene un formato valido' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  email!: string;

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

  @ApiProperty()
  email!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['runner', 'admin'] })
  role!: string;

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
