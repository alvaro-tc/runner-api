import { Module } from '@nestjs/common';
import { MarathonsModule } from '../marathons/marathons.module';
import { TrainingPlansController } from './training-plans.controller';
import { TrainingPlansService } from './training-plans.service';

/**
 * Planes de entrenamiento. Depende de maratones para anclar un plan a la semana
 * de la carrera sin reescribir las reglas de visibilidad del catalogo.
 *
 * Se exporta el servicio porque `/home/summary` (Fase 13) necesita la semana en
 * curso y la sesion de hoy, y workouts (Fase 10) tiene que poder cerrar la
 * sesion del plan al consolidar un entrenamiento.
 */
@Module({
  imports: [MarathonsModule],
  controllers: [TrainingPlansController],
  providers: [TrainingPlansService],
  exports: [TrainingPlansService],
})
export class TrainingPlansModule {}
