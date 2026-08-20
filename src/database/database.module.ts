import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global: todo modulo de negocio necesita la base, no tiene sentido importarlo
 *  una y otra vez. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
