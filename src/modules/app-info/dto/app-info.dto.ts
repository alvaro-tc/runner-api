import { ApiProperty } from '@nestjs/swagger';

export class ServiceFeeInfoDto {
  @ApiProperty({ example: 'Cargo por servicio' })
  label!: string;
}

export class TrackingInfoDto {
  @ApiProperty({
    example: 30,
    description:
      'Precision minima aceptable de un punto GPS, en metros. El cliente descarta lo peor antes ' +
      'de encolarlo; el servidor lo vuelve a filtrar al consolidar.',
  })
  maxAccuracyMeters!: number;

  @ApiProperty({
    example: 20,
    description: 'Lotes de posiciones por minuto y por sesion que la API acepta.',
  })
  maxBatchesPerMinute!: number;

  @ApiProperty({
    example: 30,
    description:
      'Cada cuantos segundos conviene mandar un lote. Mas corto gasta bateria sin ganar nada: ' +
      'los puntos ya estan a salvo en la base local del telefono.',
  })
  suggestedBatchSeconds!: number;
}

export class LimitsInfoDto {
  @ApiProperty({ example: 5242880 })
  avatarMaxBytes!: number;

  @ApiProperty({ example: 120 })
  requestsPerMinute!: number;

  @ApiProperty({ example: 800000, description: 'Umbral de desgaste por defecto de una zapatilla.' })
  shoeAlertThresholdMeters!: number;
}

export class FeaturesInfoDto {
  @ApiProperty({ example: false, description: '`POST /tracking/simulate` esta habilitado.' })
  gpsSimulation!: boolean;

  @ApiProperty({ example: true, description: 'El namespace `/live` esta montado.' })
  liveTracking!: boolean;

  @ApiProperty({ example: false, description: 'Login con Google/Facebook/LinkedIn operativo.' })
  socialLogin!: boolean;
}

export class AppInfoDto {
  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({ example: 'America/La_Paz', description: 'Zona horaria por defecto de la app.' })
  timezone!: string;

  @ApiProperty({ example: 'es-BO' })
  defaultLocale!: string;

  @ApiProperty({
    example: '1.0.0',
    description:
      'Version minima soportada. Si la del telefono es menor, el cliente debe bloquear y mandar ' +
      'a actualizar: por debajo de esta version no se garantiza el contrato.',
  })
  minAppVersion!: string;

  @ApiProperty({ example: 'paceup', description: 'Esquema que abren los enlaces de /links/*.' })
  deepLinkScheme!: string;

  @ApiProperty({
    type: ServiceFeeInfoDto,
    nullable: true,
    description:
      '`null` cuando el cargo por servicio esta apagado. No es `{ enabled: false }`: es ausencia, ' +
      'igual que en las cotizaciones, para que la UI no tenga que pintar una linea en cero.',
  })
  serviceFee!: ServiceFeeInfoDto | null;

  @ApiProperty({ type: TrackingInfoDto })
  tracking!: TrackingInfoDto;

  @ApiProperty({ type: LimitsInfoDto })
  limits!: LimitsInfoDto;

  @ApiProperty({ type: FeaturesInfoDto })
  features!: FeaturesInfoDto;
}
