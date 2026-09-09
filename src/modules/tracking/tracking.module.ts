import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkoutsModule } from '../workouts/workouts.module';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';

/**
 * Ingesta de posiciones GPS.
 *
 * La sesion llega resuelta por el guard a partir del `ingestToken`, asi que el
 * camino caliente —un lote cada veinte segundos— no depende de nada de
 * entrenamientos. La flecha hacia `WorkoutsModule` existe por un solo motivo:
 * cuando el GPS dice que un corredor cruzo la meta, la carrera se cierra con el
 * **mismo** cierre que usa el boton de finalizar. Ver `cerrarPorLlegada`. La
 * flecha no vuelve: entrenamientos no sabe que existe la ingesta.
 */
@Module({
  imports: [RealtimeModule, WorkoutsModule],
  controllers: [TrackingController],
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
