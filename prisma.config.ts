import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
    // Base efimera que Prisma usa para detectar drift al crear migraciones.
    // Sin esto, `migrate dev` intenta crearla en la misma instancia y necesita
    // permisos de superusuario.
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'],
  },
});
