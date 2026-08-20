import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';

/**
 * Ingesta de posiciones GPS.
 *
 * No depende de `WorkoutsModule`: la sesion llega resuelta por el guard a
 * partir del `ingestToken`, y el ciclo de vida de la sesion (arrancar, cerrar,
 * consolidar) vive del otro lado. Son dos modulos con dos ritmos distintos —
 * uno recibe un lote cada veinte segundos, el otro se usa dos veces por
 * entrenamiento— y mantenerlos separados es lo que permite meter mano en el
 * caliente sin tocar el otro.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [TrackingController],
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
