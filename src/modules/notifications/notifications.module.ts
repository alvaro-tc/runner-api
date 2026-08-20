import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ConsolePushSender, PushSender } from './push.sender';

/**
 * Global, como `MailModule`: cualquier modulo puede tener algo que avisar y no
 * aporta nada obligar a cada uno a importarlo.
 */
@Global()
@Module({
  providers: [NotificationsService, { provide: PushSender, useClass: ConsolePushSender }],
  exports: [NotificationsService],
})
export class NotificationsModule {}
