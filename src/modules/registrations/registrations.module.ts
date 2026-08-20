import { Module, forwardRef } from '@nestjs/common';
import { MarathonsModule } from '../marathons/marathons.module';
import { PricingModule } from '../pricing/pricing.module';
import { PaymentsModule } from '../payments/payments.module';
import { RegistrationsController } from './registrations.controller';
import { RegistrationsService } from './registrations.service';

/**
 * Inscripciones. Se exporta el servicio porque pagos confirma desde el webhook
 * del proveedor y races (Fase 12) lee los datos de la carrera corrida.
 *
 * `forwardRef` sobre pagos: la dependencia es mutua a proposito —pagos confirma
 * inscripciones, inscripciones reembolsa pagos al cancelar— y asi queda
 * declarada en vez de escondida.
 */
@Module({
  imports: [MarathonsModule, PricingModule, forwardRef(() => PaymentsModule)],
  controllers: [RegistrationsController],
  providers: [RegistrationsService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}
