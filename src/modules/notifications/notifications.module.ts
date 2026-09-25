import { Global, Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { ConsolePushSender, FcmPushSender, PushSender } from './push.sender';

/**
 * Global, como `MailModule`: cualquier modulo puede tener algo que avisar y no
 * aporta nada obligar a cada uno a importarlo.
 */
@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: PushSender,
      // Sin credenciales de Firebase (desarrollo, tests) el push va a consola.
      useFactory: (config: AppConfigService, prisma: PrismaService) => {
        const credenciales = config.get('FIREBASE_CREDENTIALS');
        return credenciales ? new FcmPushSender(credenciales, prisma) : new ConsolePushSender();
      },
      inject: [AppConfigService, PrismaService],
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
