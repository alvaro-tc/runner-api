import { prisma } from './seed/comun';

/**
 * `npm run db:wipe` vacia **todas** las tablas y deja el esquema intacto (solo
 * se salva `_prisma_migrations`, para no tener que volver a migrar). Las
 * particiones de `positions` caen con su tabla padre.
 */
async function main(): Promise<void> {
  const tablas = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT c.relname AS tablename
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition AND c.relname <> '_prisma_migrations'`;

  if (tablas.length === 0) return console.log('Nada que borrar.');

  const lista = tablas.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${lista} RESTART IDENTITY CASCADE`);

  console.log(`✔ Base vaciada (${tablas.length} tablas).`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
