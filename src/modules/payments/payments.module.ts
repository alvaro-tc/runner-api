import { Module, forwardRef } from '@nestjs/common';
import { RegistrationsModule } from '../registrations/registrations.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDER } from './payment-provider';
import { MockPaymentProvider } from './mock/mock-payment.provider';
import { ReceiptService } from './receipt/receipt.service';
// TEMPORAL — cobro por QR verificado a mano. Borrar estas dos lineas, la carpeta
// `manual-qr/` y las dos entradas de abajo desmonta el flujo entero.
// Ver `docs/pago-qr-manual.md`.
import { PaymentProofController } from './manual-qr/payment-proof.controller';
import { PaymentProofAdminController } from './manual-qr/payment-proof-admin.controller';
import { PaymentProofService } from './manual-qr/payment-proof.service';

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
  controllers: [PaymentsController, PaymentProofController, PaymentProofAdminController],
  providers: [
    PaymentsService,
    ReceiptService,
    PaymentProofService,
    { provide: PAYMENT_PROVIDER, useClass: MockPaymentProvider },
  ],
  exports: [PaymentsService, PaymentProofService],
})
export class PaymentsModule {}
