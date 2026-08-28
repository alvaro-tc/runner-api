import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { camposPresentes } from '../../common/utils/patch';
import { aSlug } from '../../common/utils/slug';
import { reencodarImagenAWebp } from '../../common/utils/image';
import { AppConfigService } from '../../config/app-config.service';
import { StorageService } from '../storage/storage.service';
import { hashPassword } from '../auth/password';
import { UsersService } from '../users/users.service';
import { calcularServiceFee } from '../pricing/service-fee';
import { ServiceFeeConfigService } from '../pricing/service-fee.service';
import { resolverEstado } from '../marathons/registration-status';
import { PaymentsService } from '../payments/payments.service';
import { RacesService } from '../races/races.service';
import { RoutesService } from '../routes/routes.service';
import { LiveService } from '../realtime/live.service';
import {
  MarathonRegistrationStatus,
  PaymentStatus,
  RegistrationStatus,
  ServiceFeeScope,
  UserRole,
} from '../../../generated/prisma/enums';
import { Prisma } from '../../../generated/prisma/client';
import type { CreateRouteDto, ListRoutesQueryDto, UpdateRouteDto } from '../routes/dto/route.dto';
import { aCsv } from './csv';
import type {
  CategoryFieldsDto,
  CreateCategoryDto,
  CreateExtraDto,
  CreateMarathonDto,
  CreateUserDto,
  ExtraFieldsDto,
  ImportResultsDto,
  MarathonFieldsDto,
  ServiceFeeConfigDto,
  UpdateCategoryDto,
  UpdateExtraDto,
  UpdateMarathonDto,
  UpdateUserDto,
} from './dto/admin.dto';

/** Subtotal de ejemplo de la vista previa cuando el admin no da uno. */
const SUBTOTAL_DE_EJEMPLO = 20_000;

/**
 * Las columnas de usuario que el panel puede ver.
 *
 * Es una lista blanca y no un `omit` a proposito: con `omit`, una columna nueva
 * —un token, una ubicacion— aparece sola en la respuesta el dia que alguien la
 * agregue al esquema. Aqui hay que sumarla a mano, que es justo la friccion que
 * uno quiere delante de los datos personales.
 */
const SELECCION_USUARIO = {
  id: true,
  email: true,
  ci: true,
  name: true,
  role: true,
  emailVerifiedAt: true,
  mustChangePassword: true,
  createdAt: true,
  _count: { select: { registrations: true, workouts: true } },
} as const;

type UsuarioSeleccionado = {
  id: string;
  email: string | null;
  ci: string | null;
  name: string;
  role: UserRole;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
  _count: { registrations: number; workouts: number };
};

/** Listar, crear y editar devuelven la misma forma, para que el panel repinte igual. */
function aUsuarioPublico(u: UsuarioSeleccionado) {
  return {
    id: u.id,
    email: u.email,
    ci: u.ci,
    name: u.name,
    role: u.role,
    verified: u.emailVerifiedAt !== null,
    // El panel lo pinta para saber quien entro por la web y todavia arrastra la
    // CI como contrasena.
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
    registrations: u._count.registrations,
    workouts: u._count.workouts,
  };
}

