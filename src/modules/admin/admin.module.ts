import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { PaymentsModule } from '../payments/payments.module';
import { RacesModule } from '../races/races.module';
import { RoutesModule } from '../routes/routes.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PanelController } from './panel.controller';

/**
 * Administracion.
 *
 * Importa pricing, pagos y carreras porque **no reimplementa** ninguna de sus
 * reglas: confirmar un cobro pasa por `PaymentsService` y recalcular puestos por
 * `RacesService`. Una segunda implementacion de "acreditar un pago" es como se
 * acaba con dos personas con el mismo dorsal, y borrar una cuenta desde el
 * panel pasa por `UsersService`, que es quien sabe soltar los cupos que ocupaba
 * y limpiar sus archivos de disco. Los recorridos preestablecidos van por
 * `RoutesService`, que es quien sabe medir y validar una geometria.
 *
 * Dos controladores a proposito: la API bajo `/api/v1/admin/*` y la pagina en
 * `/admin`. La pagina es un cliente mas de la API, sin acceso privilegiado a
 * nada, y por eso el front-end web que venga despues no tendra que reimplementar
 * ni una accion.
 */
@Module({
  imports: [PricingModule, PaymentsModule, RacesModule, RoutesModule, UsersModule],
  controllers: [AdminController, PanelController],
  providers: [AdminService],
})
export class AdminModule {}
