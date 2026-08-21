import { Module } from '@nestjs/common';
import { RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';

/**
 * Recorridos preestablecidos. Se exporta el servicio porque el panel crea
 * maratones **a partir de** un recorrido, y el que sabe medir y validar una
 * geometria es este modulo, no el de admin.
 */
@Module({
  controllers: [RoutesController],
  providers: [RoutesService],
  exports: [RoutesService],
})
export class RoutesModule {}
