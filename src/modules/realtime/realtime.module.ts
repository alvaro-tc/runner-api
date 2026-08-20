import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LiveGateway } from './live.gateway';
import { LiveService } from './live.service';

/**
 * Tiempo real.
 *
 * Depende de auth solo para verificar el token del handshake. No depende de
 * tracking: la flecha va al reves —la ingesta publica aqui— y asi el modulo
 * caliente, el que recibe un lote cada veinte segundos, no arrastra sockets.
 *
 * Se exporta `LiveService` y no el gateway: quien publica no tiene por que
 * saber que hay un Socket.IO detras.
 */
@Module({
  imports: [AuthModule],
  providers: [LiveGateway, LiveService],
  exports: [LiveService],
})
export class RealtimeModule {}
