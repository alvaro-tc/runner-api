import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// En desarrollo las variables estan en el `.env` del repo. En el VPS no hay
// ninguno: viven en el EnvironmentFile del servicio (600, fuera del repo), que
// systemd le pasa a Node pero que el CLI de Prisma no ve. Sin esta segunda
// carga, `prisma migrate deploy` en el servidor falla con
// "The datasource.url property is required in your Prisma config file".
// dotenv no pisa lo que ya existe, asi que exportar DATABASE_URL a mano antes
// de invocar el CLI siempre gana.
loadEnv();
loadEnv({ path: process.env['ENV_FILE'] ?? '/etc/running-api/.env.production' });

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
