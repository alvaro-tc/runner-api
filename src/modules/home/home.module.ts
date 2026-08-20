import { Module } from '@nestjs/common';
import { MarathonsModule } from '../marathons/marathons.module';
import { TrainingPlansModule } from '../training-plans/training-plans.module';
import { WorkoutsModule } from '../workouts/workouts.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { PredictionService } from './prediction.service';

/**
 * Home.
 *
 * Es un modulo de composicion: no tiene tablas propias ni reglas propias, solo
 * junta lo que ya saben responder maratones, planes y entrenamientos. Todas las
 * flechas salen de aqui y ninguna entra, asi que no puede cerrar ciclos con
 * nadie.
 *
 * `PredictionService` vive aqui porque el home es quien lo pide, y se exporta
 * porque la pantalla de una maraton querra el mismo numero.
 */
@Module({
  imports: [MarathonsModule, TrainingPlansModule, WorkoutsModule],
  controllers: [HomeController],
  providers: [HomeService, PredictionService],
  exports: [PredictionService],
})
export class HomeModule {}
