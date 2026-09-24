import { Global, Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ConsolePushSender, PushSender } from './push.sender';

/**
 * Global, como `MailModule`: cualquier modulo puede tener algo que avisar y no
 * aporta nada obligar a cada uno a importarlo.
 */
@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, { provide: PushSender, useClass: ConsolePushSender }],
  exports: [NotificationsService],
})
export class NotificationsModule {}
