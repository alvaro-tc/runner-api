import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { calcularServiceFee } from '../pricing/service-fee';
import { ServiceFeeConfigService } from '../pricing/service-fee.service';
import { resolverEstado } from '../marathons/registration-status';
import { PaymentsService } from '../payments/payments.service';
import { RacesService } from '../races/races.service';
import {
  MarathonRegistrationStatus,
  PaymentStatus,
  RegistrationStatus,
  ServiceFeeScope,
} from '../../../generated/prisma/enums';
import { aCsv } from './csv';
import type { ImportResultsDto, ServiceFeeConfigDto } from './dto/admin.dto';

/** Subtotal de ejemplo de la vista previa cuando el admin no da uno. */
const SUBTOTAL_DE_EJEMPLO = 20_000;

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
      { header: 'Email', valor: (r) => r.user.email },
      { header: 'Telefono', valor: (r) => dato(r.personalData, 'phone') },
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
      published: m.publishedAt !== null,
      intent: m.registrationStatus,
      resolved: resolverEstado(m),
      registrations: m._count.registrations,
      feeOverride: m.serviceFeeConfig,
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
      email: r.user.email,
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
      email: p.registration.user.email,
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
              { name: { contains: busqueda, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerifiedAt: true,
        createdAt: true,
        _count: { select: { registrations: true, workouts: true } },
      },
    });

    return usuarios.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      verified: u.emailVerifiedAt !== null,
      createdAt: u.createdAt.toISOString(),
      registrations: u._count.registrations,
      workouts: u._count.workouts,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Internos
  // ─────────────────────────────────────────────────────────────────────────

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
function dato(personalData: unknown, campo: string): string {
  if (personalData && typeof personalData === 'object' && !Array.isArray(personalData)) {
    const valor = (personalData as Record<string, unknown>)[campo];
    if (typeof valor === 'string') return valor;
  }

  return '';
}
