import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, Matches } from 'class-validator';
import { Theme, Units } from '../../../../generated/prisma/enums';

export class UpdatePreferencesDto {
  @ApiPropertyOptional({ enum: Units })
  @IsOptional()
  @IsEnum(Units)
  units?: Units;

  @ApiPropertyOptional({ enum: Theme })
  @IsOptional()
  @IsEnum(Theme)
  theme?: Theme;

  @ApiPropertyOptional({ example: 'es-BO', description: 'Etiqueta BCP-47' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/, { message: 'locale debe ser una etiqueta BCP-47' })
  locale?: string;

  /**
   * Objetos libres a proposito: son banderas del cliente (`push`, `email`,
   * `raceReminders`, `shareWorkouts`...) y cada version de la app agrega las
   * suyas. Validarlas campo a campo obligaria a migrar el backend cada vez que
   * la app suma un toggle. Se hace un merge superficial, no un reemplazo.
   */
  @ApiPropertyOptional({ example: { push: true, raceReminders: false } })
  @IsOptional()
  @IsObject()
  notifications?: Record<string, unknown>;

  @ApiPropertyOptional({ example: { shareWorkouts: true, liveTrackingOptIn: false } })
  @IsOptional()
  @IsObject()
  privacy?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: true,
    description:
      'true marca el onboarding como visto (con la hora del servidor). false lo reabre, para ' +
      'poder volver a mostrar los slides desde ajustes.',
  })
  @IsOptional()
  @IsBoolean()
  onboardingSeen?: boolean;
}

export class PreferencesDto {
  @ApiProperty({ enum: Units })
  units!: Units;

  @ApiProperty({ enum: Theme })
  theme!: Theme;

  @ApiProperty({ example: 'es-BO' })
  locale!: string;

  @ApiProperty({ example: { push: true } })
  notifications!: Record<string, unknown>;

  @ApiProperty({ example: { shareWorkouts: true } })
  privacy!: Record<string, unknown>;

  @ApiProperty({ nullable: true })
  onboardingSeenAt!: string | null;
}
