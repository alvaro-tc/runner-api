import { Global, Module } from '@nestjs/common';
import { LocalStorageService, StorageService } from './storage.service';

/**
 * Global porque casi todo modulo que genere un binario (avatar, tarjeta de
 * resultado, comprobante PDF) lo va a necesitar, y no aporta nada obligar a
 * cada uno a importarlo.
 */
@Global()
@Module({
  providers: [{ provide: StorageService, useClass: LocalStorageService }],
  exports: [StorageService],
})
export class StorageModule {}
