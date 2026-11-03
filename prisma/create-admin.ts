// Primero de todo: `comun.ts` arma el PrismaClient con DATABASE_URL al
// importarse. Corriendo por fuera de `prisma db seed` nadie mas carga el
// .env, asi que sin esto la conexion sale vacia.
import 'dotenv/config';
import { prisma } from './seed/comun';
import { hashPassword } from '../src/modules/auth/password';
import { PASSWORD_MESSAGE, PASSWORD_REGEX } from '../src/modules/auth/dto/auth.dto';

/**
 * Da de alta un admin fuera del seed de datos de prueba.
 *
 * A diferencia de `sembrarUsuarios` (que siempre deja `admin@test.com` con la
 * contrasena de prueba), esto sirve para un admin real o para uno adicional:
 * no toca maratones ni inscripciones, y si el email ya existe **no lo
 * asciende solo** -- ascender una cuenta existente en silencio es exactamente
 * el escalado de privilegios que `POST /admin/users` evita a proposito. Para
 * eso esta el panel, con un admin de confianza de por medio.
 *
 * Uso:
 *   npm run db:create-admin -- --email=ana@cam.org --password="Clave1234!" --name="Ana Perez"
 */

function arg(nombre: string): string | undefined {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((a) => a.startsWith(prefijo));
  return encontrado?.slice(prefijo.length);
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const password = arg('password');
  const name = arg('name')?.trim();

  if (!email || !password || !name) {
    console.error(
      'Uso: npm run db:create-admin -- --email=correo@dominio.com --password="Clave1234!" --name="Nombre Apellido"',
    );
    process.exitCode = 1;
    return;
  }

  if (!PASSWORD_REGEX.test(password)) {
    console.error(PASSWORD_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const existente = await prisma.user.findUnique({ where: { email } });
  if (existente) {
    console.error(
      `Ya existe una cuenta con ${email} (rol actual: ${existente.role}). Este script no ` +
        'asciende cuentas existentes: hazlo desde el panel de admin, con una cuenta admin ' +
        'de confianza (PUT /admin/users/:id).',
    );
    process.exitCode = 1;
    return;
  }

  const creado = await prisma.user.create({
    data: {
      email,
      name,
      role: 'admin',
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
      profile: { create: {} },
      preferences: { create: {} },
    },
  });

  console.log(`\n✔ Admin creado: ${creado.email} (id ${creado.id})\n`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
