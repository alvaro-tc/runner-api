import { HttpStatus, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MarathonsService } from '../marathons/marathons.service';
import { admiteInscripcion, resolverEstado } from '../marathons/registration-status';
import { QuoteService, type Cotizacion, type LineaCotizacion } from '../pricing/quote.service';
import { PaymentsService } from '../payments/payments.service';
import type { Prisma } from '../../../generated/prisma/client';
import { RegistrationStatus } from '../../../generated/prisma/enums';
import { armarDorsal } from './bib-number';
import type {
  CreateRegistrationDto,
  ListRegistrationsQueryDto,
  UpdateCategoryExtrasDto,
} from './dto/registration.dto';

/** Estados en los que la inscripcion todavia se edita. */
const EDITABLES: RegistrationStatus[] = [
  RegistrationStatus.draft,
  RegistrationStatus.pending_payment,
];

/** Estados que ocupan un cupo y bloquean una segunda inscripcion. */
const VIGENTES: RegistrationStatus[] = [
  RegistrationStatus.draft,
  RegistrationStatus.pending_payment,
  RegistrationStatus.confirmed,
];

/**
 * Lo que se trae de la maraton junto a la inscripcion.
 *
 * Incluye los cuatro campos que necesita `resolverEstado()` ademas de los que
 * ve el cliente: sin ellos habria que ir a buscar la maraton otra vez solo para
 * saber si las inscripciones siguen abiertas.
 */
const MARATON_DEL_RESUMEN = {
  id: true,
  slug: true,
  name: true,
  startsAt: true,
  timezone: true,
  city: true,
  distanceMeters: true,
  registrationStatus: true,
  capacity: true,
  slotsTaken: true,
  registrationClosesAt: true,
} as const;

type RegistroConMaraton = Prisma.RegistrationGetPayload<{
  include: { marathon: { select: typeof MARATON_DEL_RESUMEN } };
}>;

