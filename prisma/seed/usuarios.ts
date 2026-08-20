import * as argon2 from 'argon2';
import { log, prisma, titulo } from './comun';
import type { Gender, UserRole } from '../../generated/prisma/enums';

/**
 * Contrasena unica para los tres usuarios de prueba.
 *
 * Cumple la politica real (mayuscula, minuscula, digito y simbolo) a proposito:
 * si el seed pudiera crear una contrasena que el registro rechaza, el usuario
 * sembrado seria uno que nadie podria haber creado por la app.
 */
export const PASSWORD_DE_PRUEBA = 'Test1234!';

interface SemillaUsuario {
  email: string;
  name: string;
  role: UserRole;
  perfil: {
    city: string;
    birthDate: string;
    gender: Gender;
    weightGrams: number;
    heightCm: number;
    defaultBibNumber: string | null;
    injuryFlags: { zone: string; since: string; notes: string }[];
    avgSleepMinutes: number | null;
    hydrationHabit: string | null;
  };
  preferencias: { locale: string; notifications: Record<string, boolean> };
}

const USUARIOS: SemillaUsuario[] = [
  {
    email: 'runner@test.com',
    name: 'Alvaro Quispe',
    role: 'runner',
    perfil: {
      city: 'La Paz',
      birthDate: '1995-04-17',
      gender: 'male',
      weightGrams: 72_000,
      heightCm: 174,
      defaultBibNumber: '1042',
      injuryFlags: [
        { zone: 'rodilla derecha', since: '2025-11-03', notes: 'Molestia al bajar, ya resuelta' },
      ],
      avgSleepMinutes: 420,
      hydrationHabit: 'moderate',
    },
    preferencias: { locale: 'es-BO', notifications: { push: true, raceReminders: true } },
  },
  {
    email: 'runner2@test.com',
    name: 'Camila Rojas',
    role: 'runner',
    perfil: {
      city: 'Cochabamba',
      birthDate: '1999-09-02',
      gender: 'female',
      weightGrams: 58_000,
      heightCm: 163,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: 480,
      hydrationHabit: 'high',
    },
    // Segunda corredora sin nada sembrado encima: es la cuenta con la que se
    // comprueba que los datos del primero NO se ven desde otra sesion.
    preferencias: { locale: 'es-BO', notifications: { push: false } },
  },
  {
    email: 'admin@test.com',
    name: 'Admin PaceUp',
    role: 'admin',
    perfil: {
      city: 'La Paz',
      birthDate: '1988-01-25',
      gender: 'unspecified',
      weightGrams: 80_000,
      heightCm: 180,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: null,
      hydrationHabit: null,
    },
    preferencias: { locale: 'es-BO', notifications: {} },
  },
];

/**
 * Crea los tres usuarios de prueba. Idempotente por email.
 *
 * La contrasena se hashea con argon2 igual que en el registro real: sembrar un
 * hash pegado a mano ataria el seed a los parametros de hoy y dejaria de
 * validar el dia que se ajusten.
 */
export async function sembrarUsuarios(): Promise<Record<string, string>> {
  titulo('Usuarios de prueba');

  const ids: Record<string, string> = {};

  for (const semilla of USUARIOS) {
    const existente = await prisma.user.findUnique({ where: { email: semilla.email } });

    if (existente) {
      ids[semilla.email] = existente.id;
      log(`${semilla.email} ya existe`);
      continue;
    }

    const { injuryFlags, birthDate, ...resto } = semilla.perfil;

    const creado = await prisma.user.create({
      data: {
        email: semilla.email,
        name: semilla.name,
        role: semilla.role,
        passwordHash: await argon2.hash(PASSWORD_DE_PRUEBA),
        // Verificado de entrada: el flujo de verificacion por correo no existe
        // todavia, y dejarlo en null sugeriria un estado que nada produce.
        emailVerifiedAt: new Date(),
        profile: { create: { ...resto, birthDate: new Date(birthDate), injuryFlags } },
        preferences: {
          create: {
            ...semilla.preferencias,
            // Onboarding visto: sembrar un usuario que arranca en los slides
            // obliga a pasarlos a mano en cada `db:reset`.
            onboardingSeenAt: new Date(),
          },
        },
      },
    });

    ids[semilla.email] = creado.id;
    log(`${semilla.email} creado (${semilla.role})`);
  }

  return ids;
}
