import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { QuoteExtraDto } from '../../pricing/dto/quote.dto';
import { PersonalDataDto } from '../../registrations/dto/registration.dto';
import { ProofDto } from '../../payments/manual-qr/dto/proof.dto';

// --- Entrada -----------------------------------------------------------------

/**
 * TEMPORAL — inscripcion hecha desde la web publica, sin sesion.
 * Ver `docs/pago-qr-manual.md`.
 *
 * Reutiliza `PersonalDataDto` tal cual: son los mismos datos que pide la app, y
 * dos formularios que divergen es como se acaba con dos definiciones de "quien
 * corre". El `docId` de ahi **es la CI**, y es la clave con la que esto encuentra
 * —o crea— la cuenta.
 */
export class PublicRegistrationDto {
  @ApiProperty({ description: 'Id o slug de la maraton' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  marathonId!: string;

  @ApiProperty({ type: PersonalDataDto })
  @ValidateNested()
  @Type(() => PersonalDataDto)
  personalData!: PersonalDataDto;

  @ApiPropertyOptional({ description: 'Id de la categoria, si la carrera las tiene' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string | null;

  @ApiPropertyOptional({ type: [QuoteExtraDto], description: 'Seleccion completa de adicionales' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => QuoteExtraDto)
  extras?: QuoteExtraDto[];

  @ApiProperty({ example: true, description: 'Tiene que ser exactamente `true`.' })
  @IsBoolean()
  @Equals(true, { message: 'Hay que aceptar los terminos y condiciones' })
  termsAccepted!: boolean;
}

// --- Salida ------------------------------------------------------------------

/** Que paso con la cuenta del corredor. Es lo que la web tiene que contarle. */
export class PublicAccountDto {
  @ApiProperty({
    description:
      'True = la cuenta se creo ahora. False = ya existia (se inscribio antes, o se registro ' +
      'en la app) y esta inscripcion se colgo de ella.',
  })
  created!: boolean;

  @ApiProperty({
    example: '1234567LP',
    description: 'Con que entra en la app. Es su CI normalizada.',
  })
  username!: string;

  @ApiProperty({
    description:
      'True = la contrasena inicial **es su CI** y la app le va a exigir cambiarla la primera ' +
      'vez. La web tiene que decirselo: es la unica vez que alguien se lo va a contar.',
  })
  mustChangePassword!: boolean;
}

export class PublicQrDto {
  @ApiProperty({ example: 'https://api.paceup.app/uploads/qr/maraton.png' })
  imageUrl!: string;

  @ApiProperty({ nullable: true })
  instructions!: string | null;

  @ApiProperty({
    example: 'PU-A1B2C3',
    description: 'Glosa que el corredor tiene que poner en la transferencia.',
  })
  reference!: string;
}

export class PublicRegistrationResultDto {
  @ApiProperty()
  registrationId!: string;

  @ApiProperty({
    description:
      'Token opaco. **Se devuelve una sola vez**: guardalo, es lo que autoriza a subir el ' +
      'comprobante y a consultar el estado sin sesion.',
  })
  publicToken!: string;

  @ApiProperty()
  paymentId!: string;

  @ApiProperty({ example: 'pending' })
  paymentStatus!: string;

  @ApiProperty({ example: 49000, description: 'Centavos. Lo calculo el servidor.' })
  totalCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ type: PublicQrDto })
  qr!: PublicQrDto;

  @ApiProperty({ nullable: true, description: 'Cuando caduca el cobro si nadie sube comprobante' })
  expiresAt!: string | null;

  @ApiProperty({ type: PublicAccountDto })
  account!: PublicAccountDto;
}

export class PublicRegistrationStatusDto {
  @ApiProperty()
  registrationId!: string;

  @ApiProperty({ example: 'pending_payment' })
  registrationStatus!: string;

  @ApiProperty({ nullable: true, example: 'MLP-0042' })
  bibNumber!: string | null;

  @ApiProperty({ example: 'pending' })
  paymentStatus!: string;

  @ApiProperty({ type: ProofDto, nullable: true })
  proof!: ProofDto | null;
}
