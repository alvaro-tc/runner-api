import { HttpStatus, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { exigirClaveDeIdempotencia } from '../../common/idempotency';
import { RegistrationsService } from '../registrations/registrations.service';
import { PaymentMethod, PaymentProviderName, PaymentStatus } from '../../../generated/prisma/enums';
import type { Payment, Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { MockPaymentProvider, MotivoAsincrono } from './mock/mock-payment.provider';
import { PAYMENT_PROVIDER, type IntentoDePago, type PaymentProvider } from './payment-provider';
import type { CheckoutDto } from './dto/payment.dto';
import { EventoDeWebhook, type WebhookEventDto } from './dto/webhook.dto';
import { ResultadoDeVerificacion, verificar } from './webhook/signature';
import { ReceiptService, type LineaDeComprobante } from './receipt/receipt.service';
import { StorageService } from '../storage/storage.service';
import { glosaDe, intentoDeQrManual } from './manual-qr/qr-intent';
import { PaymentProofService } from './manual-qr/payment-proof.service';

/**
 * Orquesta el paso 3: cobra y, si el cobro pasa, confirma la inscripcion.
 *
 * El orden importa y es este:
 *
 * 1. `prepararParaPago()` valida todo lo barato —carrera abierta, cupo,
 *    categoria, datos personales— y congela el precio. Nadie paga por una
 *    carrera que ya estaba cerrada.
 * 2. Se cobra contra el proveedor.
 * 3. Si el cobro pasa, `confirmarPago()` toma el cupo y emite el dorsal dentro
 *    de la transaccion con la maraton bloqueada.
 * 4. Si ese ultimo paso falla —el ultimo cupo se fue mientras se procesaba la
 *    tarjeta— se **reembolsa** y se devuelve el error de dominio. Es el unico
 *    orden en el que nadie termina cobrado y sin inscripcion.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registrations: RegistrationsService,
    private readonly config: AppConfigService,
    private readonly receipts: ReceiptService,
    private readonly storage: StorageService,
    // TEMPORAL — cobro por QR manual. Ver `docs/pago-qr-manual.md`. El ciclo es
    // mutuo: aqui se abre el cobro y alli se cierra al aprobar el comprobante.
    @Inject(forwardRef(() => PaymentProofService))
    private readonly proofs: PaymentProofService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async checkout(userId: string, registrationId: string, dto: CheckoutDto, idempotencyKey: string) {
    exigirClaveDeIdempotencia(idempotencyKey);

    const repetido = await this.reutilizar(userId, registrationId, idempotencyKey);
    if (repetido) return repetido;

    const { registro, cotizacion } = await this.registrations.prepararParaPago(
      userId,
      registrationId,
    );

    // TEMPORAL — el QR manual no pasa por ningun proveedor: se abre el cobro
    // con el QR del organizador y se espera a que alguien mire el comprobante.
    // Ver `docs/pago-qr-manual.md`.
    if (dto.method === PaymentMethod.qr_manual) {
      return this.abrirQrManual(registro.id, registro.marathonId, cotizacion, idempotencyKey);
    }

    const intento = await this.provider.createIntent({
      amountCents: cotizacion.totalCents,
      currency: cotizacion.currency,
      method: dto.method,
      card: dto.card,
      metadata: {
        registrationId: registro.id,
        marathonId: registro.marathonId,
        userId,
      },
    });

    // La fila se crea con lo que devolvio el proveedor, aprobado o no: un cobro
    // rechazado tambien es historia, y sin fila no habria a que asociar la
    // clave de idempotencia —un reintento con la misma clave volveria a cobrar.
    const pago = await this.crearPago(registro.id, idempotencyKey, intento);

    if (intento.status === PaymentStatus.failed) {
      this.logger.warn(
        `Cobro rechazado de la inscripcion ${registro.id}: ${intento.failureReason ?? '-'}`,
      );

      throw new AppException(
        ErrorCode.PAYMENT_DECLINED,
        'El pago fue rechazado',
        HttpStatus.PAYMENT_REQUIRED,
        [{ paymentId: pago.id, reason: intento.failureReason }],
      );
    }

    if (intento.status !== PaymentStatus.paid) {
      // Metodos asincronos: el QR se paga solo a los pocos segundos y lo
      // recoge el polling de `GET /payments/:id`; la transferencia espera a que
      // una persona la confirme desde el panel. En los dos casos la inscripcion
      // se queda en `pending_payment` y la app ya tiene que pintar el QR o los
      // datos bancarios que vienen en `methodDetails`.
      return {
        payment: this.toDto(pago),
        registration: await this.registrations.detalleDe(registro.id),
      };
    }

    return this.liquidar(pago);
  }

  /**
   * Fuerza la confirmacion de un cobro pendiente. **Solo fuera de produccion.**
   *
   * Existe para no tener que esperar los segundos del QR ni montar un banco
   * falso cuando estas probando la pantalla a mano. En produccion no responde:
   * un endpoint que da por pagado lo que nadie pago no puede existir donde hay
   * dinero de verdad, aunque este autenticado.
   */
  async mockConfirm(userId: string, paymentId: string) {
    if (this.config.isProduction) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No se encontro ese pago', HttpStatus.NOT_FOUND);
    }

    const pago = await this.buscarPropio(userId, paymentId);

    if (pago.status !== PaymentStatus.pending) {
      throw new AppException(
        ErrorCode.PAYMENT_ALREADY_SETTLED,
        'Ese cobro ya esta cerrado',
        HttpStatus.CONFLICT,
      );
    }

    // El QR manual no tiene proveedor al que preguntar: lo cierra un
    // organizador desde el panel. Atajarlo aqui evitaria probar justo lo unico
    // que hay que probar de ese flujo, que es la revision.
    if (pago.method === PaymentMethod.qr_manual) {
      throw new AppException(
        ErrorCode.PAYMENT_METHOD_NOT_SUPPORTED,
        'Un cobro por QR se cierra aprobando su comprobante desde el panel',
        HttpStatus.BAD_REQUEST,
      );
    }

    const acreditado = await this.acreditar(pago);

    return {
      payment: this.toDto(acreditado),
      registration: await this.registrations.detalleDe(pago.registrationId),
    };
  }

  /**
   * Un pago propio. El filtro por dueno de la inscripcion ES la autorizacion.
   *
   * Es tambien el endpoint de **polling** del QR: cada lectura resuelve el
   * cobro si ya toca —se pago solo, o caduco—, asi que el cliente solo tiene
   * que sondear esta ruta y mirar `status`.
   */
  async obtener(userId: string, paymentId: string) {
    const pago = await this.buscarPropio(userId, paymentId);

    return this.conComprobante(await this.resolverPendiente(pago));
  }

  /** Historial de intentos de cobro de una inscripcion, del mas nuevo al mas viejo. */
  async listarDeInscripcion(userId: string, registrationId: string) {
    const inscripcion = await this.prisma.registration.findFirst({
      where: { id: registrationId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!inscripcion) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No se encontro esa inscripcion',
        HttpStatus.NOT_FOUND,
      );
    }

    const pagos = await this.prisma.payment.findMany({
      where: { registrationId },
      orderBy: { createdAt: 'desc' },
    });

    const resueltos = await Promise.all(pagos.map((p) => this.resolverPendiente(p)));

    return Promise.all(resueltos.map((p) => this.conComprobante(p)));
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Webhook del proveedor
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Punto de entrada del webhook: verifica la firma y aplica el evento.
   *
   * Los tres motivos de rechazo —falta la cabecera, la firma no cuadra, llego
   * fuera de la ventana— responden **el mismo error**. Distinguirlos le diria a
   * quien esta probando cual de las tres cosas acerto, y eso es exactamente el
   * mapa que necesita para seguir probando.
   */
  async recibirWebhook(
    cuerpoCrudo: Buffer | undefined,
    cabecera: string | string[] | undefined,
    evento: WebhookEventDto,
  ) {
    const resultado = verificar({
      // Si no hay cuerpo crudo se cae a la version serializada: en ese camino la
      // firma casi nunca cuadrara, que es justo lo que debe pasar. Nunca se da
      // por buena una peticion por no haber podido comprobarla.
      cuerpo: cuerpoCrudo?.toString('utf8') ?? JSON.stringify(evento),
      cabecera: Array.isArray(cabecera) ? cabecera[0] : cabecera,
      secreto: this.config.get('PAYMENT_WEBHOOK_SECRET'),
      toleranciaSegundos: this.config.get('PAYMENT_WEBHOOK_TOLERANCE_SECONDS'),
    });

    if (resultado !== ResultadoDeVerificacion.ok) {
      this.logger.warn(`Webhook rechazado (${resultado}) para el evento ${evento.id}`);

      throw new AppException(
        ErrorCode.INVALID_WEBHOOK_SIGNATURE,
        'Firma del webhook invalida',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const aplicado = await this.aplicarEvento(evento);

    return { received: true, ...aplicado };
  }

  /**
   * Aplica un evento del proveedor. La firma ya se verifico en el controlador.
   *
   * **No se lleva una tabla de eventos procesados.** No hace falta: las tres
   * operaciones son idempotentes por estado —`acreditar()` condiciona su update
   * a `status: pending`, `confirmarPago()` devuelve la inscripcion tal cual si
   * ya estaba confirmada, y reembolsar dos veces deja el mismo `refunded`—. Una
   * tabla de deduplicacion seria una segunda linea de defensa para algo que ya
   * es correcto, con su propia limpieza y su propio indice.
   *
   * Nunca lanza por un evento que no se puede aplicar: devuelve `handled:
   * false`. Un PSP que recibe un error reintenta, y reintentar un evento que
   * nunca vamos a poder procesar es un bucle infinito con nuestro nombre encima.
   */
  async aplicarEvento(evento: WebhookEventDto): Promise<{ handled: boolean; reason?: string }> {
    const pago = await this.prisma.payment.findFirst({
      where: { externalId: evento.data.externalId },
    });

    if (!pago) {
      this.logger.warn(`Webhook ${evento.id}: no existe el cobro ${evento.data.externalId}`);
      return { handled: false, reason: 'unknown_payment' };
    }

    switch (evento.type) {
      case EventoDeWebhook.payment_paid:
        return this.eventoPagado(pago, evento);
      case EventoDeWebhook.payment_failed:
        return this.eventoFallido(pago, evento);
      case EventoDeWebhook.payment_refunded:
        return this.eventoReembolsado(pago, evento);
      default:
        return { handled: false, reason: 'unsupported_event' };
    }
  }

  private async eventoPagado(pago: Payment, evento: WebhookEventDto) {
    if (pago.status !== PaymentStatus.pending) {
      // Reintento del proveedor sobre algo ya cerrado. Es lo normal, no un error.
      return { handled: false, reason: 'already_settled' };
    }

    const acreditado = await this.acreditar(pago);

    this.logger.log(`Webhook ${evento.id}: cobro ${pago.id} -> ${acreditado.status}`);

    return { handled: acreditado.status !== PaymentStatus.pending };
  }

  private async eventoFallido(pago: Payment, evento: WebhookEventDto) {
    const { count } = await this.prisma.payment.updateMany({
      where: { id: pago.id, status: PaymentStatus.pending },
      data: {
        status: PaymentStatus.failed,
        failureReason: evento.data.failureReason ?? 'provider_declined',
      },
    });

    if (count === 0) return { handled: false, reason: 'already_settled' };

    this.logger.log(`Webhook ${evento.id}: cobro ${pago.id} rechazado por el proveedor`);

    return { handled: true };
  }

  private async eventoReembolsado(pago: Payment, evento: WebhookEventDto) {
    if (pago.status === PaymentStatus.refunded) {
      return { handled: false, reason: 'already_settled' };
    }

    if (pago.status !== PaymentStatus.paid) {
      return { handled: false, reason: 'not_paid' };
    }

    await this.marcarReembolsado(pago, evento.data.failureReason ?? 'provider_refund');

    // Un reembolso que llega del proveedor —una devolucion, un contracargo— no
    // lo pidio el usuario, asi que hay que soltar el cupo por el: la plaza
    // vuelve al pozo y la inscripcion queda `refunded`.
    await this.registrations.liberarPorReembolso(pago.registrationId);

    this.logger.log(`Webhook ${evento.id}: cobro ${pago.id} reembolsado por el proveedor`);

    return { handled: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Reembolsos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Devuelve el dinero de una inscripcion que se acaba de cancelar.
   *
   * La llama `RegistrationsService.cancelar()` **despues** de liberar el cupo.
   * Ese orden importa: si el reembolso falla, el cupo ya volvio al pozo y lo
   * que queda pendiente es devolver dinero —resoluble a mano desde el panel—.
   * Al reves, un fallo dejaria una plaza bloqueada para siempre.
   *
   * No lanza: cancelar tiene que funcionar aunque el proveedor este caido.
   * Devuelve cuantos cobros se reembolsaron para que quede en el log.
   */
  async reembolsarDeInscripcion(registrationId: string): Promise<number> {
    const pagados = await this.prisma.payment.findMany({
      where: { registrationId, status: PaymentStatus.paid },
    });

    let reembolsados = 0;

    for (const pago of pagados) {
      // El QR manual no paso por ningun proveedor, asi que tampoco hay a quien
      // pedirle el reembolso: el dinero lo devuelve una persona por el mismo
      // canal por el que entro. Se registra fuerte y se sigue; el cupo ya se
      // libero, que es lo unico que este metodo no puede dejar a medias.
      if (pago.method === PaymentMethod.qr_manual) {
        this.logger.warn(
          `Cobro por QR ${pago.id} de la inscripcion ${registrationId}: la devolucion es ` +
            'manual, no hay proveedor que la haga',
        );
        await this.marcarReembolsado(pago, 'manual_refund_required');
        reembolsados += 1;
        continue;
      }

      try {
        if (pago.externalId) await this.provider.refund(pago.externalId);
        await this.marcarReembolsado(pago, 'cancelled_by_user');
        reembolsados += 1;
      } catch (error) {
        this.logger.error(
          `No se pudo reembolsar el cobro ${pago.id} al cancelar la inscripcion ` +
            `${registrationId}: requiere intervencion manual`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return reembolsados;
  }

  /**
   * Cierra los cobros que quedaron **abiertos** en una inscripcion cancelada.
   *
   * Sin esto, un cobro por QR sigue `pending` sobre una inscripcion muerta: el
   * corredor todavia puede subir un comprobante y un organizador todavia puede
   * aprobarlo, y aprobar reserva cupo y emite dorsal. Es decir, una inscripcion
   * cancelada volveria sola a confirmada.
   *
   * Se cierra aqui, en el estado del cobro, y no con un `if` en cada pantalla:
   * la subida de comprobante y la acreditacion ya exigen `pending`, asi que un
   * solo cambio de estado tapa los dos caminos.
   *
   * No lanza, por lo mismo que el reembolso: cancelar tiene que funcionar.
   */
  async cerrarPendientesDeInscripcion(registrationId: string): Promise<number> {
    const { count } = await this.prisma.payment.updateMany({
      where: { registrationId, status: PaymentStatus.pending },
      data: { status: PaymentStatus.failed, failureReason: 'cancelled_by_user' },
    });

    if (count > 0) {
      this.logger.log(`Cerrados ${count} cobro/s pendientes de la inscripcion ${registrationId}`);
    }

    return count;
  }

  /**
   * Marca el cobro como devuelto.
   *
   * `adminUserId` solo viene cuando la devolucion la ordeno una persona desde
   * el panel; un reembolso del proveedor o el de una cancelacion del propio
   * corredor no tienen a nadie a quien atribuirsela, y firmarlos con alguien
   * seria inventar una auditoria.
   *
   * El `updateMany` condicionado a `paid` es lo que hace esto idempotente: dos
   * clics seguidos devuelven el dinero una sola vez.
   */
  private marcarReembolsado(
    pago: Payment,
    motivo: string,
    adminUserId?: string,
  ): Promise<{ count: number }> {
    return this.prisma.payment.updateMany({
      where: { id: pago.id, status: PaymentStatus.paid },
      data: {
        status: PaymentStatus.refunded,
        refundedAt: new Date(),
        failureReason: motivo,
        ...(adminUserId ? { refundedById: adminUserId } : {}),
      },
    });
  }

  /**
   * Devuelve el dinero de un cobro, por decision de una persona del panel.
   *
   * **Devolver es anular la inscripcion**, no solo mover dinero: quien recupera
   * su plata no corre. Por eso suelta el cupo por `liberarPorReembolso()` —el
   * mismo camino que usa el reembolso del proveedor— y no hay una segunda
   * implementacion de "soltar una plaza"; una plaza devuelta a medias es la que
   * bloquea el cupo de otro corredor para siempre.
   *
   * El orden es a proposito: primero el estado del cobro, condicionado a
   * `paid`, y solo quien gana esa carrera sigue. Al reves, dos organizadores
   * impacientes soltarian el cupo dos veces.
   *
   * Al proveedor se le pide la devolucion cuando la hubo. Los cobros por QR y
   * por transferencia no pasaron por ninguno: ahi el dinero lo devuelve una
   * persona por el mismo canal por el que entro, y lo que hace este endpoint es
   * dejar constancia de que se ordeno y de quien la ordeno.
   */
  async reembolsarManualmente(paymentId: string, adminUserId: string, motivo: string) {
    const pago = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    if (!pago) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El pago no existe', HttpStatus.NOT_FOUND);
    }

    if (pago.status !== PaymentStatus.paid) {
      throw new AppException(
        ErrorCode.PAYMENT_ALREADY_SETTLED,
        pago.status === PaymentStatus.refunded
          ? 'Ese cobro ya se devolvio'
          : 'Solo se puede devolver un cobro que este pagado',
        HttpStatus.CONFLICT,
        [{ status: pago.status }],
      );
    }

    const { count } = await this.marcarReembolsado(pago, motivo, adminUserId);

    if (count === 0) {
      throw new AppException(
        ErrorCode.PAYMENT_ALREADY_SETTLED,
        'Ese cobro lo acaba de cerrar alguien mas',
        HttpStatus.CONFLICT,
      );
    }

    // Fuera del proveedor no hay a quien pedirle nada, pero el fallo tampoco
    // puede tumbar la operacion: el cobro ya consta como devuelto y lo que
    // queda es mover el dinero, que se resuelve por el mismo canal a mano.
    if (pago.externalId && pago.method !== PaymentMethod.qr_manual) {
      try {
        await this.provider.refund(pago.externalId);
      } catch (error) {
        this.logger.error(
          `El proveedor no acepto la devolucion del cobro ${pago.id}: hay que hacerla a mano`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    } else {
      this.logger.warn(
        `Cobro ${pago.id} (${pago.method}): la devolucion del dinero es manual, ` +
          'no hay proveedor que la haga',
      );
    }

    await this.registrations.liberarPorReembolso(pago.registrationId);

    this.logger.log(`Cobro ${pago.id} devuelto por ${adminUserId}: ${motivo}`);

    return this.prisma.payment.findUniqueOrThrow({ where: { id: pago.id } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Comprobante
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * URL del comprobante en PDF. Se genera la primera vez y se reutiliza.
   *
   * Se cachea en `receiptUrl` porque el documento no puede cambiar: sale de los
   * datos congelados de la inscripcion, asi que regenerarlo daria siempre lo
   * mismo y solo gastaria CPU y disco. Si el archivo se borrara, basta con
   * vaciar la columna.
   */
  async comprobante(userId: string, paymentId: string): Promise<{ url: string }> {
    const pago = await this.buscarPropio(userId, paymentId);

    if (pago.status !== PaymentStatus.paid) {
      throw new AppException(
        ErrorCode.RECEIPT_NOT_AVAILABLE,
        'Solo hay comprobante de un pago cobrado',
        HttpStatus.CONFLICT,
      );
    }

    if (pago.receiptUrl) return { url: pago.receiptUrl };

    const registro = await this.prisma.registration.findUniqueOrThrow({
      where: { id: pago.registrationId },
      include: { marathon: true },
    });

    const url = await this.receipts.generar({
      paymentId: pago.id,
      externalId: pago.externalId,
      paidAt: pago.paidAt ?? pago.createdAt,
      method: pago.method,
      methodDetails: detalleDeMetodo(pago.methodDetails),
      items: lineasDe(registro.quoteSnapshot),
      subtotalCents: registro.subtotalCents,
      serviceFeeLabel: etiquetaDeFee(registro.serviceFeeSnapshot),
      serviceFeeCents: registro.serviceFeeCents,
      totalCents: registro.totalCents,
      marathonName: registro.marathon.name,
      marathonCity: registro.marathon.city,
      marathonStartsAt: registro.marathon.startsAt,
      marathonTimezone: registro.marathon.timezone,
      bibNumber: registro.bibNumber,
      runnerName: datoPersonal(registro.personalData, 'fullName'),
      runnerDocId: datoPersonal(registro.personalData, 'docId'),
    });

    await this.prisma.payment.update({ where: { id: pago.id }, data: { receiptUrl: url } });

    return { url };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Internos
  // ─────────────────────────────────────────────────────────────────────────

  /** Lectura autorizada de un pago propio: un id ajeno responde 404. */
  private async buscarPropio(userId: string, paymentId: string): Promise<Payment> {
    const pago = await this.prisma.payment.findFirst({
      where: { id: paymentId, registration: { userId, deletedAt: null } },
    });

    if (!pago) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No se encontro ese pago', HttpStatus.NOT_FOUND);
    }

    return pago;
  }

  /**
   * Con el cobro ya acreditado, confirma la inscripcion.
   *
   * Es el punto de encuentro de los tres metodos: la tarjeta llega aca en el
   * mismo request, el QR cuando lo recoge el polling, y la transferencia cuando
   * alguien la confirma desde el panel. Uno solo, para que el dorsal y el cupo
   * se emitan siempre igual.
   */
  private async liquidar(pago: Payment) {
    try {
      const registration = await this.registrations.confirmarPago(pago.registrationId);
      return { payment: this.toDto(pago), registration };
    } catch (error) {
      await this.compensar(pago, error);
      throw error;
    }
  }

  /**
   * Hace avanzar un cobro pendiente si ya le toca. Se llama en cada lectura.
   *
   * Resolver al leer y no con un job periodico es deliberado: el estado tiene
   * que ser correcto **cuando alguien lo mira**, y quien lo mira es siempre el
   * polling del cliente. Un cron que barra los vencidos hara falta el dia que
   * haya que liberar recursos sin que nadie pregunte, no antes.
   */
  private async resolverPendiente(pago: Payment): Promise<Payment> {
    if (pago.status !== PaymentStatus.pending) return pago;

    const vencido = pago.expiresAt !== null && pago.expiresAt.getTime() <= Date.now();

    if (vencido) return this.caducar(pago);

    // La transferencia bancaria no se resuelve sola por diseno: espera a una
    // persona. Solo el QR tiene reloj.
    if (pago.method !== PaymentMethod.qr) return pago;

    const listo =
      this.provider instanceof MockPaymentProvider
        ? this.provider.autoConfirmaEn(pago.createdAt).getTime() <= Date.now()
        : false;

    return listo ? this.acreditar(pago) : pago;
  }

  private async caducar(pago: Payment): Promise<Payment> {
    await this.prisma.payment.updateMany({
      where: { id: pago.id, status: PaymentStatus.pending },
      data: { status: PaymentStatus.failed, failureReason: MotivoAsincrono.qr_expired },
    });

    this.logger.log(`Cobro ${pago.id} caducado sin pagarse`);

    return this.prisma.payment.findUniqueOrThrow({ where: { id: pago.id } });
  }

  /**
   * Da por cobrado un pago pendiente y confirma la inscripcion detras.
   *
   * El `updateMany` condicionado a `status: pending` es lo que hace seguro que
   * dos sondeos simultaneos entren aqui a la vez: solo uno cambia la fila, y
   * solo ese sigue hasta la confirmacion. El otro se encuentra el trabajo
   * hecho. Sin esa condicion, dos polls podrian pedir dos dorsales.
   */
  private async acreditar(pago: Payment): Promise<Payment> {
    const intento = await this.provider.confirm(pago.externalId ?? '');

    if (intento.status === PaymentStatus.failed) {
      await this.prisma.payment.updateMany({
        where: { id: pago.id, status: PaymentStatus.pending },
        data: { status: PaymentStatus.failed, failureReason: intento.failureReason },
      });

      return this.prisma.payment.findUniqueOrThrow({ where: { id: pago.id } });
    }

    if (intento.status !== PaymentStatus.paid) return pago;

    const { count } = await this.prisma.payment.updateMany({
      where: { id: pago.id, status: PaymentStatus.pending },
      data: { status: PaymentStatus.paid, paidAt: new Date(), failureReason: null },
    });

    const acreditado = await this.prisma.payment.findUniqueOrThrow({ where: { id: pago.id } });

    if (count === 1) {
      try {
        await this.registrations.confirmarPago(pago.registrationId);
      } catch (error) {
        // Aca no se puede propagar: quien llama esta sondeando un estado, no
        // comprando. Se compensa y se devuelve la fila reembolsada, que es lo
        // que el cliente tiene que ver y pintar.
        await this.compensar(acreditado, error);
        return this.prisma.payment.findUniqueOrThrow({ where: { id: pago.id } });
      }
    }

    return acreditado;
  }

  /**
   * Da por cobrada una transferencia bancaria, por decision de un admin.
   *
   * Es la unica via de cobro que no pasa por el proveedor, y no puede pasar:
   * quien confirma es una persona que ha visto el dinero en la cuenta del banco.
   * Por eso se limita a `bank_transfer` —una tarjeta rechazada no se arregla
   * declarandola pagada— y por eso deja rastro de quien lo hizo.
   *
   * Reutiliza `confirmarPago()` igual que el resto: el cupo y el dorsal se
   * emiten en la misma transaccion de siempre. Aqui el `updateMany` condicionado
   * evita que dos admins impacientes pidan dos dorsales.
   */
  async acreditarManualmente(paymentId: string, adminUserId: string, referencia?: string) {
    const pago = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    if (!pago) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El pago no existe', HttpStatus.NOT_FOUND);
    }

    // Los dos metodos que esperan a una persona: la transferencia, que se
    // cuadra contra el extracto, y el QR manual, que se cuadra contra el
    // comprobante que subio el corredor. Una tarjeta rechazada NO se arregla
    // declarandola pagada, y por eso la lista es cerrada.
    const CONFIRMABLES: PaymentMethod[] = [PaymentMethod.bank_transfer, PaymentMethod.qr_manual];

    if (!CONFIRMABLES.includes(pago.method)) {
      throw new AppException(
        ErrorCode.PAYMENT_METHOD_NOT_SUPPORTED,
        'Solo se confirman a mano los pagos por transferencia bancaria o por QR',
        HttpStatus.BAD_REQUEST,
        [{ method: pago.method }],
      );
    }

    if (pago.status !== PaymentStatus.pending) {
      throw new AppException(
        ErrorCode.PAYMENT_ALREADY_SETTLED,
        'Ese pago ya esta cerrado',
        HttpStatus.CONFLICT,
        [{ status: pago.status }],
      );
    }

    const { count } = await this.prisma.payment.updateMany({
      where: { id: pago.id, status: PaymentStatus.pending },
      data: {
        status: PaymentStatus.paid,
        paidAt: new Date(),
        failureReason: null,
        // La columna es la que se audita —se une con `users` y devuelve un
        // nombre—; el JSON se sigue escribiendo porque es lo que lee el panel
        // web de hoy y quitarlo seria un cambio suyo, no de este flujo.
        confirmedById: adminUserId,
        methodDetails: {
          ...(pago.methodDetails as object),
          bank: { reference: referencia ?? null, confirmedBy: adminUserId },
        },
      },
    });

    if (count === 1) await this.registrations.confirmarPago(pago.registrationId);

    this.logger.log(`Transferencia ${pago.id} confirmada a mano por ${adminUserId}`);

    return this.prisma.payment.findUniqueOrThrow({ where: { id: pago.id } });
  }

  /**
   * Reintentar con la misma clave devuelve el mismo resultado sin volver a
   * cobrar.
   *
   * Es lo que hace seguro que la app reintente cuando se le cae la conexion
   * justo despues de mandar el checkout: sin esto, el usuario que toca "pagar"
   * dos veces por nerviosismo paga dos veces.
   */
  private async reutilizar(userId: string, registrationId: string, clave: string) {
    const previo = await this.prisma.payment.findUnique({
      where: { idempotencyKey: clave },
      include: { registration: { select: { id: true, userId: true } } },
    });

    if (!previo) return null;

    if (previo.registration.userId !== userId || previo.registrationId !== registrationId) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'Esa clave de idempotencia ya se uso para otro cobro',
        HttpStatus.CONFLICT,
      );
    }

    if (previo.status === PaymentStatus.failed) {
      throw new AppException(
        ErrorCode.PAYMENT_DECLINED,
        'El pago fue rechazado',
        HttpStatus.PAYMENT_REQUIRED,
        [{ paymentId: previo.id, reason: previo.failureReason }],
      );
    }

    return {
      payment: this.toDto(previo),
      registration: await this.registrations.detalleDe(registrationId),
    };
  }

  private crearPago(
    registrationId: string,
    idempotencyKey: string,
    intento: IntentoDePago,
    proveedor: PaymentProviderName = this.provider.name,
  ): Promise<Payment> {
    return this.prisma.payment.create({
      data: {
        registrationId,
        provider: proveedor,
        method: intento.method,
        status: intento.status,
        amountCents: intento.amountCents,
        currency: intento.currency,
        methodDetails: intento.methodDetails as unknown as Prisma.InputJsonValue,
        idempotencyKey,
        externalId: intento.externalId,
        expiresAt: intento.expiresAt,
        failureReason: intento.failureReason,
        paidAt: intento.status === PaymentStatus.paid ? new Date() : null,
      },
    });
  }

  /**
   * El cobro paso pero la inscripcion no se pudo confirmar: se devuelve el
   * dinero antes de propagar el error.
   *
   * Pasa cuando el ultimo cupo se va mientras el proveedor procesa la tarjeta.
   * Es raro, pero es exactamente el caso en el que un usuario quedaria cobrado
   * y sin carrera, asi que se compensa siempre y se deja rastro en el log.
   */
  private async compensar(pago: Payment, causa: unknown): Promise<void> {
    const motivo = causa instanceof AppException ? causa.code : 'INTERNAL_ERROR';

    this.logger.error(
      `Cobro ${pago.id} aprobado pero la inscripcion ${pago.registrationId} no se confirmo ` +
        `(${motivo}): se reembolsa`,
    );

    try {
      if (pago.externalId) await this.provider.refund(pago.externalId);

      await this.prisma.payment.update({
        where: { id: pago.id },
        data: {
          status: PaymentStatus.refunded,
          refundedAt: new Date(),
          failureReason: motivo,
        },
      });

      await this.registrations.devolverAPendiente(pago.registrationId);
    } catch (fallo) {
      // El reembolso automatico fallo: se registra fuerte para que quede en el
      // panel de admin y alguien lo resuelva a mano. Nunca se traga el error
      // original, que es el que el usuario tiene que ver.
      this.logger.error(
        `No se pudo reembolsar el cobro ${pago.id}: requiere intervencion manual`,
        fallo instanceof Error ? fallo.stack : undefined,
      );
    }
  }

  /**
   * TEMPORAL — abre un cobro por QR manual. Ver `docs/pago-qr-manual.md`.
   *
   * La inscripcion queda `pending_payment` con el QR del organizador pintado, y
   * ahi se queda hasta que alguien apruebe el comprobante. **No confirma nada**:
   * ver un QR no es haber pagado.
   */
  private async abrirQrManual(
    registrationId: string,
    marathonId: string,
    cotizacion: { totalCents: number; currency: string },
    idempotencyKey: string,
  ) {
    const maraton = await this.prisma.marathon.findUniqueOrThrow({
      where: { id: marathonId },
      select: { paymentQrUrl: true, paymentQrInstructions: true, paymentQrPayload: true },
    });

    // El texto es lo que habilita el metodo: la app dibuja el codigo con el.
    // La imagen viaja tambien, pero solo como respaldo de las maratones que
    // cargaron el QR como archivo antes de que existiera el texto.
    const qrPayload = maraton.paymentQrPayload?.trim();

    if (!qrPayload) {
      throw new AppException(
        ErrorCode.QR_NOT_CONFIGURED,
        'Esta carrera todavia no tiene un QR de cobro cargado',
        HttpStatus.CONFLICT,
      );
    }

    const intento = intentoDeQrManual({
      amountCents: cotizacion.totalCents,
      currency: cotizacion.currency,
      qrPayload,
      qrImageUrl: this.storage.publicUrl(maraton.paymentQrUrl),
      instructions: maraton.paymentQrInstructions,
      reference: glosaDe(registrationId),
      ttlHoras: this.config.get('PAYMENT_PROOF_TTL_HOURS'),
    });

    const pago = await this.crearPago(
      registrationId,
      idempotencyKey,
      intento,
      PaymentProviderName.manual,
    );

    return {
      payment: this.toDto(pago),
      registration: await this.registrations.detalleDe(registrationId),
    };
  }

  /** El pago con su ultimo comprobante, si el metodo lo lleva. */
  private async conComprobante(pago: Payment) {
    if (pago.method !== PaymentMethod.qr_manual) return this.toDto(pago);

    return { ...this.toDto(pago), proof: await this.proofs.ultimoDe(pago.id) };
  }

  private toDto(pago: Payment) {
    return {
      id: pago.id,
      registrationId: pago.registrationId,
      method: pago.method,
      status: pago.status,
      amountCents: pago.amountCents,
      currency: pago.currency,
      methodDetails: (pago.methodDetails ?? {}) as Record<string, unknown>,
      failureReason: pago.failureReason,
      expiresAt: pago.expiresAt?.toISOString() ?? null,
      paidAt: pago.paidAt?.toISOString() ?? null,
      refundedAt: pago.refundedAt?.toISOString() ?? null,
      createdAt: pago.createdAt.toISOString(),
    };
  }
}

/**
 * Lectores del JSON de la base.
 *
 * Una columna JSON no tiene esquema: lo escribe siempre este codigo, pero una
 * fila vieja o tocada a mano no deberia tumbar la generacion de un comprobante.
 * Se comprueba la forma y se cae a un valor neutro.
 */
function detalleDeMetodo(valor: unknown): {
  brand?: string;
  last4?: string;
  bank?: { reference?: string };
} {
  return typeof valor === 'object' && valor !== null ? valor : {};
}

function lineasDe(valor: unknown): LineaDeComprobante[] {
  if (!Array.isArray(valor)) return [];

  return valor.flatMap((crudo) => {
    const l = crudo as Partial<LineaDeComprobante>;

    return typeof l.label === 'string' && typeof l.amountCents === 'number'
      ? [
          {
            label: l.label,
            quantity: typeof l.quantity === 'number' ? l.quantity : 1,
            unitPriceCents: typeof l.unitPriceCents === 'number' ? l.unitPriceCents : l.amountCents,
            amountCents: l.amountCents,
          },
        ]
      : [];
  });
}

function etiquetaDeFee(valor: unknown): string | null {
  const snapshot = valor as { label?: unknown } | null;

  return typeof snapshot?.label === 'string' ? snapshot.label : null;
}

function datoPersonal(valor: unknown, clave: string): string {
  const datos = valor as Record<string, unknown> | null;
  const dato = datos?.[clave];

  return typeof dato === 'string' && dato.trim() ? dato : '-';
}
