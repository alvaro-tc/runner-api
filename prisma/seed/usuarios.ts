import * as argon2 from 'argon2';
import { log, prisma, titulo } from './comun';
import type { Gender, UserRole } from '../../generated/prisma/enums';

/**
 * Contrasena unica para todos los usuarios de prueba.
 *
 * Cumple la politica real (mayuscula, minuscula, digito y simbolo) a proposito:
 * si el seed pudiera crear una contrasena que el registro rechaza, el usuario
 * sembrado seria uno que nadie podria haber creado por la app.
 */
export const PASSWORD_DE_PRUEBA = 'Test1234!';

interface SemillaUsuario {
  email: string;
  /** Cedula. Es la segunda credencial: se puede entrar con email o con CI. */
  ci: string;
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
    ci: '6789012LP',
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
    ci: '5544332CB',
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
    ci: '1000001LP',
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
  {
    email: 'runner3@test.com',
    ci: '7788990SC',
    name: 'Jhonny Aguilar',
    role: 'runner',
    perfil: {
      city: 'Santa Cruz de la Sierra',
      birthDate: '1992-06-11',
      gender: 'male',
      weightGrams: 76_000,
      heightCm: 178,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: 400,
      hydrationHabit: 'moderate',
    },
    preferencias: { locale: 'es-BO', notifications: { push: true } },
  },
  {
    email: 'runner4@test.com',
    ci: '3322110CB',
    name: 'Fatima Vargas',
    role: 'runner',
    perfil: {
      city: 'Cochabamba',
      birthDate: '2001-02-28',
      gender: 'female',
      weightGrams: 55_000,
      heightCm: 160,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: 450,
      hydrationHabit: 'low',
    },
    preferencias: { locale: 'es-BO', notifications: { push: true, raceReminders: true } },
  },
  {
    email: 'runner5@test.com',
    ci: '9988776SU',
    name: 'Marco Antonio Flores',
    role: 'runner',
    perfil: {
      city: 'Sucre',
      birthDate: '1985-10-30',
      gender: 'male',
      weightGrams: 83_000,
      heightCm: 175,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: 390,
      hydrationHabit: 'moderate',
    },
    preferencias: { locale: 'es-BO', notifications: {} },
  },
  // Tres organizadores: admin recortado —usuarios y comprobantes de pago—, uno
  // por ciudad para poder probar dos sesiones a la vez sin pisarse.
  {
    email: 'organizer@test.com',
    ci: '2000001LP',
    name: 'Lucia Mamani',
    role: 'organizer',
    perfil: {
      city: 'La Paz',
      birthDate: '1990-03-12',
      gender: 'female',
      weightGrams: 62000,
      heightCm: 166,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: null,
      hydrationHabit: null,
    },
    preferencias: { locale: 'es-BO', notifications: {} },
  },
  {
    email: 'organizer2@test.com',
    ci: '2000002CB',
    name: 'Rodrigo Ticona',
    role: 'organizer',
    perfil: {
      city: 'Cochabamba',
      birthDate: '1987-07-19',
      gender: 'male',
      weightGrams: 78000,
      heightCm: 177,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: null,
      hydrationHabit: null,
    },
    preferencias: { locale: 'es-BO', notifications: {} },
  },
  {
    email: 'organizer3@test.com',
    ci: '2000003SC',
    name: 'Andrea Suarez',
    role: 'organizer',
    perfil: {
      city: 'Santa Cruz de la Sierra',
      birthDate: '1994-11-05',
      gender: 'female',
      weightGrams: 59000,
      heightCm: 168,
      defaultBibNumber: null,
      injuryFlags: [],
      avgSleepMinutes: null,
      hydrationHabit: null,
    },
    preferencias: { locale: 'es-BO', notifications: {} },
  },
];

/**
 * Crea los usuarios de prueba. Idempotente por email.
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
        ci: semilla.ci,
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
