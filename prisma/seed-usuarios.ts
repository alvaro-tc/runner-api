import * as argon2 from 'argon2';
import { prisma } from './seed/comun';
import { PASSWORD_DE_PRUEBA, USUARIOS } from './seed/usuarios';

/**
 * `npm run db:seed:users` crea solo las cuentas de prueba de
 * `docs/cuentas-de-prueba.md`: email, CI, nombre, rol y contrasena. Perfil y
 * preferencias nacen vacios, igual que en un registro real. Idempotente por
 * email.
 */
async function main(): Promise<void> {
  const passwordHash = await argon2.hash(PASSWORD_DE_PRUEBA);

  for (const { email, ci, name, role } of USUARIOS) {
    if (await prisma.user.findUnique({ where: { email } })) {
      console.log(`  ${email} ya existe`);
      continue;
    }

    await prisma.user.create({
      data: {
        email,
        ci,
        name,
        role,
        passwordHash,
        emailVerifiedAt: new Date(),
        profile: { create: {} },
        preferences: { create: {} },
      },
    });
    console.log(`  ${email} creado (${role})`);
  }

  console.log(`\n✔ Usuarios listos. Contrasena: ${PASSWORD_DE_PRUEBA}\n`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
