import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TrainingPlansModule } from '../training-plans/training-plans.module';
import { RacesModule } from '../races/races.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkoutSessionsController, WorkoutsController } from './workouts.controller';
import { WorkoutSessionsService } from './workout-sessions.service';
import { WorkoutsService } from './workouts.service';

/**
 * Entrenamientos.
 *
 * Depende de usuarios por `ShoesService` (los kilometros se suman a la
 * zapatilla principal al consolidar) y de planes para cerrar la sesion del plan
 * que el entrenamiento vino a cumplir.
 *
 * Se exporta el servicio porque tracking (Fase 11) necesita resolver el
 * `ingestToken` a su sesion. La flecha hacia carreras va en este sentido y no
 * al reves: cerrar una sesion de carrera es lo que produce el resultado.
 */
@Module({
  imports: [UsersModule, TrainingPlansModule, RacesModule, RealtimeModule],
  controllers: [WorkoutSessionsController, WorkoutsController],
  providers: [WorkoutSessionsService, WorkoutsService],
  exports: [WorkoutSessionsService, WorkoutsService],
})
export class WorkoutsModule {}
