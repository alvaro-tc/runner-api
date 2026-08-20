import { Module } from '@nestjs/common';
import { LinksController } from './links.controller';
import { LinksService } from './links.service';

/** Enlaces profundos con metadatos Open Graph. Ver `docs/api.md`. */
@Module({
  controllers: [LinksController],
  providers: [LinksService],
})
export class LinksModule {}
