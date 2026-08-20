import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { RacesController } from './races.controller';
import { RacesService } from './races.service';
import { ShareCardService } from './share-card.service';

/**
 * Carreras.
 *
 * Depende de pagos para el comprobante —que no se reimplementa aqui: hay un
 * unico emisor de PDF y es el de pagos— y no depende de entrenamientos, aunque
 * lea sus splits y sus posiciones: son consultas de solo lectura y meter el
 * modulo entero solo para eso cerraria un ciclo, porque el cierre de una sesion
 * es justo lo que llama a `registrarResultado`.
 *
 * Se exporta el servicio porque entrenamientos lo invoca al finalizar una
 * carrera y el panel de admin (Fase 15) recalcula puestos con el.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [RacesController],
  providers: [RacesService, ShareCardService],
  exports: [RacesService],
})
export class RacesModule {}
