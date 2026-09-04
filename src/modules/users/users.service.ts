import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { camposPresentes } from '../../common/utils/patch';
import { esCiValida, normalizarCi } from '../auth/ci';
import { rangoSemanal } from '../../common/time/week';
import { StorageService } from '../storage/storage.service';
import { RegistrationsService } from '../registrations/registrations.service';
import { RegistrationStatus } from '../../../generated/prisma/enums';
import type { Prisma } from '../../../generated/prisma/client';
import type { UpdateHealthDto, UpdateMeDto } from './dto/user.dto';
import type { UpdatePreferencesDto } from './dto/preferences.dto';

/** Campos del PATCH que viven en `users`; el resto van a `user_profiles`. */
const CAMPOS_DE_USUARIO = ['name'] as const;
const CAMPOS_DE_PERFIL = [
  'city',
  'country',
  'gender',
  'weightGrams',
  'heightCm',
  'defaultBibNumber',
  'phone',
] as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
    private readonly registrations: RegistrationsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  Perfil
  // ─────────────────────────────────────────────────────────────────────────

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    if (!user || user.deletedAt) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Usuario no encontrado', HttpStatus.NOT_FOUND);
    }

    return this.toMe(user);
  }

  /**
   * Cambiar el email **desverifica** la cuenta.
   *
   * Si `emailVerifiedAt` sobreviviera al cambio, cualquiera con la sesion
   * abierta podria mudar la cuenta a un buzon ajeno y quedarse con el sello de
   * verificado puesto. La verificacion es del buzon, no del usuario.
   */
  async updateMe(userId: string, dto: UpdateMeDto) {
    const actual = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, ci: true, deletedAt: true },
    });

    if (!actual || actual.deletedAt) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Usuario no encontrado', HttpStatus.NOT_FOUND);
    }

    const datosUsuario: Prisma.UserUpdateInput = camposPresentes(dto, CAMPOS_DE_USUARIO);

    // La comparacion es insensible a mayusculas porque la columna es citext:
    // cambiar `Ana@x.com` por `ana@x.com` no es un cambio de email.
    if (dto.email && dto.email.toLowerCase() !== (actual.email ?? '').toLowerCase()) {
      const ocupado = await this.prisma.user.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });

      if (ocupado) {
        throw new AppException(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          'Ya existe una cuenta con ese email',
          HttpStatus.CONFLICT,
        );
      }

      datosUsuario.email = dto.email;
      datosUsuario.emailVerifiedAt = null;
    }

    // La CI es credencial de acceso: se guarda normalizada, igual que en el
    // alta, o el usuario que la teclea con guion se queda fuera de su cuenta.
    if (dto.ci) {
      const ci = normalizarCi(dto.ci);

      if (!esCiValida(ci)) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'La CI no tiene un formato valido',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (ci !== actual.ci) {
        const ocupada = await this.prisma.user.findUnique({ where: { ci }, select: { id: true } });

        if (ocupada) {
          throw new AppException(
            ErrorCode.CI_ALREADY_REGISTERED,
            'Ya existe una cuenta con esa CI',
            HttpStatus.CONFLICT,
          );
        }

        datosUsuario.ci = ci;
      }
    }

    const datosPerfil: Prisma.UserProfileUpdateInput = camposPresentes(dto, CAMPOS_DE_PERFIL);
    if (Object.prototype.hasOwnProperty.call(dto, 'birthDate')) {
      datosPerfil.birthDate = dto.birthDate ? new Date(dto.birthDate) : null;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...datosUsuario,
        // upsert y no update: el perfil lo crea el registro, pero un usuario
        // sembrado a mano puede no tenerlo y no vale la pena reventar aqui.
        profile: {
          upsert: {
            create: datosPerfil as Prisma.UserProfileCreateWithoutUserInput,
            update: datosPerfil,
          },
        },
      },
      include: { profile: true },
    });

    return this.toMe(user);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Preferencias
  // ─────────────────────────────────────────────────────────────────────────

  async getPreferences(userId: string) {
    const prefs = await this.prisma.userPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    return this.toPreferences(prefs);
  }

  /**
   * `notifications` y `privacy` se **mezclan**, no se reemplazan.
   *
   * Son bolsas de banderas que crecen con cada version de la app. Si el PATCH
   * reemplazara el objeto entero, una app vieja que mande `{ push: false }`
   * borraria en silencio los toggles que no conoce.
   */
  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    const actual = await this.prisma.userPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    const data: Prisma.UserPreferencesUpdateInput = camposPresentes(dto, [
      'units',
      'theme',
      'locale',
    ]);

    if (dto.notifications) {
      data.notifications = mezclar(actual.notifications, dto.notifications);
    }
    if (dto.privacy) {
      data.privacy = mezclar(actual.privacy, dto.privacy);
    }

    if (dto.onboardingSeen !== undefined) {
      // Marcarlo dos veces no mueve la fecha: interesa cuando lo vio la primera
      // vez, no la ultima vez que el cliente lo reporto.
      data.onboardingSeenAt = dto.onboardingSeen ? (actual.onboardingSeenAt ?? new Date()) : null;
    }

    const prefs = await this.prisma.userPreferences.update({ where: { userId }, data });
    return this.toPreferences(prefs);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Salud
  // ─────────────────────────────────────────────────────────────────────────

  async getHealth(userId: string) {
    const perfil = await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    return this.toHealth(perfil);
  }

  async updateHealth(userId: string, dto: UpdateHealthDto) {
    const data: Prisma.UserProfileUpdateInput = camposPresentes(dto, [
      'avgSleepMinutes',
      'hydrationHabit',
    ]);

    // La lista de lesiones si se reemplaza entera: es una lista editable en la
    // pantalla de salud, no una bolsa de banderas incrementales.
    if (dto.injuryFlags) {
      data.injuryFlags = dto.injuryFlags as unknown as Prisma.InputJsonValue;
    }

    const perfil = await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, ...(data as Prisma.UserProfileCreateWithoutUserInput) },
      update: data,
    });

    return this.toHealth(perfil);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Highlights
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Kilometraje de la semana en curso y carrera mas larga.
   *
   * Las cuentas las hace Postgres con `aggregate`: traerse los workouts al
   * proceso para sumarlos funciona hoy, con historiales de decenas de filas, y
   * se cae solo el dia que alguien lleve tres anios corriendo.
   */
  async getHighlights(userId: string) {
    const { start, end } = rangoSemanal(new Date(), this.config.get('DEFAULT_TIMEZONE'));
    const visibles = { userId, deletedAt: null };

    const [semana, totales, masLargo] = await Promise.all([
      this.prisma.workout.aggregate({
        where: { ...visibles, startedAt: { gte: start, lt: end } },
        _sum: { distanceMeters: true },
        _count: { _all: true },
      }),
      this.prisma.workout.aggregate({
        where: visibles,
        _sum: { distanceMeters: true },
        _count: { _all: true },
      }),
      this.prisma.workout.findFirst({
        where: { ...visibles, distanceMeters: { gt: 0 } },
        orderBy: { distanceMeters: 'desc' },
        select: {
          id: true,
          startedAt: true,
          distanceMeters: true,
          durationSeconds: true,
          avgPaceSecPerKm: true,
        },
      }),
    ]);

    return {
      weekStartsAt: start.toISOString(),
      weekEndsAt: end.toISOString(),
      weekDistanceMeters: semana._sum.distanceMeters ?? 0,
      weekWorkouts: semana._count._all,
      longestWorkout: masLargo
        ? { ...masLargo, startedAt: masLargo.startedAt.toISOString() }
        : null,
      totalDistanceMeters: totales._sum.distanceMeters ?? 0,
      totalWorkouts: totales._count._all,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Serializacion
  // ─────────────────────────────────────────────────────────────────────────

  private toMe(user: {
    id: string;
    email: string | null;
    ci: string | null;
    name: string;
    role: string;
    mustChangePassword: boolean;
    emailVerifiedAt: Date | null;
    createdAt: Date;
    profile: PerfilCrudo | null;
  }) {
    const p = user.profile;

    return {
      id: user.id,
      email: user.email,
      ci: user.ci,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      profile: {
        // En la BD vive la clave del archivo; la URL se arma al leer.
        avatarUrl: p?.avatarUrl ? this.storage.url(p.avatarUrl) : null,
        city: p?.city ?? null,
        country: p?.country ?? 'BO',
        // Es una columna `date`: se recorta el tiempo para no sugerir una
        // precision horaria que nadie capturo.
        birthDate: p?.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
        gender: p?.gender ?? 'unspecified',
        weightGrams: p?.weightGrams ?? null,
        heightCm: p?.heightCm ?? null,
        defaultBibNumber: p?.defaultBibNumber ?? null,
        phone: p?.phone ?? null,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Borrado de cuenta
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Borra la cuenta y todo lo que cuelga de ella.
   *
   * El borrado en cascada lo hace Postgres, no este metodo: cada relacion tiene
   * su `onDelete: Cascade` en el esquema. Confiar en la base y no en un barrido
   * a mano es lo que garantiza que una tabla nueva —una que alguien agregue en
   * seis meses— tambien se limpie, en vez de quedarse huerfana porque nadie se
   * acordo de sumarla a la lista de aqui.
   *
   * Lo que si hay que hacer a mano son las dos cosas que la base no sabe:
   *
   * 1. **Soltar los cupos.** Borrar la fila de una inscripcion confirmada no
   *    baja el `slotsTaken` de la maraton: la plaza quedaria ocupada por
   *    alguien que ya no existe. Se cancelan primero, con el mismo camino que
   *    usa el usuario al cancelar a mano, para que ademas vuelva el stock de
   *    los extras y el cobro quede reembolsado.
   * 2. **Borrar los archivos.** Avatar, comprobantes y tarjetas de resultado
   *    viven en disco (o manana en S3), fuera del alcance de cualquier
   *    `ON DELETE CASCADE`.
   *
   * No es soft delete. `deletedAt` esta para lo que duele perder por un
   * descuido —un entrenamiento, una inscripcion—, no para una cuenta que su
   * dueno pidio borrar: eso seria conservar sus datos diciendo que no.
   */
  async borrarCuenta(userId: string): Promise<{ ok: true }> {
    const vigentes = await this.prisma.registration.findMany({
      where: {
        userId,
        status: {
          in: [
            RegistrationStatus.draft,
            RegistrationStatus.pending_payment,
            RegistrationStatus.confirmed,
          ],
        },
        marathon: { startsAt: { gt: new Date() } },
      },
      select: { id: true },
    });

    for (const { id } of vigentes) {
      // Una cancelacion que falle no puede impedir que la cuenta se borre: el
      // derecho al borrado no depende de que un cupo se contabilice bien. Queda
      // en el log para que el organizador pueda cuadrarlo.
      await this.registrations.cancelar(userId, id).catch((error: unknown) => {
        this.logger.warn(
          `No se pudo liberar el cupo de la inscripcion ${id} al borrar la cuenta: ` +
            `${(error as Error).message}`,
        );
      });
    }

    const archivos = await this.archivosDe(userId);

    await this.prisma.user.delete({ where: { id: userId } });

    // Despues del DELETE y nunca antes: si el borrado fallara, un usuario que
    // sigue existiendo se habria quedado sin su avatar y sin sus comprobantes.
    // Al reves, lo peor que pasa es un archivo huerfano en disco.
    for (const clave of archivos) await this.storage.delete(clave);

    this.logger.log(`Cuenta ${userId} borrada (${archivos.length} archivo/s eliminado/s)`);

    return { ok: true };
  }

  /** Claves de storage que cuelgan de este usuario. Se leen ANTES del borrado. */
  private async archivosDe(userId: string): Promise<string[]> {
    const [perfil, pagos, resultados] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { userId }, select: { avatarUrl: true } }),
      this.prisma.payment.findMany({
        where: { registration: { userId }, receiptUrl: { not: null } },
        select: { receiptUrl: true },
      }),
      this.prisma.raceResult.findMany({
        where: { registration: { userId }, shareCardUrl: { not: null } },
        select: { shareCardUrl: true },
      }),
    ]);

    return [
      perfil?.avatarUrl,
      ...pagos.map((p) => p.receiptUrl),
      ...resultados.map((r) => r.shareCardUrl),
    ].filter((clave): clave is string => typeof clave === 'string' && clave.length > 0);
  }

  private toPreferences(prefs: {
    units: string;
    theme: string;
    locale: string;
    notifications: unknown;
    privacy: unknown;
    onboardingSeenAt: Date | null;
  }) {
    return {
      units: prefs.units,
      theme: prefs.theme,
      locale: prefs.locale,
      notifications: asObjeto(prefs.notifications),
      privacy: asObjeto(prefs.privacy),
      onboardingSeenAt: prefs.onboardingSeenAt?.toISOString() ?? null,
    };
  }

  private toHealth(perfil: {
    injuryFlags: unknown;
    avgSleepMinutes: number | null;
    hydrationHabit: string | null;
  }) {
    return {
      injuryFlags: Array.isArray(perfil.injuryFlags) ? perfil.injuryFlags : [],
      avgSleepMinutes: perfil.avgSleepMinutes,
      hydrationHabit: perfil.hydrationHabit,
    };
  }
}

interface PerfilCrudo {
  avatarUrl: string | null;
  city: string | null;
  country: string;
  birthDate: Date | null;
  gender: string;
  weightGrams: number | null;
  heightCm: number | null;
  defaultBibNumber: string | null;
  phone: string | null;
}

/**
 * Merge superficial de dos bolsas de banderas, tipado como jsonb de Prisma.
 * El cast es inevitable: `Record<string, unknown>` admite `undefined` como
 * valor y `InputJsonValue` no, aunque en la practica nunca llegue uno.
 */
function mezclar(guardado: unknown, entrante: Record<string, unknown>): Prisma.InputJsonValue {
  return { ...asObjeto(guardado), ...entrante } as Prisma.InputJsonValue;
}

/** Las columnas jsonb pueden traer cualquier cosa; al cliente le prometemos objeto. */
function asObjeto(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}
