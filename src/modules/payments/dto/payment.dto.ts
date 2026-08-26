import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, PaymentStatus } from '../../../../generated/prisma/enums';
import { RegistrationDto } from '../../registrations/dto/registration.dto';
import { ProofDto } from '../manual-qr/dto/proof.dto';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

// ─── Entrada ───────────────────────────────────────────────────────────────

/**
 * Datos de tarjeta. Viajan una sola vez, no se guardan y no se loguean: de
 * todo esto solo sobreviven `brand` y `last4`.
 */
export class CardDto {
  @ApiProperty({
    example: '4242424242424242',
    description:
      'Numero completo. Deterministas en el mock: 4242…4242 aprueba, 4000…0002 rechaza, ' +
      '4000…0069 responde tarjeta vencida.',
  })
  @IsString()
  @Matches(/^[\d\s-]{12,25}$/, { message: 'El numero de tarjeta no tiene un formato valido' })
  number!: string;

  @ApiProperty({ example: 'ALVARO QUISPE' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @trim()
  holder!: string;

  @ApiProperty({ example: 12, minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  expMonth!: number;

  @ApiProperty({ example: 2030 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  expYear!: number;

  @ApiProperty({ example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/, { message: 'El CVV son 3 o 4 digitos' })
  cvv!: string;
}

export class CheckoutDto {
  @ApiProperty({
    example: true,
    description: 'Tiene que ser exactamente `true`. Sin esto no hay inscripcion.',
  })
  @IsBoolean()
  @Equals(true, { message: 'Hay que aceptar los terminos y condiciones' })
  termsAccepted!: boolean;

  @ApiProperty({
    enum: PaymentMethod,
    example: PaymentMethod.card,
    description:
      '`card` resuelve en el acto. `qr` devuelve un PNG y queda `pending`: hay que sondear ' +
      '`GET /payments/:id`. `bank_transfer` devuelve los datos bancarios y espera confirmacion ' +
      'manual desde el panel.',
  })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({ type: CardDto, description: 'Obligatorio cuando `method` es `card`.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CardDto)
  card?: CardDto;
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class QrDetailsDto {
  @ApiProperty({
    example: 'http://localhost:3000/uploads/payments/qr/mock_pi_abc.png',
    description: 'PNG ya generado. La app lo muestra tal cual.',
  })
  imageUrl!: string;

  @ApiProperty({
    example: 'PACEUP-QR|mock_pi_abc|20000|BOB|reg_xyz',
    description: 'Lo que codifica el QR. Sirve para el boton de "copiar codigo".',
  })
  payload!: string;
}

export class BankDetailsDto {
  @ApiProperty({ example: 'Banco Nacional de Bolivia' })
  bankName!: string;

  @ApiProperty({ example: '1000-0000-0000' })
  accountNumber!: string;

  @ApiProperty({ example: 'Caja de ahorro' })
  accountType!: string;

  @ApiProperty({ example: 'PaceUp SRL' })
  holder!: string;

  @ApiProperty({ example: '0000000000' })
  nit!: string;

  @ApiProperty({
    example: 'PACEUP-A1B2C3D4',
    description: 'Glosa que hay que poner en la transferencia para identificarla',
  })
  reference!: string;
}

export class PaymentMethodDetailsDto {
  @ApiPropertyOptional({ example: 'visa', description: 'Solo en `card`' })
  brand?: string;

  @ApiPropertyOptional({ example: '4242', description: 'Lo unico del numero que se guarda' })
  last4?: string;

  @ApiPropertyOptional({ example: 'ALVARO QUISPE' })
  holder?: string;

  @ApiPropertyOptional({ type: QrDetailsDto, description: 'Solo en `qr`' })
  qr?: QrDetailsDto;

  @ApiPropertyOptional({ type: BankDetailsDto, description: 'Solo en `bank_transfer`' })
  bank?: BankDetailsDto;
}

export class PaymentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  registrationId!: string;

  @ApiProperty({ enum: PaymentMethod })
  method!: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiProperty({ example: 49000, description: 'Lo que se cobro, en centavos' })
  amountCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ type: PaymentMethodDetailsDto })
  methodDetails!: PaymentMethodDetailsDto;

  @ApiProperty({
    nullable: true,
    example: 'card_declined',
    description:
      'Motivo estable del rechazo: `card_declined`, `expired_card`, `invalid_card`, `qr_expired`',
  })
  failureReason!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Solo en metodos con caducidad (QR). Pasado, el cobro queda `failed`.',
  })
  expiresAt!: string | null;

  @ApiProperty({ nullable: true })
  paidAt!: string | null;

  @ApiProperty({ nullable: true })
  refundedAt!: string | null;

  @ApiProperty({
    type: ProofDto,
    nullable: true,
    description:
      'TEMPORAL — solo en el metodo `qr_manual`: el ultimo comprobante subido. Con ' +
      '`status: in_review` el cobro **sigue pendiente**: haber mandado la captura no es haber ' +
      'pagado. Ver `docs/pago-qr-manual.md`.',
  })
  proof?: ProofDto | null;

  @ApiProperty()
  createdAt!: string;
}

export class ReceiptDto {
  @ApiProperty({
    example: 'http://localhost:3000/uploads/payments/receipts/pay_abc.pdf',
    description: 'PDF ya generado. Estable: la misma URL devuelve siempre el mismo documento.',
  })
  url!: string;
}

/**
 * Lo que devuelve el checkout: el cobro y como quedo la inscripcion.
 *
 * Van juntos a proposito. Despues de pagar, la app tiene que pintar el dorsal y
 * el estado nuevo, y obligarla a una segunda llamada solo para eso deja una
 * ventana en la que el usuario ve "pagado" y "sin dorsal" a la vez.
 */
export class CheckoutResultDto {
  @ApiProperty({ type: PaymentDto })
  payment!: PaymentDto;

  @ApiProperty({ type: RegistrationDto })
  registration!: RegistrationDto;
}