@Injectable()
export class RegistrationsService {
  private readonly logger = new Logger(RegistrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marathons: MarathonsService,
    private readonly quotes: QuoteService,
    // Referencia diferida: pagos depende de inscripciones para confirmar, e
    // inscripciones de pagos para reembolsar al cancelar. El ciclo es real —lo
    // es en el dominio, no solo en el codigo— y `forwardRef` es la forma que da
    // Nest de declararlo en vez de disimularlo moviendo logica de sitio.
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  Paso 1 — datos personales
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Crea el borrador, o **devuelve el que ya existe** actualizando sus datos.
   *
   * Volver a empezar el flujo no crea una segunda inscripcion: el usuario que
   * cierra la app en el paso 2 y vuelve manana entra de nuevo por aca, y espera
   * encontrar lo suyo, no un duplicado. Es lo mismo que hace `PUT` sin serlo.
   */
  async crear(userId: string, dto: CreateRegistrationDto) {
    const maraton = await this.marathons.buscarVisibleOFallar(dto.marathonId);
    this.exigirInscripcionAbierta(maraton);

    const existente = await this.prisma.registration.findFirst({
      where: { userId, marathonId: maraton.id, status: { in: VIGENTES }, deletedAt: null },
    });

    if (existente && !EDITABLES.includes(existente.status)) {
      throw new AppException(
        ErrorCode.ALREADY_REGISTERED,
        'Ya estas inscrito en esta maraton',
        HttpStatus.CONFLICT,
      );
    }

    const personalData = dto.personalData as unknown as Prisma.InputJsonValue;

    const registro = existente
      ? await this.prisma.registration.update({
          where: { id: existente.id },
          data: { personalData, step: Math.max(existente.step, 1) },
          include: { marathon: { select: MARATON_DEL_RESUMEN } },
        })
      : await this.prisma.registration.create({
          data: {
            userId,
            marathonId: maraton.id,
            personalData,
            step: 1,
            currency: maraton.currency,
          },
          include: { marathon: { select: MARATON_DEL_RESUMEN } },
        });

    return this.conCotizacionViva(registro);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Paso 2 — categoria y extras
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * La lista de extras **reemplaza** a la anterior, no se suma.
   *
   * Es el estado de una pantalla con checkboxes: lo que manda el cliente es la
   * seleccion completa. Sumar obligaria a inventar un endpoint para quitar.
   */
  async actualizarCategoriaYExtras(userId: string, id: string, dto: UpdateCategoryExtrasDto) {
    const registro = await this.buscarPropia(userId, id);
    this.exigirEditable(registro);
    this.exigirInscripcionAbierta(registro.marathon);

    const categoryId =
      dto.categoryId === undefined ? registro.categoryId : (dto.categoryId ?? null);
    const extras = dto.extras ?? this.extrasGuardados(registro);

    // Cotizar valida de paso que la categoria y los extras sean de esta
    // maraton y que haya stock: no hace falta repetir esas comprobaciones.
    const cotizacion = await this.quotes.cotizar({
      marathonId: registro.marathonId,
      categoryId,
      extras,
    });

    const actualizado = await this.prisma.registration.update({
      where: { id: registro.id },
      data: {
        categoryId,
        // Se guardan los extras YA resueltos por la cotizacion (con nombre y
        // precio del dia), no lo que mando el cliente: asi el paso 3 y el
        // listado leen lo mismo que se le mostro, sin volver a resolver ids.
        extras: this.extrasPersistidos(cotizacion.items),
        step: Math.max(registro.step, 2),
        ...this.totalesDe(cotizacion),
      },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    return this.toDto(actualizado, cotizacion);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Consulta
  // ─────────────────────────────────────────────────────────────────────────

  async listar(userId: string, query: ListRegistrationsQueryDto) {
    const marathonId = query.marathonId
      ? (await this.marathons.buscarVisibleOFallar(query.marathonId)).id
      : undefined;

    const registros = await this.prisma.registration.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(marathonId ? { marathonId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    // El listado NO recotiza: serian tantas cotizaciones como inscripciones, y
    // los totales guardados alcanzan para una lista. El detalle si recotiza.
    return registros.map((r) => this.toDto(r, null));
  }

  async obtener(userId: string, id: string) {
    const registro = await this.buscarPropia(userId, id);
    return this.conCotizacionViva(registro);
  }

  /**
   * Total en vivo del paso 3.
   *
   * Para un borrador recotiza con los precios de hoy; para una inscripcion ya
   * confirmada devuelve el desglose **congelado**, que es lo que se cobro.
   */
  async cotizar(userId: string, id: string): Promise<Cotizacion | CotizacionCongelada> {
    const registro = await this.buscarPropia(userId, id);

    const congelada = this.cotizacionCongelada(registro);
    if (congelada) return congelada;

    return this.cotizacionDe(registro);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Paso 3 — pago y confirmacion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deja la inscripcion lista para cobrar y devuelve el importe a cobrar.
   *
   * Es la primera mitad del paso 3: valida todo lo que se puede validar antes
   * de tocarle la tarjeta a nadie —que las inscripciones sigan abiertas, que
   * queden cupos, que este la categoria y los datos personales— y **recotiza**.
   * No se confia en el total que vio el cliente: si el organizador cambio un
   * precio mientras el usuario dudaba, se cobra el real.
   *
   * Deja el registro en `pending_payment` con el desglose ya congelado, para
   * que el comprobante diga exactamente lo que se cobro aunque los precios
   * cambien manana. El cupo **todavia no se toma**: eso pasa en
   * `confirmarPago()`, en la transaccion que asigna el dorsal.
   *
   * La comprobacion de cupo de aca es optimista y puede quedar obsoleta entre
   * el cobro y la confirmacion. Es deliberado: sirve para no cobrarle a alguien
   * una carrera que ya estaba llena, y el caso de borde —el ultimo cupo se va
   * mientras se procesa la tarjeta— lo cubre el reembolso compensatorio de
   * `PaymentsService`.
   */
  async prepararParaPago(
    userId: string,
    id: string,
  ): Promise<{ registro: RegistroConMaraton; cotizacion: Cotizacion }> {
    const previa = await this.buscarPropia(userId, id);
    this.exigirEditable(previa);

    if (!previa.personalData || Object.keys(previa.personalData).length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Faltan los datos personales del paso 1',
        HttpStatus.BAD_REQUEST,
      );
    }

    const maraton = await this.prisma.marathon.findUniqueOrThrow({
      where: { id: previa.marathonId },
    });
    this.exigirInscripcionAbierta(maraton);
    this.exigirCupo(maraton);
    await this.exigirCategoriaSiCorresponde(this.prisma, previa);

    const cotizacion = await this.cotizacionDe(previa);

    const registro = await this.prisma.registration.update({
      where: { id: previa.id },
      data: {
        status: RegistrationStatus.pending_payment,
        step: 3,
        termsAcceptedAt: previa.termsAcceptedAt ?? new Date(),
        ...this.totalesDe(cotizacion),
      },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    return { registro, cotizacion };
  }

  /**
   * Segunda mitad del paso 3: con el cobro ya aprobado, reserva cupo,
   * descuenta stock y asigna dorsal.
   *
   * Todo ocurre dentro de **una transaccion con la fila de la maraton
   * bloqueada** (`SELECT ... FOR UPDATE`). Sin ese lock, dos personas comprando
   * el ultimo cupo a la vez leen `slotsTaken = 999`, las dos concluyen que hay
   * lugar y las dos entran: la carrera termina con un corredor de mas y un
   * dorsal duplicado. El lock los serializa y el segundo recibe
   * `MARATHON_FULL`.
   *
   * No recibe `userId` a proposito: tambien lo llama el webhook del proveedor
   * (checkpoint 8c), donde no hay usuario autenticado. La autorizacion ya se
   * hizo en `prepararParaPago()`.
   *
   * Es **idempotente**: una inscripcion ya confirmada se devuelve tal cual. El
   * webhook de un PSP se reintenta, y un reintento no puede consumir un segundo
   * cupo ni emitir un segundo dorsal.
   */
  async confirmarPago(registrationId: string) {
    const previa = await this.prisma.registration.findUniqueOrThrow({
      where: { id: registrationId },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    if (previa.status === RegistrationStatus.confirmed) {
      return this.toDto(previa, null);
    }

    const actualizado = await this.prisma.$transaction(async (tx) => {
      // Bloquea la fila de la maraton hasta el final de la transaccion. Todo lo
      // que sigue —cupo, stock, correlativo del dorsal— se lee y escribe con la
      // garantia de que nadie mas esta haciendo lo mismo en esta carrera.
      await tx.$queryRaw`SELECT id FROM marathons WHERE id = ${previa.marathonId} FOR UPDATE`;

      const maraton = await tx.marathon.findUniqueOrThrow({ where: { id: previa.marathonId } });
      this.exigirInscripcionAbierta(maraton);
      this.exigirCupo(maraton);

      // Se cobro el desglose congelado en `prepararParaPago()`, asi que es ese
      // el que manda: recotizar aca podria descontar un stock que no se cobro.
      const items = this.itemsGuardados(previa);

      await this.exigirCategoriaSiCorresponde(tx, previa);
      await this.descontarStock(tx, previa.marathonId, items);

      // El correlativo cuenta los dorsales YA emitidos, incluidos los de
      // inscripciones canceladas: esas conservan su dorsal, asi que el contador
      // solo sube y nunca reutiliza un numero. El constraint unico
      // `(marathonId, bibNumber)` es la red de seguridad.
      const emitidos = await tx.registration.count({
        where: { marathonId: previa.marathonId, bibNumber: { not: null } },
      });

      await tx.marathon.update({
        where: { id: previa.marathonId },
        data: { slotsTaken: { increment: 1 } },
      });

      return tx.registration.update({
        where: { id: previa.id },
        data: {
          status: RegistrationStatus.confirmed,
          step: 3,
          bibNumber: previa.bibNumber ?? armarDorsal(maraton.name, emitidos + 1),
          registeredAt: previa.registeredAt ?? new Date(),
          extras: this.extrasPersistidos(items),
        },
        include: { marathon: { select: MARATON_DEL_RESUMEN } },
      });
    });

    this.logger.log(
      `Inscripcion confirmada ${actualizado.id} (dorsal ${actualizado.bibNumber ?? '-'})`,
    );

    return this.toDto(actualizado, null);
  }

  /** Vuelve al estado anterior al cobro cuando el pago se rechaza o se cae. */
  async devolverAPendiente(registrationId: string) {
    const registro = await this.prisma.registration.update({
      where: { id: registrationId },
      data: { status: RegistrationStatus.pending_payment },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    return this.conCotizacionViva(registro);
  }

  /** El detalle de una inscripcion propia, ya en forma de DTO. */
  async detalleDe(registrationId: string) {
    const registro = await this.prisma.registration.findUniqueOrThrow({
      where: { id: registrationId },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    return this.conCotizacionViva(registro);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Cancelacion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cancela y **libera** el cupo y el stock, dentro del mismo lock.
   *
   * El dorsal NO se borra: la inscripcion cancelada lo conserva como registro
   * historico, y eso es justamente lo que hace que el correlativo nunca
   * reutilice un numero.
   *
   * El reembolso va **despues** de liberar el cupo, y no puede tumbar la
   * cancelacion. Si el proveedor esta caido, el cupo ya volvio al pozo y lo que
   * queda pendiente es devolver dinero, resoluble a mano desde el panel. Al
   * reves, un fallo dejaria la plaza bloqueada para siempre.
   */
  async cancelar(userId: string, id: string) {
    const registro = await this.buscarPropia(userId, id);

    if (registro.status === RegistrationStatus.cancelled) {
      // Idempotente: cancelar dos veces no es un error del usuario.
      return this.toDto(registro, null);
    }

    if (!VIGENTES.includes(registro.status)) {
      throw new AppException(
        ErrorCode.CANCELLATION_NOT_ALLOWED,
        'Esta inscripcion no se puede cancelar',
        HttpStatus.CONFLICT,
      );
    }

    if (registro.marathon.startsAt.getTime() <= Date.now()) {
      throw new AppException(
        ErrorCode.CANCELLATION_NOT_ALLOWED,
        'La carrera ya ocurrio: no se puede cancelar la inscripcion',
        HttpStatus.CONFLICT,
      );
    }

    const ocupabaCupo = registro.status === RegistrationStatus.confirmed;

    const actualizado = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM marathons WHERE id = ${registro.marathonId} FOR UPDATE`;

      if (ocupabaCupo) {
        // `Math.max(0, ...)` no existe en un `decrement`, asi que se acota con
        // el where: si el contador ya esta en 0 no baja a negativo.
        await tx.marathon.updateMany({
          where: { id: registro.marathonId, slotsTaken: { gt: 0 } },
          data: { slotsTaken: { decrement: 1 } },
        });

        await this.devolverStock(tx, registro.marathonId, this.itemsGuardados(registro));
      }

      return tx.registration.update({
        where: { id: registro.id },
        data: { status: RegistrationStatus.cancelled, cancelledAt: new Date() },
        include: { marathon: { select: MARATON_DEL_RESUMEN } },
      });
    });

    // Primero se cierran los cobros abiertos y despues se reembolsan los
    // cobrados: si no, un QR pendiente se queda vivo sobre una inscripcion
    // muerta y el organizador puede aprobar su comprobante, que reserva cupo y
    // emite dorsal — la inscripcion cancelada volveria sola a confirmada.
    await this.payments.cerrarPendientesDeInscripcion(actualizado.id);

    const reembolsados = await this.payments.reembolsarDeInscripcion(actualizado.id);

    this.logger.log(
      `Inscripcion cancelada ${actualizado.id}` +
        (reembolsados > 0 ? ` (${reembolsados} cobro/s reembolsado/s)` : ''),
    );

    return this.toDto(actualizado, null);
  }

  /**
   * Suelta el cupo de una inscripcion cuyo pago se reembolso desde fuera.
   *
   * Es el camino del reembolso que **no pidio el usuario**: una devolucion del
   * proveedor, un contracargo. Por eso queda en `refunded` y no en `cancelled`:
   * el usuario no cancelo nada, y la diferencia importa cuando alguien mire por
   * que se quedo sin plaza.
   *
   * Idempotente: si la inscripcion ya no ocupaba cupo, no se resta dos veces.
   */
  async liberarPorReembolso(registrationId: string) {
    const registro = await this.prisma.registration.findUniqueOrThrow({
      where: { id: registrationId },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    if (registro.status === RegistrationStatus.refunded) {
      return this.toDto(registro, null);
    }

    const ocupabaCupo = registro.status === RegistrationStatus.confirmed;

    const actualizado = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM marathons WHERE id = ${registro.marathonId} FOR UPDATE`;

      if (ocupabaCupo) {
        await tx.marathon.updateMany({
          where: { id: registro.marathonId, slotsTaken: { gt: 0 } },
          data: { slotsTaken: { decrement: 1 } },
        });

        await this.devolverStock(tx, registro.marathonId, this.itemsGuardados(registro));
      }

      return tx.registration.update({
        where: { id: registro.id },
        data: {
          status: RegistrationStatus.refunded,
          cancelledAt: registro.cancelledAt ?? new Date(),
        },
        include: { marathon: { select: MARATON_DEL_RESUMEN } },
      });
    });

    this.logger.log(`Inscripcion ${actualizado.id} liberada por reembolso del proveedor`);

    return this.toDto(actualizado, null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Internos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * El filtro por `userId` ES la autorizacion: nadie ve ni toca la inscripcion
   * de otro, y un id ajeno responde 404 sin revelar que existe.
   */
  private async buscarPropia(userId: string, id: string): Promise<RegistroConMaraton> {
    const registro = await this.prisma.registration.findFirst({
      where: { id, userId, deletedAt: null },
      include: { marathon: { select: MARATON_DEL_RESUMEN } },
    });

    if (!registro) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No se encontro esa inscripcion',
        HttpStatus.NOT_FOUND,
      );
    }

    return registro;
  }

  private exigirEditable(registro: { status: RegistrationStatus }): void {
    if (!EDITABLES.includes(registro.status)) {
      throw new AppException(
        ErrorCode.REGISTRATION_NOT_EDITABLE,
        'Esta inscripcion ya no se puede modificar',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Cupo disponible. Fuera de la transaccion es orientativo; dentro, decisivo. */
  private exigirCupo(maraton: { slotsTaken: number; capacity: number }): void {
    if (maraton.slotsTaken >= maraton.capacity) {
      throw new AppException(
        ErrorCode.MARATHON_FULL,
        'Se agotaron los cupos de esta maraton',
        HttpStatus.CONFLICT,
      );
    }
  }

  private exigirInscripcionAbierta(maraton: Parameters<typeof resolverEstado>[0]): void {
    const estado = resolverEstado(maraton);

    if (estado === 'full') {
      throw new AppException(
        ErrorCode.MARATHON_FULL,
        'Se agotaron los cupos de esta maraton',
        HttpStatus.CONFLICT,
      );
    }

    if (!admiteInscripcion(estado)) {
      throw new AppException(
        ErrorCode.REGISTRATION_CLOSED,
        'Las inscripciones de esta maraton estan cerradas',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Si la maraton tiene categorias, elegir una no es opcional. */
  private async exigirCategoriaSiCorresponde(
    tx: Prisma.TransactionClient,
    registro: { marathonId: string; categoryId: string | null },
  ): Promise<void> {
    if (registro.categoryId) return;

    const categorias = await tx.marathonCategory.count({
      where: { marathonId: registro.marathonId },
    });

    if (categorias > 0) {
      throw new AppException(
        ErrorCode.CATEGORY_REQUIRED,
        'Hay que elegir una categoria antes de confirmar',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Descuenta stock con un update condicional y atomico.
   *
   * `where: { stock: { gte: cantidad } }` y despues mirar cuantas filas se
   * tocaron: si son cero, alguien se llevo las ultimas entre la cotizacion y
   * esta linea. Leer-comprobar-escribir en dos pasos dejaria justo esa ventana
   * abierta. Los extras con `stock: null` son ilimitados y no se tocan.
   */
  private async descontarStock(
    tx: Prisma.TransactionClient,
    marathonId: string,
    items: LineaCotizacion[],
  ): Promise<void> {
    for (const item of items) {
      if (item.type !== 'extra' || !item.refId) continue;

      const { count } = await tx.marathonExtra.updateMany({
        where: { id: item.refId, marathonId, stock: { not: null, gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      });

      if (count === 1) continue;

      // No se toco nada: o es ilimitado (y esta bien), o ya no alcanza.
      const extra = await tx.marathonExtra.findUnique({ where: { id: item.refId } });

      if (extra?.stock !== null) {
        throw new AppException(
          ErrorCode.EXTRA_OUT_OF_STOCK,
          `Se agotaron las unidades de "${item.label}" mientras completabas la inscripcion`,
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  private async devolverStock(
    tx: Prisma.TransactionClient,
    marathonId: string,
    items: LineaCotizacion[],
  ): Promise<void> {
    for (const item of items) {
      if (item.type !== 'extra' || !item.refId) continue;

      await tx.marathonExtra.updateMany({
        where: { id: item.refId, marathonId, stock: { not: null } },
        data: { stock: { increment: item.quantity } },
      });
    }
  }

  private cotizacionDe(registro: RegistroConMaraton): Promise<Cotizacion> {
    return this.quotes.cotizar({
      marathonId: registro.marathonId,
      categoryId: registro.categoryId,
      extras: this.extrasGuardados(registro),
    });
  }

  private async conCotizacionViva(registro: RegistroConMaraton) {
    if (!EDITABLES.includes(registro.status)) return this.toDto(registro, null);

    return this.toDto(registro, await this.cotizacionDe(registro));
  }

  private totalesDe(cotizacion: Cotizacion) {
    return {
      subtotalCents: cotizacion.subtotalCents,
      serviceFeeCents: cotizacion.serviceFee?.amountCents ?? 0,
      serviceFeeSnapshot: (cotizacion.serviceFeeSnapshot ?? undefined) as
        Prisma.InputJsonValue | undefined,
      totalCents: cotizacion.totalCents,
      currency: cotizacion.currency,
      quoteSnapshot: cotizacion.items as unknown as Prisma.InputJsonValue,
    };
  }

  /** Lo que se guarda en `Registration.extras`, con nombre y precio del dia. */
  private extrasPersistidos(items: LineaCotizacion[]): Prisma.InputJsonValue {
    return items
      .filter((i) => i.type === 'extra' && i.refId)
      .map((i) => ({
        extraId: i.refId,
        name: i.label,
        quantity: i.quantity,
        priceCents: i.unitPriceCents,
      }));
  }

  private extrasGuardados(registro: {
    extras: Prisma.JsonValue;
  }): { extraId: string; quantity: number }[] {
    if (!Array.isArray(registro.extras)) return [];

    return registro.extras.flatMap((crudo) => {
      const e = crudo as { extraId?: unknown; quantity?: unknown };
      return typeof e.extraId === 'string' && typeof e.quantity === 'number'
        ? [{ extraId: e.extraId, quantity: e.quantity }]
        : [];
    });
  }

  private itemsGuardados(registro: { quoteSnapshot: Prisma.JsonValue }): LineaCotizacion[] {
    return Array.isArray(registro.quoteSnapshot)
      ? (registro.quoteSnapshot as unknown as LineaCotizacion[])
      : [];
  }

  /**
   * El desglose congelado de una inscripcion que ya no se edita.
   *
   * Devolver aca la cotizacion viva seria mostrarle a alguien que ya pago un
   * total distinto del que pago, porque el organizador subio un precio.
   */
  private cotizacionCongelada(registro: RegistroConMaraton): CotizacionCongelada | null {
    if (EDITABLES.includes(registro.status)) return null;

    return {
      marathonId: registro.marathonId,
      currency: registro.currency,
      items: this.itemsGuardados(registro),
      subtotalCents: registro.subtotalCents,
      serviceFee: this.feeCongelado(registro),
      totalCents: registro.totalCents,
    };
  }

  private feeCongelado(registro: {
    serviceFeeCents: number;
    serviceFeeSnapshot: Prisma.JsonValue;
  }): { label: string; amountCents: number } | null {
    if (registro.serviceFeeCents <= 0) return null;

    const snapshot = registro.serviceFeeSnapshot as { label?: unknown } | null;
    const label = typeof snapshot?.label === 'string' ? snapshot.label : 'Cargo por servicio';

    return { label, amountCents: registro.serviceFeeCents };
  }

  private toDto(registro: RegistroConMaraton, viva: Cotizacion | null) {
    const congelada = this.cotizacionCongelada(registro);
    const precios = viva ?? congelada;

    return {
      id: registro.id,
      // Campo por campo y no con spread: el select trae ademas cupos y estado,
      // que hacen falta para las validaciones pero no son parte del contrato.
      marathon: {
        id: registro.marathon.id,
        slug: registro.marathon.slug,
        name: registro.marathon.name,
        startsAt: registro.marathon.startsAt.toISOString(),
        timezone: registro.marathon.timezone,
        city: registro.marathon.city,
        distanceMeters: registro.marathon.distanceMeters,
      },
      status: registro.status,
      step: registro.step,
      bibNumber: registro.bibNumber,
      categoryId: registro.categoryId,
      personalData: registro.personalData,
      extras: registro.extras,
      items: precios?.items ?? this.itemsGuardados(registro),
      subtotalCents: precios?.subtotalCents ?? registro.subtotalCents,
      serviceFee: precios ? precios.serviceFee : this.feeCongelado(registro),
      totalCents: precios?.totalCents ?? registro.totalCents,
      currency: registro.currency,
      termsAcceptedAt: registro.termsAcceptedAt?.toISOString() ?? null,
      registeredAt: registro.registeredAt?.toISOString() ?? null,
      cancelledAt: registro.cancelledAt?.toISOString() ?? null,
      createdAt: registro.createdAt.toISOString(),
    };
  }
}

/** Igual que una cotizacion, pero sin el snapshot: ya esta persistido. */
export interface CotizacionCongelada {
  marathonId: string;
  currency: string;
  items: LineaCotizacion[];
  subtotalCents: number;
  serviceFee: { label: string; amountCents: number } | null;
  totalCents: number;
}