/**
 * Operaciones de administracion.
 *
 * **Toda la logica del panel vive aqui**, no en el panel. Es la regla que pide
 * el PROMT y la que decide si el front-end web que venga despues puede
 * construirse sin reimplementar nada: la interfaz —hoy una pagina, manana React—
 * solo llama a `/api/v1/admin/*`.
 *
 * Nada de esto reimplementa reglas de otros modulos: publicar toca una columna,
 * pero confirmar un pago pasa por `PaymentsService` y recalcular puestos por
 * `RacesService`. Una segunda implementacion de "confirmar un cobro" es como se
 * acaba con dorsales duplicados.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fees: ServiceFeeConfigService,
    private readonly payments: PaymentsService,
    private readonly races: RacesService,
    private readonly routes: RoutesService,
    private readonly live: LiveService,
    private readonly users: UsersService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  Cargo por servicio
  // ─────────────────────────────────────────────────────────────────────────

  /** La config global y las maratones que la sobrescriben. */
  async verFees() {
    const [global, overrides] = await Promise.all([
      this.fees.global(),
      this.prisma.marathon.findMany({
        where: { serviceFeeConfigId: { not: null } },
        select: { id: true, slug: true, name: true, serviceFeeConfig: true },
        orderBy: { startsAt: 'desc' },
      }),
    ]);

    return { global, overrides };
  }

  /**
   * Activa, desactiva o reconfigura el cargo global.
   *
   * Es un `upsert` sobre la unica fila de alcance global: si el seed no corrio,
   * el primer guardado la crea en vez de fallar con un 404 que no le dice nada
   * a quien solo queria apagar el cargo.
   */
  async guardarFeeGlobal(dto: ServiceFeeConfigDto, adminUserId: string) {
    const existente = await this.fees.global();
    const datos = { ...this.datosDeFee(dto), updatedByUserId: adminUserId };

    const config = existente
      ? await this.prisma.serviceFeeConfig.update({ where: { id: existente.id }, data: datos })
      : await this.prisma.serviceFeeConfig.create({
          data: { ...datos, scope: ServiceFeeScope.global },
        });

    this.logger.log(`Cargo por servicio global ${dto.enabled ? 'activado' : 'desactivado'}`);

    return config;
  }

  /**
   * Override por maraton.
   *
   * El override manda **aunque venga apagado**: una maraton apuntando a una
   * config con `enabled: false` significa "esta carrera no cobra cargo", no
   * "usa la global". Sin eso no habria forma de eximir a una sola carrera.
   */
  async guardarFeeDeMaraton(marathonId: string, dto: ServiceFeeConfigDto, adminUserId: string) {
    const maraton = await this.buscarMaraton(marathonId);
    const datos = { ...this.datosDeFee(dto), updatedByUserId: adminUserId };

    if (maraton.serviceFeeConfigId) {
      return this.prisma.serviceFeeConfig.update({
        where: { id: maraton.serviceFeeConfigId },
        data: datos,
      });
    }

    const config = await this.prisma.serviceFeeConfig.create({
      data: { ...datos, scope: ServiceFeeScope.marathon },
    });

    await this.prisma.marathon.update({
      where: { id: marathonId },
      data: { serviceFeeConfigId: config.id },
    });

    return config;
  }

  /** Quita el override y devuelve la maraton a la config global. */
  async quitarFeeDeMaraton(marathonId: string) {
    const maraton = await this.buscarMaraton(marathonId);
    if (!maraton.serviceFeeConfigId) return { removed: false };

    await this.prisma.marathon.update({
      where: { id: marathonId },
      data: { serviceFeeConfigId: null },
    });
    await this.prisma.serviceFeeConfig.delete({ where: { id: maraton.serviceFeeConfigId } });

    return { removed: true };
  }

  /**
   * Vista previa del efecto sobre un total de ejemplo.
   *
   * Es la mitad util de la accion: un `percentBps: 1000` con `minCents: 500` no
   * le dice a nadie cuanto va a pagar la gente. Se calcula con **la misma
   * funcion** que cobra de verdad, asi que no puede desviarse de la realidad.
   */
  async previsualizarFee(subtotalCents = SUBTOTAL_DE_EJEMPLO, marathonId?: string) {
    const config = marathonId ? await this.fees.resolverPara(marathonId) : await this.fees.global();
    const fee = calcularServiceFee(config, subtotalCents);

    return {
      subtotalCents,
      serviceFeeCents: fee?.amountCents ?? null,
      serviceFeeLabel: fee?.label ?? null,
      totalCents: subtotalCents + (fee?.amountCents ?? 0),
      currency: 'BOB',
      source: config === null ? 'none' : config.scope,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Maratones
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Publicar o despublicar.
   *
   * Despublicar **no cancela nada**: las inscripciones ya vendidas siguen
   * existiendo y sus dueños siguen viendo su carrera. Solo desaparece del
   * catalogo. Lo contrario —que despublicar borrara inscripciones— convertiria
   * un clic en el panel en un incidente.
   */
  async publicar(marathonId: string, publicada: boolean) {
    await this.buscarMaraton(marathonId);

    return this.prisma.marathon.update({
      where: { id: marathonId },
      data: { publishedAt: publicada ? new Date() : null },
      select: { id: true, slug: true, name: true, publishedAt: true },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Largada en vivo
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Da la largada, o la corta.
   *
   * Es lo que pone en marcha el movil de cada corredor, asi que la fecha la
   * pone el **servidor** y no el cliente: si cada telefono arrancara con su
   * propio reloj, dos corredores del mismo pelotón tendrian tiempos oficiales
   * distintos por el desfase de sus relojes.
   *
   * Largar dos veces no reinicia nada: la primera fecha manda. Un segundo clic
   * en "iniciar" —el nervioso, el del dedo gordo en la linea de salida— no
   * puede borrarle diez minutos de carrera a todo el mundo.
   */
  async largar(marathonId: string, arrancar: boolean) {
    const maraton = await this.buscarMaraton(marathonId);

    if (arrancar && maraton.liveFinishedAt) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Esa maraton ya termino',
        HttpStatus.CONFLICT,
      );
    }

    if (!arrancar && !maraton.liveStartedAt) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Esa maraton todavia no arranco',
        HttpStatus.CONFLICT,
      );
    }

    const ahora = new Date();
    const actualizada = await this.prisma.marathon.update({
      where: { id: marathonId },
      data: arrancar
        ? { liveStartedAt: maraton.liveStartedAt ?? ahora }
        : { liveFinishedAt: maraton.liveFinishedAt ?? ahora },
      select: { id: true, slug: true, name: true, liveStartedAt: true, liveFinishedAt: true },
    });

    const estado = {
      marathonId: actualizada.id,
      startedAt: actualizada.liveStartedAt?.toISOString() ?? null,
      finishedAt: actualizada.liveFinishedAt?.toISOString() ?? null,
    };

    // Despues de guardar: si el socket se cayo, la carrera arranco igual y el
    // movil se entera al preguntar por REST.
    this.live.anunciar(estado);
    this.logger.log(`Maraton ${actualizada.slug} ${arrancar ? 'largada' : 'finalizada'}`);

    return { ...estado, slug: actualizada.slug, name: actualizada.name };
  }

  /**
   * Donde va cada corredor ahora mismo.
   *
   * Sale de memoria y no de la base: es lo ultimo que llego por la ingesta, que
   * es exactamente lo que el mapa quiere. Consultar `positions` seria un
   * `DISTINCT ON` sobre una tabla particionada de millones de filas cada vez que
   * el panel refresca.
   */
  async posicionesEnVivo(marathonId: string) {
    const maraton = await this.buscarMaraton(marathonId);

    return {
      marathonId: maraton.id,
      startedAt: maraton.liveStartedAt?.toISOString() ?? null,
      finishedAt: maraton.liveFinishedAt?.toISOString() ?? null,
      runners: this.live.posiciones(marathonId),
    };
  }

  /**
   * Cierra o reabre las inscripciones.
   *
   * `registrationStatus` guarda **la intencion del admin** y solo se respeta
   * cuando dice `closed`; el resto (llena, por cerrar, abierta) se deriva al
   * leer. Por eso "reabrir" no es poner `open` y ya: es devolver la columna a
   * `open` y dejar que los datos manden otra vez.
   */
  async cerrarInscripciones(marathonId: string, cerrar: boolean) {
    const maraton = await this.buscarMaraton(marathonId);

    const actualizada = await this.prisma.marathon.update({
      where: { id: marathonId },
      data: {
        registrationStatus: cerrar
          ? MarathonRegistrationStatus.closed
          : MarathonRegistrationStatus.open,
      },
    });

    this.logger.log(`Inscripciones de ${maraton.slug} ${cerrar ? 'cerradas' : 'reabiertas'}`);

    return {
      id: actualizada.id,
      slug: actualizada.slug,
      intent: actualizada.registrationStatus,
      // Lo que va a ver el cliente, que no tiene por que coincidir con la
      // intencion: una maraton reabierta pero llena sigue saliendo `full`.
      resolved: resolverEstado(actualizada),
      slotsTaken: actualizada.slotsTaken,
      capacity: actualizada.capacity,
    };
  }

  /**
   * Inscritos de una maraton en CSV.
   *
   * Solo las confirmadas: un borrador a medias no es un inscrito, y meterlo en
   * la lista que el organizador usa para imprimir dorsales sobra camisetas.
   */
  async inscritosCsv(marathonId: string): Promise<{ filename: string; csv: string }> {
    const maraton = await this.buscarMaraton(marathonId);

    const registros = await this.prisma.registration.findMany({
      where: {
        marathonId,
        deletedAt: null,
        status: { in: [RegistrationStatus.confirmed, RegistrationStatus.pending_payment] },
      },
      orderBy: [{ bibNumber: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: { select: { email: true, name: true } },
        category: { select: { name: true } },
        payments: {
          where: { status: PaymentStatus.paid },
          orderBy: { paidAt: 'desc' },
          take: 1,
        },
      },
    });

    const csv = aCsv(registros, [
      { header: 'Dorsal', valor: (r) => r.bibNumber },
      { header: 'Nombre', valor: (r) => dato(r.personalData, 'fullName') || r.user.name },
      { header: 'Documento', valor: (r) => dato(r.personalData, 'docId') },
      // El email del formulario manda sobre el de la cuenta: hay corredores
      // que se inscriben sin cuenta propia y solo dejan correo aqui.
      {
        header: 'Email',
        valor: (r) => dato(r.personalData, 'email') || (r.user.email ?? ''),
      },
      { header: 'Telefono', valor: (r) => dato(r.personalData, 'phone') },
      // Las dos preguntas del CAM. Son el motivo por el que el organizador
      // exporta esta lista, no un extra: sin ellas tiene que abrir la BD.
      { header: 'Conoce el CAM', valor: (r) => siNo(r.personalData, 'knowsCam') },
      { header: 'Acepta llamada donante', valor: (r) => siNo(r.personalData, 'acceptsDonorCall') },
      { header: 'Categoria', valor: (r) => r.category?.name ?? '' },
      { header: 'Estado', valor: (r) => r.status },
      { header: 'Total (Bs)', valor: (r) => (r.totalCents / 100).toFixed(2) },
      { header: 'Pagado', valor: (r) => (r.payments.length > 0 ? 'si' : 'no') },
      { header: 'Metodo', valor: (r) => r.payments[0]?.method ?? '' },
      { header: 'Inscrito el', valor: (r) => r.registeredAt },
    ]);

    return { filename: `inscritos-${maraton.slug}.csv`, csv };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Pagos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Da por cobrada una transferencia bancaria.
   *
   * Es la unica accion del panel que mueve dinero, y por eso **no reimplementa
   * nada**: llama a `PaymentsService`, que es quien sabe tomar el cupo y emitir
   * el dorsal en la misma transaccion. Una segunda forma de acreditar un pago es
   * como se acaba con dos personas con el mismo dorsal.
   */
  async confirmarTransferencia(paymentId: string, adminUserId: string, referencia?: string) {
    return this.payments.acreditarManualmente(paymentId, adminUserId, referencia);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Resultados
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Carga los tiempos de una carrera y recalcula los puestos.
   *
   * Los resultados llegan **por dorsal**, que es como los entrega cualquier
   * cronometraje: el organizador no sabe nada de nuestros ids. Un dorsal que no
   * existe no tumba la carga —se devuelve en `unknownBibs`— porque una lista de
   * 3.000 lineas con dos erratas tiene que poder subirse igual.
   *
   * Es idempotente: reimportar el mismo archivo reescribe los mismos
   * resultados. Los puestos se recalculan **una sola vez al final**, no por
   * fila.
   */
  async importarResultados(marathonId: string, dto: ImportResultsDto) {
    const maraton = await this.buscarMaraton(marathonId);

    const dorsales = dto.results.map((r) => r.bibNumber);
    const registros = await this.prisma.registration.findMany({
      where: { marathonId, bibNumber: { in: dorsales }, deletedAt: null },
      select: { id: true, bibNumber: true },
    });

    const porDorsal = new Map(registros.map((r) => [r.bibNumber!, r.id]));
    const unknownBibs: string[] = [];
    let imported = 0;

    for (const fila of dto.results) {
      const registrationId = porDorsal.get(fila.bibNumber);
      if (!registrationId) {
        unknownBibs.push(fila.bibNumber);
        continue;
      }

      const finishedAt = fila.finishedAt
        ? new Date(fila.finishedAt)
        : new Date(maraton.startsAt.getTime() + fila.finishTimeSeconds * 1000);

      const distanceMeters = fila.distanceMeters ?? maraton.distanceMeters;
      const datos = {
        finishTimeSeconds: fila.finishTimeSeconds,
        chipTimeSeconds: fila.chipTimeSeconds ?? null,
        distanceMeters,
        // El ritmo se deriva del tiempo oficial: quien sube un CSV de
        // cronometraje no tiene por que calcularlo, y calcularlo dos veces en
        // sitios distintos es como se desincroniza.
        avgPaceSecPerKm: Math.round((fila.finishTimeSeconds * 1000) / distanceMeters),
        avgSpeedMps: distanceMeters / fila.finishTimeSeconds,
        finishedAt,
      };

      await this.prisma.raceResult.upsert({
        where: { registrationId },
        create: { registrationId, ...datos },
        update: datos,
      });

      imported += 1;
    }

    await this.races.recalcularPuestos(marathonId);

    this.logger.log(
      `Resultados de ${maraton.slug}: ${imported} cargados, ${unknownBibs.length} dorsales desconocidos`,
    );

    return { imported, skipped: unknownBibs.length, unknownBibs };
  }

  /** Recalcula puestos sin tocar tiempos. Para después de corregir uno a mano. */
  async recalcularPuestos(marathonId: string) {
    await this.buscarMaraton(marathonId);
    await this.races.recalcularPuestos(marathonId);

    const results = await this.prisma.raceResult.count({
      where: { registration: { marathonId, deletedAt: null } },
    });

    return { results };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Listados de solo lectura
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Maratones para el panel, publicadas o no.
   *
   * A diferencia del catalogo, aqui **si** salen los borradores: es justo lo que
   * el admin viene a ver. Trae el estado resuelto junto al declarado para que se
   * entienda por que una maraton "abierta" aparece como llena.
   */
  async listarMaratones() {
    const maratones = await this.prisma.marathon.findMany({
      orderBy: { startsAt: 'desc' },
      include: {
        serviceFeeConfig: { select: { id: true, enabled: true, label: true } },
        _count: { select: { registrations: true } },
      },
    });

    return maratones.map((m) => ({
      id: m.id,
      slug: m.slug,
      name: m.name,
      city: m.city,
      startsAt: m.startsAt.toISOString(),
      distanceMeters: m.distanceMeters,
      capacity: m.capacity,
      slotsTaken: m.slotsTaken,
      priceCents: m.priceCents,
      // La lista pinta la miniatura: reconocer una carrera por su afiche es
      // mas rapido que leer trece nombres parecidos.
      coverUrl: this.storage.publicUrl(m.coverUrl),
      published: m.publishedAt !== null,
      intent: m.registrationStatus,
      resolved: resolverEstado(m),
      registrations: m._count.registrations,
      feeOverride: m.serviceFeeConfig,
      // El panel pinta con esto el estado en vivo de la lista sin abrir cada
      // carrera: hay tres, y saber cual esta corriendo es lo primero que se mira.
      liveStartedAt: m.liveStartedAt?.toISOString() ?? null,
      liveFinishedAt: m.liveFinishedAt?.toISOString() ?? null,
    }));
  }

  /** Inscripciones, opcionalmente de una maraton o de un estado. */
  async listarInscripciones(filtros: { marathonId?: string; status?: RegistrationStatus }) {
    const registros = await this.prisma.registration.findMany({
      where: {
        deletedAt: null,
        ...(filtros.marathonId ? { marathonId: filtros.marathonId } : {}),
        ...(filtros.status ? { status: filtros.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        user: { select: { email: true, name: true } },
        marathon: { select: { slug: true, name: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    return registros.map((r) => ({
      id: r.id,
      marathon: r.marathon.name,
      runner: dato(r.personalData, 'fullName') || r.user.name,
      email: r.user.email ?? null,
      bibNumber: r.bibNumber,
      status: r.status,
      totalCents: r.totalCents,
      payment: r.payments[0]
        ? { id: r.payments[0].id, method: r.payments[0].method, status: r.payments[0].status }
        : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Pagos pendientes de confirmar a mano: la bandeja de trabajo del admin. */
  async listarTransferenciasPendientes() {
    const pagos = await this.prisma.payment.findMany({
      where: { status: PaymentStatus.pending, method: 'bank_transfer' },
      orderBy: { createdAt: 'asc' },
      include: {
        registration: {
          select: {
            bibNumber: true,
            personalData: true,
            marathon: { select: { name: true } },
            user: { select: { email: true, name: true } },
          },
        },
      },
    });

    return pagos.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      createdAt: p.createdAt.toISOString(),
      marathon: p.registration.marathon.name,
      runner: dato(p.registration.personalData, 'fullName') || p.registration.user.name,
      email: p.registration.user.email ?? null,
    }));
  }

  /**
   * Usuarios, sin nada sensible.
   *
   * Ni hash de contrasena, ni tokens, ni ubicaciones. El panel sirve para
   * gestionar carreras, no para mirar a la gente: lo que no hace falta aqui no
   * se consulta, y asi no puede filtrarse por un descuido de serializacion.
   */
  async listarUsuarios(busqueda?: string) {
    const usuarios = await this.prisma.user.findMany({
      where: busqueda
        ? {
            OR: [
              { email: { contains: busqueda, mode: 'insensitive' } },
              { ci: { contains: busqueda, mode: 'insensitive' } },
              { name: { contains: busqueda, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: SELECCION_USUARIO,
    });

    return usuarios.map(aUsuarioPublico);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Alta, edicion y baja de maratones
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Crea una maraton.
   *
   * Nace **como borrador** salvo que se pida lo contrario: una carrera recien
   * cargada suele tener la fecha provisional y el precio a medias, y publicarla
   * por defecto la pondria en el catalogo —y en las notificaciones— antes de
   * que nadie la haya revisado. Publicar es un clic mas; despublicar despues de
   * que la vio medio pais, no.
   *
   * El slug se deriva del nombre si no lo mandan, y se desambigua con un sufijo
   * en vez de fallar: quien esta cargando la tercera edicion de una carrera no
   * tiene por que saber que el slug ya existe.
   */
  async crearMaraton(dto: CreateMarathonDto) {
    const slug = await this.slugLibre(dto.slug ?? aSlug(dto.name));
    const heredado = await this.heredarRecorrido(dto.routeId);

    // Con recorrido, la distancia sale de la geometria y no del formulario: el
    // mapa es lo que el corredor va a seguir, y un "42195" escrito a mano junto
    // a un trazado de 38 km deja una carrera cuya meta no esta en el mapa.
    const distanceMeters = heredado?.distanceMeters ?? dto.distanceMeters;

    if (distanceMeters === undefined) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Elegi un recorrido (`routeId`) o indica la distancia en metros',
        HttpStatus.BAD_REQUEST,
      );
    }

    const maraton = await this.prisma.marathon.create({
      data: {
        ...this.datosDeMaraton(dto),
        ...(heredado ?? {}),
        // Prisma exige los obligatorios explicitos: `datosDeMaraton` los
        // devuelve opcionales porque la misma funcion sirve para editar.
        name: dto.name,
        slug,
        startsAt: new Date(dto.startsAt),
        city: dto.city,
        distanceMeters,
        capacity: dto.capacity,
        priceCents: dto.priceCents,
        publishedAt: dto.published ? new Date() : null,
      },
    });

    this.logger.log(`Maraton ${maraton.slug} creada (${dto.published ? 'publicada' : 'borrador'})`);

    return this.detalleMaraton(maraton.id);
  }

  /**
   * Edita una maraton. Lo que no venga en el cuerpo no se toca.
   *
   * `capacity` puede bajarse por debajo de los cupos ya vendidos y **no se
   * impide**: a veces el municipio recorta el cupo despues de vender. Lo que no
   * pasa es que eso cancele inscripciones; la carrera queda sobrevendida y a la
   * vista en el listado (`slotsTaken / capacity`), que es informacion que el
   * organizador necesita, no un error que ocultarle.
   */
  async actualizarMaraton(marathonId: string, dto: UpdateMarathonDto) {
    const actual = await this.buscarMaraton(marathonId);

    const slug =
      dto.slug !== undefined && dto.slug !== actual.slug
        ? await this.slugLibre(dto.slug, marathonId)
        : undefined;

    const heredado = await this.heredarRecorrido(dto.routeId);

    await this.prisma.marathon.update({
      where: { id: marathonId },
      data: {
        ...this.datosDeMaraton(dto),
        // Cambiar de recorrido reescribe geometria, distancia y largada juntas:
        // dejar la distancia vieja con el trazado nuevo es la incoherencia que
        // este bloque existe para impedir.
        ...(heredado ?? {}),
        ...(dto.routeId === null ? { routeId: null } : {}),
        ...(slug ? { slug } : {}),
        // `published` es un booleano de cara al panel y una fecha en la base.
        // Republicar algo ya publicado no debe mover la fecha: es la que dice
        // desde cuando esta en el catalogo.
        ...(dto.published === undefined
          ? {}
          : { publishedAt: dto.published ? (actual.publishedAt ?? new Date()) : null }),
      },
    });

    return this.detalleMaraton(marathonId);
  }

  /**
   * Sube el QR de cobro de una maraton y lo deja listo para el checkout.
   *
   * Reemplaza el campo de texto libre: pedirle al organizador que suba la
   * imagen a otro sitio y pegue la URL es un paso de mas que solo sirve para
   * que alguien la pegue mal. El archivo se reencoda a WebP y queda con la
   * misma clave de storage que cualquier otro binario de la API.
   */
  async subirQr(marathonId: string, archivo: { buffer: Buffer; size: number }) {
    await this.buscarMaraton(marathonId);

    const maximo = this.config.get('PAYMENT_PROOF_MAX_BYTES');
    if (archivo.size > maximo) {
      throw new AppException(
        ErrorCode.FILE_TOO_LARGE,
        `La imagen supera el maximo de ${Math.round(maximo / 1024 / 1024)} MB`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const webp = await reencodarImagenAWebp(archivo.buffer, {
      maxWidthPx: this.config.get('PAYMENT_PROOF_MAX_WIDTH_PX'),
    });
    const clave = `marathons/qr/${marathonId}/${randomUUID()}.webp`;
    await this.storage.save(clave, webp);

    await this.prisma.marathon.update({
      where: { id: marathonId },
      data: { paymentQrUrl: clave },
    });

    this.logger.log(`QR de cobro actualizado para la maraton ${marathonId}`);

    return this.detalleMaraton(marathonId);
  }

  /**
   * Sube la foto de la maraton: el afiche que el corredor ve en el catalogo.
   *
   * Mismo trato que el QR y por la misma razon. `coverUrl` nacio como campo de
   * texto y aceptaba una URL cualquiera, lo que dejaba el afiche colgando de un
   * servidor ajeno: el dia que ese enlace muere, la carrera se queda sin
   * imagen y nadie se entera. Subiendola, el archivo es nuestro y la columna
   * guarda una clave de storage como todas las demas.
   *
   * Se admite mas ancho que en un comprobante porque esto se pinta a pantalla
   * completa como cabecera, no se lee de cerca buscando un numero.
   */
  async subirPortada(marathonId: string, archivo: { buffer: Buffer; size: number }) {
    await this.buscarMaraton(marathonId);

    const maximo = this.config.get('MARATHON_COVER_MAX_BYTES');
    if (archivo.size > maximo) {
      throw new AppException(
        ErrorCode.FILE_TOO_LARGE,
        `La imagen supera el maximo de ${Math.round(maximo / 1024 / 1024)} MB`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const webp = await reencodarImagenAWebp(archivo.buffer, {
      maxWidthPx: this.config.get('MARATHON_COVER_MAX_WIDTH_PX'),
    });
    const clave = `marathons/cover/${marathonId}/${randomUUID()}.webp`;
    await this.storage.save(clave, webp);

    await this.prisma.marathon.update({
      where: { id: marathonId },
      data: { coverUrl: clave },
    });

    this.logger.log(`Portada actualizada para la maraton ${marathonId}`);

    return this.detalleMaraton(marathonId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Recorridos preestablecidos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * El panel delega entero en `RoutesService`.
   *
   * No hay logica aqui a proposito: medir una geometria y decidir si es valida
   * es una sola regla, y una segunda copia en admin es como se acaba con el
   * panel aceptando trazados que la API publica rechaza.
   */
  listarRecorridos(query: ListRoutesQueryDto) {
    return this.routes.listar(query);
  }

  verRecorrido(id: string) {
    return this.routes.detalle(id, true);
  }

  crearRecorrido(dto: CreateRouteDto) {
    return this.routes.crear(dto);
  }

  actualizarRecorrido(id: string, dto: UpdateRouteDto) {
    return this.routes.actualizar(id, dto);
  }

  borrarRecorrido(id: string) {
    return this.routes.borrar(id);
  }

  /**
   * Borra una maraton, y **solo** si nadie se inscribio.
   *
   * El esquema borra las inscripciones en cascada, asi que un DELETE sobre una
   * carrera vendida se llevaria por delante pagos, dorsales y resultados sin
   * preguntar. Con inscritos la accion correcta es despublicar —la carrera
   * desaparece del catalogo y sus inscritos siguen viendo la suya— y por eso el
   * mensaje del error lo dice en vez de limitarse a negarse.
   */
  async borrarMaraton(marathonId: string) {
    const maraton = await this.buscarMaraton(marathonId);

    const inscritos = await this.prisma.registration.count({ where: { marathonId } });
    if (inscritos > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `No se puede borrar: ${inscritos} inscripcion/es dependen de esta maraton. ` +
          'Despublicala para sacarla del catalogo sin perder nada.',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.marathon.delete({ where: { id: marathonId } });
    this.logger.warn(`Maraton ${maraton.slug} borrada`);

    return { deleted: true, slug: maraton.slug };
  }

  /** Una maraton con sus categorias y extras: lo que pinta el formulario de edicion. */
  async detalleMaraton(marathonId: string) {
    const maraton = await this.prisma.marathon.findUnique({
      where: { id: marathonId },
      include: {
        categories: { orderBy: { name: 'asc' } },
        extras: { orderBy: { name: 'asc' } },
        serviceFeeConfig: { select: { id: true, enabled: true, label: true } },
        _count: { select: { registrations: true } },
      },
    });

    if (!maraton) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La maraton no existe', HttpStatus.NOT_FOUND);
    }

    return {
      id: maraton.id,
      slug: maraton.slug,
      name: maraton.name,
      description: maraton.description,
      startsAt: maraton.startsAt.toISOString(),
      timezone: maraton.timezone,
      city: maraton.city,
      country: maraton.country,
      lat: maraton.lat,
      lng: maraton.lng,
      distanceMeters: maraton.distanceMeters,
      capacity: maraton.capacity,
      slotsTaken: maraton.slotsTaken,
      priceCents: maraton.priceCents,
      currency: maraton.currency,
      registrationStatus: maraton.registrationStatus,
      resolved: resolverEstado(maraton),
      registrationClosesAt: maraton.registrationClosesAt?.toISOString() ?? null,
      // Resuelto a URL publica igual que en el catalogo: desde que la
      // portada se sube, la columna guarda una clave de storage y el panel
      // necesita pintarla en la vista previa.
      coverUrl: this.storage.publicUrl(maraton.coverUrl),
      // TEMPORAL — cobro por QR manual. Ver `docs/pago-qr-manual.md`.
      // Resuelto a URL publica (como en `MarathonsService`): el panel la pinta
      // en una vista previa y una clave de storage relativa no le sirve.
      paymentQrUrl: this.storage.publicUrl(maraton.paymentQrUrl),
      paymentQrInstructions: maraton.paymentQrInstructions,
      schedule: maraton.schedule,
      includes: maraton.includes,
      kitPickup: maraton.kitPickup,
      routeGeoJson: maraton.routeGeoJson,
      // De donde salio el trazado. El panel lo necesita para dejar el selector
      // de recorrido marcado al abrir la edicion.
      routeId: maraton.routeId,
      published: maraton.publishedAt !== null,
      publishedAt: maraton.publishedAt?.toISOString() ?? null,
      liveStartedAt: maraton.liveStartedAt?.toISOString() ?? null,
      liveFinishedAt: maraton.liveFinishedAt?.toISOString() ?? null,
      registrations: maraton._count.registrations,
      feeOverride: maraton.serviceFeeConfig,
      categories: maraton.categories,
      extras: maraton.extras,
    };
  }

  // ─── Categorias ──────────────────────────────────────────────────────────

  async crearCategoria(marathonId: string, dto: CreateCategoryDto) {
    await this.buscarMaraton(marathonId);

    return this.prisma.marathonCategory.create({
      data: { marathonId, ...this.datosDeCategoria(dto), name: dto.name },
    });
  }

  async actualizarCategoria(categoryId: string, dto: UpdateCategoryDto) {
    await this.buscarCategoria(categoryId);

    return this.prisma.marathonCategory.update({
      where: { id: categoryId },
      data: this.datosDeCategoria(dto),
    });
  }

  /**
   * Borra una categoria.
   *
   * Las inscripciones que la usaban **no se borran**: la relacion es
   * `onDelete: SetNull`, asi que se quedan sin categoria pero con su dorsal y su
   * pago intactos. Aun asi se avisa de cuantas quedaron sueltas, porque es algo
   * que el organizador va a querer arreglar antes de imprimir resultados.
   */
  async borrarCategoria(categoryId: string) {
    const categoria = await this.buscarCategoria(categoryId);
    const afectadas = await this.prisma.registration.count({ where: { categoryId } });

    await this.prisma.marathonCategory.delete({ where: { id: categoryId } });

    return { deleted: true, name: categoria.name, registrationsWithoutCategory: afectadas };
  }

  // ─── Extras ──────────────────────────────────────────────────────────────

  async crearExtra(marathonId: string, dto: CreateExtraDto) {
    await this.buscarMaraton(marathonId);

    return this.prisma.marathonExtra.create({
      data: {
        marathonId,
        ...this.datosDeExtra(dto),
        name: dto.name,
        priceCents: dto.priceCents,
      },
    });
  }

  async actualizarExtra(extraId: string, dto: UpdateExtraDto) {
    await this.buscarExtra(extraId);

    return this.prisma.marathonExtra.update({
      where: { id: extraId },
      data: this.datosDeExtra(dto),
    });
  }

  /**
   * Borra un extra.
   *
   * Lo ya vendido no se pierde: los extras de una inscripcion viven copiados en
   * su `quoteSnapshot`, no como una referencia a esta fila. Borrarlo solo
   * significa que deja de poder comprarse.
   */
  async borrarExtra(extraId: string) {
    const extra = await this.buscarExtra(extraId);
    await this.prisma.marathonExtra.delete({ where: { id: extraId } });

    return { deleted: true, name: extra.name };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Alta, edicion y baja de usuarios
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Da de alta una cuenta desde el panel.
   *
   * Es la unica forma de crear un administrador: el registro publico crea
   * `runner` y punto, porque un endpoint abierto que acepte `role` es un
   * escalado de privilegios esperando a que alguien lo pruebe.
   *
   * El hash usa **los mismos parametros** que el registro normal
   * (`hashPassword`), no una copia local: dos juegos de parametros distintos
   * darian cuentas con seguridad distinta segun por donde entraron.
   */
  async crearUsuario(dto: CreateUserDto) {
    const existente = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });

    if (existente) {
      throw new AppException(
        ErrorCode.EMAIL_ALREADY_REGISTERED,
        'Ya existe una cuenta con ese email',
        HttpStatus.CONFLICT,
      );
    }

    const usuario = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        passwordHash: await hashPassword(dto.password),
        role: dto.role ?? UserRole.runner,
        // Igual que en el registro: perfil y preferencias nacen con el usuario,
        // asi ningun endpoint tiene que preguntarse si existen.
        emailVerifiedAt: dto.verified === false ? null : new Date(),
        profile: { create: {} },
        preferences: { create: {} },
      },
    });

    this.logger.log(`Usuario ${usuario.email} creado con rol ${usuario.role}`);

    return this.usuarioPublico(usuario.id);
  }

  /**
   * Edita nombre, email, rol o verificacion.
   *
   * Un admin **no puede quitarse a si mismo el rol**: seria dejar el panel sin
   * nadie que pueda entrar, y recuperarlo requiere tocar la base a mano. Que lo
   * haga otro admin, que es la comprobacion que ya existe de verdad.
   */
  async actualizarUsuario(userId: string, dto: UpdateUserDto, adminUserId: string) {
    const actual = await this.buscarUsuario(userId);

    if (dto.role && dto.role !== UserRole.admin && userId === adminUserId) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'No puedes quitarte a ti mismo el rol de administrador',
        HttpStatus.CONFLICT,
      );
    }

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
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...camposPresentes(dto, ['email', 'name', 'role']),
        ...(dto.verified === undefined
          ? {}
          : // Verificar dos veces no debe mover la fecha: dice cuando se
            // verifico, no cuando se guardo el formulario por ultima vez.
            { emailVerifiedAt: dto.verified ? (actual.emailVerifiedAt ?? new Date()) : null }),
      },
    });

    return this.usuarioPublico(userId);
  }

  /**
   * Le pone una contrasena nueva a alguien.
   *
   * **Cierra todas sus sesiones.** Un reset que deja vivos los refresh tokens no
   * sirve para lo unico que se usa de verdad —sacar a quien no deberia estar
   * dentro—, porque el intruso sigue renovando su token sin saber la contrasena
   * nueva.
   */
  async cambiarPassword(userId: string, password: string) {
    const usuario = await this.buscarUsuario(userId);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password) },
    });

    const { count } = await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.logger.warn(
      `Contrasena de ${usuario.email} cambiada por un admin (${count} sesion/es cerradas)`,
    );

    return { ok: true, sessionsRevoked: count };
  }

  /**
   * Borra una cuenta.
   *
   * No reimplementa el borrado: llama a `UsersService.borrarCuenta`, que es
   * quien sabe soltar los cupos de las carreras futuras y limpiar los archivos
   * de disco. Un `DELETE` directo aqui dejaria plazas ocupadas por alguien que
   * ya no existe y avatares huerfanos.
   *
   * Un admin no puede borrarse a si mismo desde el panel: para eso esta el
   * borrado de cuenta propio, que pide confirmacion del dueno.
   */
  async borrarUsuario(userId: string, adminUserId: string) {
    if (userId === adminUserId) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'No puedes borrar tu propia cuenta desde el panel',
        HttpStatus.CONFLICT,
      );
    }

    const usuario = await this.buscarUsuario(userId);
    await this.users.borrarCuenta(userId);

    this.logger.warn(`Cuenta ${usuario.email} borrada desde el panel por ${adminUserId}`);

    return { deleted: true, email: usuario.email };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Internos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Los campos editables de una maraton, listos para Prisma.
   *
   * Va por `camposPresentes` y no por `{ ...dto }` porque en una edicion parcial
   * "ausente" y "vaciar" no son lo mismo: `description: undefined` tiene que
   * dejar la descripcion como estaba, y `description: null` borrarla. Copiar el
   * dto entero mete las claves ausentes como `undefined` y hace imposible
   * distinguirlas.
   */
  private datosDeMaraton(dto: MarathonFieldsDto): Partial<Prisma.MarathonUncheckedCreateInput> {
    const datos: Partial<Prisma.MarathonUncheckedCreateInput> = camposPresentes(dto, [
      'name',
      'description',
      'timezone',
      'city',
      'country',
      'lat',
      'lng',
      'distanceMeters',
      'capacity',
      'priceCents',
      'currency',
      'registrationStatus',
      'coverUrl',
      // TEMPORAL — cobro por QR manual. Ver `docs/pago-qr-manual.md`.
      'paymentQrUrl',
      'paymentQrInstructions',
    ]);

    if (dto.startsAt !== undefined) datos.startsAt = new Date(dto.startsAt);
    if (dto.registrationClosesAt !== undefined) {
      datos.registrationClosesAt = dto.registrationClosesAt
        ? new Date(dto.registrationClosesAt)
        : null;
    }

    // Las columnas jsonb no aceptan `null` a secas: en Prisma eso significa "no
    // toques el campo". `DbNull` es el NULL de la base de verdad.
    if (dto.schedule !== undefined) datos.schedule = dto.schedule as Prisma.InputJsonValue;
    if (dto.includes !== undefined) datos.includes = dto.includes as Prisma.InputJsonValue;
    if (dto.kitPickup !== undefined) {
      datos.kitPickup =
        dto.kitPickup === null ? Prisma.DbNull : (dto.kitPickup as Prisma.InputJsonValue);
    }
    if (dto.routeGeoJson !== undefined) {
      datos.routeGeoJson =
        dto.routeGeoJson === null ? Prisma.DbNull : (dto.routeGeoJson as Prisma.InputJsonValue);
    }

    return datos;
  }

  /**
   * Lo que la maraton copia del recorrido elegido, o `null` si no se eligio.
   *
   * `undefined` (no vino el campo) y `null` (desvincular) no son lo mismo: el
   * primero no toca nada, el segundo suelta el recorrido dejando la geometria
   * ya copiada donde esta. Borrarla tambien seria dejar la carrera sin mapa por
   * un cambio administrativo.
   */
  private async heredarRecorrido(routeId: string | null | undefined) {
    if (!routeId) return null;

    return this.routes.paraMaraton(routeId);
  }

  private datosDeCategoria(dto: CategoryFieldsDto) {
    return camposPresentes(dto, ['name', 'minAge', 'maxAge', 'gender', 'extraPriceCents']);
  }

  private datosDeExtra(dto: ExtraFieldsDto) {
    return camposPresentes(dto, ['name', 'priceCents', 'stock']);
  }

  /**
   * Un slug que no choque con otra maraton.
   *
   * Desambigua con `-2`, `-3`… en vez de rechazar el alta: quien carga la
   * tercera edicion de una carrera escribe el mismo nombre a proposito, y
   * pedirle que invente un identificador unico es pedirle que resuelva un
   * problema nuestro.
   */
  private async slugLibre(base: string, excluyendoId?: string): Promise<string> {
    const raiz = base || 'maraton';

    for (let intento = 1; ; intento += 1) {
      const candidato = intento === 1 ? raiz : `${raiz}-${intento}`;
      const chocando = await this.prisma.marathon.findUnique({
        where: { slug: candidato },
        select: { id: true },
      });

      if (!chocando || chocando.id === excluyendoId) return candidato;
    }
  }

  private async buscarCategoria(categoryId: string) {
    const categoria = await this.prisma.marathonCategory.findUnique({ where: { id: categoryId } });

    if (!categoria) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La categoria no existe', HttpStatus.NOT_FOUND);
    }

    return categoria;
  }

  private async buscarExtra(extraId: string) {
    const extra = await this.prisma.marathonExtra.findUnique({ where: { id: extraId } });

    if (!extra) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El adicional no existe', HttpStatus.NOT_FOUND);
    }

    return extra;
  }

  private async buscarUsuario(userId: string) {
    const usuario = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!usuario || usuario.deletedAt) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El usuario no existe', HttpStatus.NOT_FOUND);
    }

    return usuario;
  }

  /**
   * Un usuario con la misma forma que los del listado.
   *
   * Que crear, editar y listar devuelvan lo mismo es lo que permite al panel
   * repintar una fila sin recargar la tabla entera, y lo que evita que el hash
   * de la contrasena se cuele en una respuesta por no haber elegido las
   * columnas a mano en tres sitios distintos.
   */
  private async usuarioPublico(userId: string) {
    const usuario = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: SELECCION_USUARIO,
    });

    return aUsuarioPublico(usuario);
  }

  private async buscarMaraton(marathonId: string) {
    const maraton = await this.prisma.marathon.findUnique({ where: { id: marathonId } });

    if (!maraton) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La maraton no existe', HttpStatus.NOT_FOUND);
    }

    return maraton;
  }

  /** Los campos de una config, sin el alcance: ese lo pone quien la crea. */
  private datosDeFee(dto: ServiceFeeConfigDto) {
    return {
      enabled: dto.enabled,
      type: dto.type,
      percentBps: dto.percentBps ?? null,
      fixedCents: dto.fixedCents ?? null,
      minCents: dto.minCents ?? null,
      maxCents: dto.maxCents ?? null,
      ...(dto.label ? { label: dto.label } : {}),
    };
  }
}

/** `personalData` es jsonb libre: una fila vieja no debe tumbar un CSV. */
/**
 * Lector de los booleanos del formulario para el CSV.
 *
 * Un campo ausente sale vacio y **no** como "no": una inscripcion vieja, de
 * antes de que existiera la pregunta, no respondio que no — no respondio.
 */
function siNo(personalData: unknown, campo: string): string {
  if (personalData && typeof personalData === 'object' && !Array.isArray(personalData)) {
    const valor = (personalData as Record<string, unknown>)[campo];
    if (typeof valor === 'boolean') return valor ? 'si' : 'no';
  }

  return '';
}

function dato(personalData: unknown, campo: string): string {
  if (personalData && typeof personalData === 'object' && !Array.isArray(personalData)) {
    const valor = (personalData as Record<string, unknown>)[campo];
    if (typeof valor === 'string') return valor;
  }

  return '';
}
