import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';
import { AppConfigService } from './app-config.service';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // El .env local solo se lee fuera de produccion; en el VPS las variables
      // vienen del entorno del contenedor, no de un archivo dentro de la imagen.
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      envFilePath: ['.env'],
      cache: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
