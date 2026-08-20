import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto, ResponseMetaDto } from './common/dto/response-envelope';
import type { AppConfigService } from './config/app-config.service';

export function setupSwagger(app: INestApplication, config: AppConfigService): void {
  const builder = new DocumentBuilder()
    .setTitle('PaceUp API')
    .setDescription(
      [
        'Backend de PaceUp: maratones, inscripciones, planes de entrenamiento y tracking GPS.',
        '',
        '**Unidades base:** distancias en metros, duraciones en segundos, dinero en centavos',
        '(entero) con `currency`, fechas en ISO-8601 UTC. El formateo (km, min/km, `Bs`) es del cliente.',
        '',
        '**Sobre de respuesta:** todo exito devuelve `{ data, meta }` y todo error `{ error, meta }`.',
        'Mapea los errores por `error.code`, nunca por `error.message`.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    // La ingesta de posiciones no usa el JWT del usuario sino el `ingestToken`
    // de la sesion, que es otro credencial y merece su propio candado en la UI.
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description: 'El `ingestToken` que devuelve POST /workouts/sessions',
      },
      'ingest-token',
    )
    .addServer(`http://localhost:${config.get('PORT')}`, 'Local')
    .addServer(`https://${config.get('API_DOMAIN')}`, 'VPS')
    .build();

  const document = SwaggerModule.createDocument(app, builder, {
    extraModels: [ResponseMetaDto, ErrorResponseDto],
  });

  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha', operationsSorter: 'alpha' },
    customSiteTitle: 'PaceUp API',
  });
}
