import { Module, forwardRef } from '@nestjs/common';
import { RegistrationsModule } from '../registrations/registrations.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import { ReceiptService } from './receipt/receipt.service';

/**
 * Pagos.
 *
 * `PAYMENT_PROVIDER` es el unico punto donde se elige la implementacion: el dia
 * que entre un PSP real —QR Simple del BCB via banco adquirente, una pasarela
 * local— se cambia esta linea y nada mas. Ni el servicio ni el controlador ni
 * la tabla saben con quien estan hablando.
 *
 * La dependencia con `RegistrationsModule` es mutua y esta declarada con
 * `forwardRef`: el cobro necesita saber que inscripcion confirma, y la
 * cancelacion necesita devolver el dinero. Mover una de las dos mitades a otro
 * modulo solo esconderia el ciclo detras de una capa mas.
 */
@Module({
  imports: [forwardRef(() => RegistrationsModule)],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    ReceiptService,
    { provide: PAYMENT_PROVIDER, useClass: MockPaymentProvider },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
