import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { RegistrationStatus } from '../../../../generated/prisma/enums';
import { QuoteExtraDto, QuoteLineDto, ServiceFeeLineDto } from '../../pricing/dto/quote.dto';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

// ─── Entrada ───────────────────────────────────────────────────────────────

/**
 * Datos del corredor para la carrera.
 *
 * Se piden aunque el perfil ya tenga nombre: el que corre puede no ser el que
 * tiene la cuenta (un padre inscribiendo a un hijo), y el contacto de
 * emergencia es informacion de carrera, no de perfil.
 */
export class PersonalDataDto {
  @ApiProperty({ example: 'Alvaro Quispe Mamani' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  @trim()
  fullName!: string;

  @ApiProperty({ example: '1234567 LP', description: 'Documento de identidad' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  @trim()
  docId!: string;

  @ApiPropertyOptional({ example: '+591 70000000' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @trim()
  phone?: string;

  @ApiPropertyOptional({ example: 'Maria Quispe' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @trim()
  emergencyContactName?: string;

  @ApiPropertyOptional({ example: '+591 70000001' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @trim()
  emergencyContactPhone?: string;

  @ApiPropertyOptional({ example: 'O+' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @trim()
  bloodType?: string;

  @ApiPropertyOptional({ example: 'M', description: 'Talla de remera' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @trim()
  shirtSize?: string;
}

export class CreateRegistrationDto {
  @ApiProperty({ description: 'Id o slug de la maraton' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  marathonId!: string;

  @ApiProperty({ type: PersonalDataDto })
  @ValidateNested()
  @Type(() => PersonalDataDto)
  personalData!: PersonalDataDto;
}

export class UpdateCategoryExtrasDto {
  @ApiPropertyOptional({
    description: 'Id de la categoria. `null` la quita.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string | null;

  @ApiPropertyOptional({
    type: [QuoteExtraDto],
    description: 'Lista completa: reemplaza a la anterior. `[]` deja la inscripcion sin extras.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => QuoteExtraDto)
  extras?: QuoteExtraDto[];
}

export class ListRegistrationsQueryDto {
  @ApiPropertyOptional({ enum: RegistrationStatus })
  @IsOptional()
  @IsEnum(RegistrationStatus)
  status?: RegistrationStatus;

  @ApiPropertyOptional({ description: 'Id o slug de la maraton, para retomar un borrador' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  marathonId?: string;
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class RegistrationMarathonDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  startsAt!: string;

  @ApiProperty()
  timezone!: string;

  @ApiProperty()
  city!: string;

  @ApiProperty()
  distanceMeters!: number;
}

export class RegistrationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: RegistrationMarathonDto })
  marathon!: RegistrationMarathonDto;

  @ApiProperty({ enum: RegistrationStatus })
  status!: RegistrationStatus;

  @ApiProperty({ example: 2, description: 'Paso 1..3, para retomar el flujo donde se dejo' })
  step!: number;

  @ApiProperty({ nullable: true, example: 'MLP-0042', description: 'Se asigna al confirmar' })
  bibNumber!: string | null;

  @ApiProperty({ nullable: true })
  categoryId!: string | null;

  @ApiProperty({ type: PersonalDataDto })
  personalData!: unknown;

  @ApiProperty({
    example: [{ extraId: 'ext_...', name: 'Remera', quantity: 1, priceCents: 12000 }],
  })
  extras!: unknown;

  @ApiProperty({ type: [QuoteLineDto], description: 'Desglose vigente, recalculado al leer' })
  items!: QuoteLineDto[];

  @ApiProperty({ example: 49000 })
  subtotalCents!: number;

  @ApiProperty({ type: ServiceFeeLineDto, nullable: true, description: 'null = no se pinta linea' })
  serviceFee!: ServiceFeeLineDto | null;

  @ApiProperty({ example: 49000 })
  totalCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ nullable: true })
  termsAcceptedAt!: string | null;

  @ApiProperty({ nullable: true })
  registeredAt!: string | null;

  @ApiProperty({ nullable: true })
  cancelledAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}
