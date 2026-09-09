import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  Gender,
  MarathonRegistrationStatus,
  ServiceFeeType,
  UserRole,
} from '../../../../generated/prisma/enums';
import { PASSWORD_MESSAGE, PASSWORD_REGEX } from '../../auth/dto/auth.dto';

/**
 * Slug de maraton: minusculas, numeros y guiones.
 *
 * Es parte de la URL publica y de los enlaces que ya se compartieron, asi que
 * no puede admitir espacios, acentos ni mayusculas: un slug que cambia de forma
 * segun quien lo escriba rompe enlaces que ya estan en WhatsApp.
 */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─── Cargo por servicio ────────────────────────────────────────────────────

export class ServiceFeeConfigDto {
  @ApiProperty({
    description:
      'Interruptor maestro. En `false` el total no lleva cargo **y la línea no se muestra**: ' +
      'un "Bs 0,00" le promete al usuario un cargo que hoy no se le cobra.',
  })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ enum: ServiceFeeType, example: 'percent' })
  @IsEnum(ServiceFeeType)
  type!: ServiceFeeType;

  @ApiPropertyOptional({ example: 1000, description: 'Puntos básicos: 1000 = 10%' })
  @IsOptional()
  @IsInt()
  @Min(0)
  percentBps?: number | null;

  @ApiPropertyOptional({ example: 500, description: 'Parte fija, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  fixedCents?: number | null;

  @ApiPropertyOptional({ example: 500, description: 'Suelo del cargo, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minCents?: number | null;

  @ApiPropertyOptional({ example: 5000, description: 'Techo del cargo, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxCents?: number | null;

  @ApiPropertyOptional({ example: 'Cargo por servicio' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class FeePreviewQueryDto {
  @ApiPropertyOptional({ example: 20_000, description: 'Subtotal de ejemplo, en centavos' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  subtotalCents?: number;

  @ApiPropertyOptional({ description: 'Sin esto se previsualiza la config global' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  marathonId?: string;
}

// ─── Resultados de carrera ─────────────────────────────────────────────────

export class RaceResultRowDto {
  @ApiProperty({ example: 'MLP-0042', description: 'Dorsal, que es como llegan los tiempos' })
  @IsString()
  @MaxLength(40)
  bibNumber!: string;

  @ApiProperty({ example: 13_140, description: 'Tiempo oficial desde la largada, en segundos' })
  @IsInt()
  @Min(1)
  finishTimeSeconds!: number;

  @ApiPropertyOptional({ example: 13_020, description: 'Tiempo de chip, si hubo cronometraje' })
  @IsOptional()
  @IsInt()
  @Min(1)
  chipTimeSeconds?: number;

  @ApiPropertyOptional({ example: 42_195, description: 'Por defecto, la distancia de la maratón' })
  @IsOptional()
  @IsInt()
  @Min(1)
  distanceMeters?: number;

  @ApiPropertyOptional({ description: 'Hora de llegada. Por defecto, largada + tiempo oficial' })
  @IsOptional()
  @IsISO8601()
  finishedAt?: string;
}

export class ImportResultsDto {
  @ApiProperty({ type: [RaceResultRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RaceResultRowDto)
  results!: RaceResultRowDto[];
}

// ─── Pago por transferencia ────────────────────────────────────────────────

/**
 * El motivo de una devolucion. **Obligatorio**: devolver anula la inscripcion
 * de alguien, y un asiento sin motivo no se puede auditar seis meses despues.
 */
export class RefundPaymentDto {
  @ApiProperty({ example: 'La carrera se suspendio por lluvia' })
  @IsString()
  @IsNotEmpty({ message: 'Hace falta decir por que se devuelve' })
  @MaxLength(300)
  reason!: string;
}

export class ConfirmTransferDto {
  @ApiPropertyOptional({
    example: 'BNB-88213',
    description: 'Referencia del comprobante bancario. Queda en `methodDetails`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

// ─── Salidas ───────────────────────────────────────────────────────────────

export class FeePreviewDto {
  @ApiProperty({ example: 20_000 })
  subtotalCents!: number;

  @ApiProperty({ nullable: true, example: 2000, description: 'null = no se cobra ni se pinta' })
  serviceFeeCents!: number | null;

  @ApiProperty({ nullable: true, example: 'Cargo por servicio' })
  serviceFeeLabel!: string | null;

  @ApiProperty({ example: 22_000 })
  totalCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ enum: ['global', 'marathon', 'none'], description: 'De dónde salió la config' })
  source!: string;
}

export class ImportResultsResponseDto {
  @ApiProperty({ example: 128 })
  imported!: number;

  @ApiProperty({ example: 2, description: 'Dorsales que no corresponden a ninguna inscripción' })
  skipped!: number;

  @ApiProperty({ type: [String], example: ['MLP-9999'] })
  unknownBibs!: string[];
}

export class AdminActionResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ description: 'Qué quedó, para que el panel repinte sin recargar' })
  data!: unknown;
}

// ─── Alta y edición de maratones ───────────────────────────────────────────

/**
 * Los campos de una maraton, todos opcionales.
 *
 * El alta y la edicion comparten esta clase y se diferencian solo en lo que
 * exigen (`CreateMarathonDto` redeclara lo obligatorio): tener dos listas de
 * campos separadas garantiza que al agregar uno nuevo se olvide en una de las
 * dos, y entonces el panel puede crear algo que despues no puede editar.
 *
 * Todo lo que es dinero va en centavos y todo lo que es distancia en metros,
 * igual que en el resto de la API: se convierte en la frontera, no en el medio.
 */
export class MarathonFieldsDto {
  @ApiPropertyOptional({ example: 'Maratón La Paz 3600' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    example: 'maraton-la-paz-3600',
    description: 'Único y estable: es parte de la URL pública. Sin él se deriva del nombre.',
  })
  @IsOptional()
  @IsString()
  @Matches(SLUG_REGEX, { message: 'El slug solo admite minúsculas, números y guiones' })
  @MaxLength(140)
  slug?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ApiPropertyOptional({ example: '2026-09-13T11:00:00.000Z', description: 'Largada, en UTC' })
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @ApiPropertyOptional({ example: 'America/La_Paz', description: 'Zona IANA de la carrera' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ example: 'La Paz' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ example: 'BO', description: 'ISO-3166 alfa-2' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiPropertyOptional({ nullable: true, example: -16.5 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number | null;

  @ApiPropertyOptional({ nullable: true, example: -68.15 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number | null;

  @ApiPropertyOptional({ example: 42195, description: 'Metros' })
  @IsOptional()
  @IsInt()
  @Min(1)
  distanceMeters?: number;

  @ApiPropertyOptional({ example: 2000, description: 'Cupos totales' })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ example: 25000, description: 'Precio base, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @ApiPropertyOptional({ example: 'BOB' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({
    enum: MarathonRegistrationStatus,
    description:
      'La **intención** del admin. Solo manda cuando dice `closed`; lo demás se deriva de ' +
      'cupos y fechas al leer.',
  })
  @IsOptional()
  @IsEnum(MarathonRegistrationStatus)
  registrationStatus?: MarathonRegistrationStatus;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null = las inscripciones cierran al largar',
  })
  @IsOptional()
  @IsISO8601()
  registrationClosesAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.cam.org.bo/qr-maraton.png',
    description:
      'TEMPORAL — QR de cobro del organizador (se sube por `POST /admin/marathons/:id/qr`). **Sin esto la carrera no admite el metodo `qr_manual`.** ' +
      'Ver `docs/pago-qr-manual.md`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  paymentQrUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Escanea con tu banca movil y pon la glosa que aparece abajo.',
    description: 'TEMPORAL — texto que se pinta junto al QR.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  paymentQrInstructions?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '00020101021226580014BR.GOV.BCB.PIX...6304A1B2',
    description:
      'TEMPORAL — contenido del QR de cobro **como texto** (el string que devuelve la banca movil ' +
      'al exportar el QR, un deep link o un numero de cuenta). La app lo dibuja: pesa bytes en vez ' +
      'de KB y sale nitido a cualquier tamano. **Sin esto la carrera no admite `qr_manual`.**',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  paymentQrPayload?: string | null;

  @ApiPropertyOptional({ example: [{ time: '06:00', title: 'Acreditación' }] })
  @IsOptional()
  @IsArray()
  schedule?: unknown[];

  @ApiPropertyOptional({ example: ['remera', 'medalla', 'hidratación'] })
  @IsOptional()
  @IsArray()
  includes?: unknown[];

  @ApiPropertyOptional({ nullable: true, example: { address: 'Av. Arce 123' } })
  @IsOptional()
  @IsObject()
  kitPickup?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Recorrido en GeoJSON, dibujado a mano. Normalmente NO se manda: se elige un `routeId` ' +
      'del catálogo de recorridos y la geometría se copia sola.',
  })
  @IsOptional()
  @IsObject()
  routeGeoJson?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    example: 'ckv...',
    nullable: true,
    description:
      'Recorrido preestablecido (`GET /routes`). Al mandarlo, la carrera **copia** su ' +
      'geometría, su distancia medida y su punto de largada: por eso `distanceMeters` no hace ' +
      'falta al crear con recorrido, y si viene, el del recorrido manda. `null` desvincula, ' +
      'sin borrar el trazado ya copiado.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  routeId?: string | null;

  @ApiPropertyOptional({
    description:
      'Publicar o retirar del catálogo. Retirar **no cancela nada**: las inscripciones ' +
      'vendidas siguen existiendo.',
  })
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

/**
 * Alta de una maraton.
 *
 * Redeclara como obligatorio lo minimo con lo que una carrera puede existir sin
 * mentirle a nadie: sin fecha, cupo o precio no se la puede ni listar ni cobrar.
 * El resto se completa despues, que es como se trabaja de verdad: la carrera se
 * carga en cuanto se confirma y el cronograma llega semanas mas tarde.
 */
export class CreateMarathonDto extends MarathonFieldsDto {
  @ApiProperty({ example: 'Maratón La Paz 3600' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  declare name: string;

  @ApiProperty({ example: '2026-09-13T11:00:00.000Z' })
  @IsISO8601()
  declare startsAt: string;

  @ApiProperty({ example: 'La Paz' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare city: string;

  @ApiPropertyOptional({
    example: 42195,
    description:
      'Metros. Opcional **solo** si se manda `routeId`: en ese caso la distancia se mide sobre ' +
      'la geometría del recorrido, que es la que dibuja el mapa. Sin recorrido es obligatorio.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  declare distanceMeters?: number;

  @ApiProperty({ example: 2000 })
  @IsInt()
  @Min(1)
  declare capacity: number;

  @ApiProperty({ example: 25000, description: 'Centavos' })
  @IsInt()
  @Min(0)
  declare priceCents: number;
}

/** Edicion parcial: lo que no venga en el cuerpo no se toca. */
export class UpdateMarathonDto extends MarathonFieldsDto {}

// ─── Categorías y extras ───────────────────────────────────────────────────

export class CategoryFieldsDto {
  @ApiPropertyOptional({ example: 'Elite masculino' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ nullable: true, example: 18 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  minAge?: number | null;

  @ApiPropertyOptional({ nullable: true, example: 39 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  maxAge?: number | null;

  @ApiPropertyOptional({ enum: Gender, nullable: true, description: 'Null = cualquier género' })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender | null;

  @ApiPropertyOptional({ example: 0, description: 'Recargo sobre el precio base, en centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  extraPriceCents?: number;
}

export class CreateCategoryDto extends CategoryFieldsDto {
  @ApiProperty({ example: 'Elite masculino' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;
}

export class UpdateCategoryDto extends CategoryFieldsDto {}

export class ExtraFieldsDto {
  @ApiPropertyOptional({ example: 'Remera técnica' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 12000, description: 'Centavos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @ApiPropertyOptional({ nullable: true, description: 'Null = sin límite, no agotado' })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number | null;
}

export class CreateExtraDto extends ExtraFieldsDto {
  @ApiProperty({ example: 'Remera técnica' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;

  @ApiProperty({ example: 12000, description: 'Centavos' })
  @IsInt()
  @Min(0)
  declare priceCents: number;
}

export class UpdateExtraDto extends ExtraFieldsDto {}

// ─── Alta y edición de usuarios ────────────────────────────────────────────

/** Cuantos usuarios trae una pagina si no se pide otra cosa, y el techo. */
export const PAGINA_USUARIOS = 20;
export const PAGINA_USUARIOS_MAXIMA = 100;

/**
 * Filtros del listado de usuarios.
 *
 * Pagina por `page`/`pageSize` y no por cursor como el resto de la API: el
 * panel necesita saltar a una pagina y saber cuantos hay en total —"1-20 de
 * 340"—, y un cursor opaco no da ninguna de las dos cosas. La tabla de usuarios
 * es chica y solo la miran administradores, asi que el `OFFSET` no molesta.
 */
export class ListUsersQueryDto {
  @ApiPropertyOptional({
    example: '76543210',
    description: 'Coincidencia parcial en email, CI, nombre o celular de inscripcion',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Sin esto, vienen los tres roles' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: PAGINA_USUARIOS, maximum: PAGINA_USUARIOS_MAXIMA })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINA_USUARIOS_MAXIMA)
  pageSize?: number;
}

export class CreateUserDto {
  @ApiProperty({ example: 'organizador@paceup.bo' })
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  email!: string;

  @ApiProperty({ example: 'Alvaro Quispe' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({ example: 'Test1234', minLength: 8 })
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password!: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.runner })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({
    default: true,
    description:
      'Da el email por verificado. Por defecto **sí**: una cuenta creada a mano ya pasó por ' +
      'una persona, y dejarla sin verificar la deja a medio camino sin que nadie le haya ' +
      'mandado el correo.',
  })
  @IsOptional()
  @IsBoolean()
  verified?: boolean;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'organizador@paceup.bo' })
  @IsOptional()
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  email?: string;

  @ApiPropertyOptional({ example: 'Alvaro Quispe' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: 'Marcar o desmarcar el email como verificado' })
  @IsOptional()
  @IsBoolean()
  verified?: boolean;
}

/**
 * Reset de contrasena hecho por un admin.
 *
 * Va en su propio endpoint y no como un campo mas de `UpdateUserDto` a
 * proposito: cambiarle la contrasena a alguien no es lo mismo que corregirle el
 * nombre, y mezclarlos hace que un PUT de rutina pueda echar a un usuario de
 * todas sus sesiones sin que quien lo mando se entere.
 */
export class SetPasswordDto {
  @ApiProperty({ example: 'Test1234', minLength: 8 })
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password!: string;
}

/**
 * El aviso que ven los inscritos mientras la maraton esta en preparacion.
 *
 * Opcional: sin el, la app pinta su texto por defecto traducido al idioma de
 * cada corredor, que es mejor que un aviso escrito en un idioma que esa persona
 * no lee. `null` explicito borra el que hubiera y vuelve al texto por defecto.
 */
export class PrepareMarathonDto {
  @ApiPropertyOptional({
    example: 'Concentracion en el arco a las 06:45. No cierres la app.',
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  declare message?: string | null;
}
