import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Gender } from '../../../../generated/prisma/enums';

/** Quita espacios sobrantes sin romper cuando llega algo que no es texto. */
const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

// ─── Entrada ───────────────────────────────────────────────────────────────

/**
 * Todo opcional: es un PATCH y el cliente manda solo lo que cambio.
 *
 * `null` no es lo mismo que ausente. Enviar `city: null` **borra** la ciudad;
 * omitir `city` la deja como esta. Sin esta distincion no habria forma de
 * vaciar un campo opcional una vez lleno.
 */
export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'Alvaro Quispe' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @trim()
  name?: string;

  @ApiPropertyOptional({
    example: 'runner@test.com',
    description: 'Cambiarlo pone `emailVerifiedAt` en null: el nuevo buzon no esta verificado.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'El email no tiene un formato valido' })
  @MaxLength(254)
  @trim()
  email?: string;

  @ApiPropertyOptional({ example: 'La Paz', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @trim()
  city?: string | null;

  @ApiPropertyOptional({ example: 'BO', description: 'ISO-3166-1 alfa-2' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  country?: string;

  @ApiPropertyOptional({ example: '1995-04-17', nullable: true, description: 'Fecha ISO' })
  @IsOptional()
  @IsISO8601({ strict: true })
  birthDate?: string | null;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ example: 72000, description: 'Peso en gramos', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(20_000)
  @Max(400_000)
  weightGrams?: number | null;

  @ApiPropertyOptional({ example: 174, description: 'Altura en centimetros', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(80)
  @Max(260)
  heightCm?: number | null;

  @ApiPropertyOptional({ example: 'A-1234', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @trim()
  defaultBibNumber?: string | null;
}

/** Una lesion declarada. Es informativo: el backend no diagnostica nada. */
export class InjuryFlagDto {
  @ApiProperty({ example: 'rodilla_derecha' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @trim()
  zone!: string;

  @ApiPropertyOptional({ example: '2026-03-01', description: 'Desde cuando, fecha ISO' })
  @IsOptional()
  @IsISO8601({ strict: true })
  since?: string;

  @ApiPropertyOptional({ example: 'Molestia al bajar' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  @trim()
  notes?: string;
}

export class UpdateHealthDto {
  @ApiPropertyOptional({ type: [InjuryFlagDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => InjuryFlagDto)
  injuryFlags?: InjuryFlagDto[];

  @ApiPropertyOptional({ example: 420, description: 'Sueno medio en minutos', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  avgSleepMinutes?: number | null;

  @ApiPropertyOptional({ example: 'alta', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @trim()
  hydrationHabit?: string | null;
}

// ─── Salida (solo para que Swagger documente la forma) ─────────────────────

export class UserProfileDto {
  @ApiProperty({
    nullable: true,
    description: 'URL absoluta ya resuelta. En la BD se guarda solo la clave del archivo.',
  })
  avatarUrl!: string | null;

  @ApiProperty({ nullable: true })
  city!: string | null;

  @ApiProperty({ example: 'BO' })
  country!: string;

  @ApiProperty({ nullable: true, example: '1995-04-17' })
  birthDate!: string | null;

  @ApiProperty({ enum: Gender })
  gender!: Gender;

  @ApiProperty({ nullable: true, example: 72000 })
  weightGrams!: number | null;

  @ApiProperty({ nullable: true, example: 174 })
  heightCm!: number | null;

  @ApiProperty({ nullable: true })
  defaultBibNumber!: string | null;
}

export class MeDto {
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
    description: 'True = la contrasena la puso otro y hay que cambiarla antes de nada.',
  })
  mustChangePassword!: boolean;

  @ApiProperty({ nullable: true })
  emailVerifiedAt!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ type: UserProfileDto })
  profile!: UserProfileDto;
}

export class HealthProfileDto {
  @ApiProperty({ type: [InjuryFlagDto] })
  injuryFlags!: InjuryFlagDto[];

  @ApiProperty({ nullable: true, example: 420 })
  avgSleepMinutes!: number | null;

  @ApiProperty({ nullable: true, example: 'alta' })
  hydrationHabit!: string | null;
}

export class AvatarDto {
  @ApiProperty({ example: 'https://api.paceup.example/uploads/avatars/abc.webp' })
  avatarUrl!: string;
}

export class LongestWorkoutDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  startedAt!: string;

  @ApiProperty({ example: 21097 })
  distanceMeters!: number;

  @ApiProperty({ example: 7230 })
  durationSeconds!: number;

  @ApiProperty({ nullable: true, example: 343 })
  avgPaceSecPerKm!: number | null;
}

export class HighlightsDto {
  @ApiProperty({ description: 'Lunes 00:00 de la semana en curso, en la zona horaria del app' })
  weekStartsAt!: string;

  @ApiProperty({ description: 'Lunes 00:00 de la semana siguiente (limite exclusivo)' })
  weekEndsAt!: string;

  @ApiProperty({ example: 32400 })
  weekDistanceMeters!: number;

  @ApiProperty({ example: 4 })
  weekWorkouts!: number;

  @ApiProperty({ type: LongestWorkoutDto, nullable: true })
  longestWorkout!: LongestWorkoutDto | null;

  @ApiProperty({ example: 812400 })
  totalDistanceMeters!: number;

  @ApiProperty({ example: 96 })
  totalWorkouts!: number;
}
