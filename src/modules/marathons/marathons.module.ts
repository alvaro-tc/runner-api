import { Module } from '@nestjs/common';
import { MarathonsController } from './marathons.controller';
import { MarathonsService } from './marathons.service';

/**
 * Catalogo de maratones. Se exporta el servicio porque inscripciones (Fase 7)
 * y planes de entrenamiento (Fase 9) necesitan resolver una maraton visible sin
 * volver a escribir las reglas de visibilidad y de estado.
 */
@Module({
  controllers: [MarathonsController],
  providers: [MarathonsService],
  exports: [MarathonsService],
})
export class MarathonsModule {}
