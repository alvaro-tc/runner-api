import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RegistrationsModule } from '../registrations/registrations.module';
import { AvatarService } from './avatar.service';
import { ShoesController } from './shoes.controller';
import { ShoesService } from './shoes.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Perfil, preferencias, avatar, zapatillas y salud.
 *
 * `ShoesService` se exporta porque el modulo de workouts va a necesitarlo en la
 * Fase 10 para sumar la distancia a la zapatilla principal al consolidar.
 */
@Module({
  // Borrar la cuenta tiene que soltar los cupos que ocupaba, y eso ya lo sabe
  // hacer `RegistrationsService.cancelar`. La flecha va en este sentido y no al
  // reves: inscripciones no necesita saber nada del perfil.
  //
  // Y tiene que revocar el token de Sign in with Apple, que es de auth.
  imports: [RegistrationsModule, AuthModule],
  controllers: [UsersController, ShoesController],
  providers: [UsersService, AvatarService, ShoesService],
  exports: [UsersService, ShoesService],
})
export class UsersModule {}
