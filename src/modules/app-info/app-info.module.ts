import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { AppInfoController } from './app-info.controller';

/**
 * `GET /config/app`: lo que el cliente necesita saber del entorno antes de
 * pintar nada. Depende de precios solo para saber si el cargo por servicio
 * esta encendido; no cotiza.
 */
@Module({
  imports: [PricingModule],
  controllers: [AppInfoController],
})
export class AppInfoModule {}
