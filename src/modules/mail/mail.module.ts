import { Global, Module } from '@nestjs/common';
import { ConsoleMailService, MailService } from './mail.service';

@Global()
@Module({
  providers: [{ provide: MailService, useClass: ConsoleMailService }],
  exports: [MailService],
})
export class MailModule {}
