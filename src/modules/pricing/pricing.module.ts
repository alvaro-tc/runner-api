import { Module } from '@nestjs/common';
import { MarathonsModule } from '../marathons/marathons.module';
import { PricingController } from './pricing.controller';
import { QuoteService } from './quote.service';
import { ServiceFeeConfigService } from './service-fee.service';

/**
 * Precios. `QuoteService` se exporta porque inscripciones (Fase 7) y pagos
 * (Fase 8) tienen que cotizar con las mismas reglas: si cada uno sumara por su
 * cuenta, el total del comprobante podria no coincidir con el que se cobro.
 */
@Module({
  imports: [MarathonsModule],
  controllers: [PricingController],
  providers: [QuoteService, ServiceFeeConfigService],
  exports: [QuoteService, ServiceFeeConfigService],
})
export class PricingModule {}
