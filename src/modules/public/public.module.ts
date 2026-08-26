import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { RegistrationsModule } from '../registrations/registrations.module';
import { PublicRegistrationController } from './public-registration.controller';
import { PublicRegistrationService } from './public-registration.service';

/**
 * TEMPORAL — la web publica de inscripcion. Ver `docs/pago-qr-manual.md`.
 *
 * Importa inscripciones y pagos porque **los usa**, no porque los copie: el
 * precio, el cupo, el dorsal y el cobro salen de los mismos servicios que
 * atienden a la app. Lo unico propio de este modulo es resolver quien es el
 * corredor cuando no hay sesion.
 *
 * Se desmonta quitando esta linea de `app.module.ts` y borrando la carpeta.
 */
@Module({
  imports: [RegistrationsModule, PaymentsModule],
  controllers: [PublicRegistrationController],
  providers: [PublicRegistrationService],
})
export class PublicModule {}
