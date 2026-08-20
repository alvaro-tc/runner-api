import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app-config.service';
import { StorageService } from '../../storage/storage.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import {
  PaymentMethod,
  PaymentProviderName,
  PaymentStatus,
} from '../../../../generated/prisma/enums';
import type {
  DatosDeComprobante,
  DetalleDeMetodo,
  EntradaDeIntento,
  IntentoDePago,
  PaymentProvider,
} from '../payment-provider';
import { evaluarTarjeta } from './card-rules';

/** Motivos de fallo propios de los metodos asincronos. */
export const MotivoAsincrono = {
  /** El QR caduco antes de que nadie lo pagara. */
  qr_expired: 'qr_expired',
} as const;

/**
 * Proveedor simulado. Es el unico que llega a ver el numero de tarjeta, y no lo
 * guarda: de aca sale `brand` + `last4` y nada mas.
 *
 * **Su libro mayor es nuestra propia tabla `payments`.** Un PSP real tendria el
 * suyo del otro lado del cable y `externalId` apuntaria alli; el mock no tiene
 * donde, y montarle un almacen aparte le haria perder el estado en cada
 * reinicio —justo lo que romperia el polling del QR—. Es la unica licencia que
 * se toma respecto de un proveedor de verdad, y esta acotada a esta clase.
 *
 * Los tres metodos del enunciado, porque en Bolivia la tarjeta no es el medio
 * dominante y la UI tiene que contemplarlo desde ahora:
 *
 * | Metodo | Como se comporta |
 * |---|---|
 * | `card` | Resuelve en el acto, con tarjetas deterministas |
 * | `qr` | Queda `pending` con un PNG y un vencimiento; se paga solo a los N segundos |
 * | `bank_transfer` | Queda `pending` indefinidamente hasta confirmacion manual |
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = PaymentProviderName.mock;

  private readonly logger = new Logger(MockPaymentProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly storage: StorageService,
  ) {}

  async createIntent(entrada: EntradaDeIntento): Promise<IntentoDePago> {
    await this.latencia();

    switch (entrada.method) {
      case PaymentMethod.card:
        return this.intentoDeTarjeta(entrada);
      case PaymentMethod.qr:
        return this.intentoDeQr(entrada);
      case PaymentMethod.bank_transfer:
        return this.intentoDeTransferencia(entrada);
      default:
        throw new AppException(
          ErrorCode.PAYMENT_METHOD_NOT_SUPPORTED,
          `El metodo "${String(entrada.method)}" no esta disponible`,
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  /**
   * Resuelve un cobro pendiente.
   *
   * Idempotente: el estado vive en la fila, asi que confirmar un cobro ya
   * cobrado devuelve lo mismo en vez de cobrar otra vez. Un QR vencido no se
   * puede confirmar: se devuelve `failed` con `qr_expired`.
   */
  async confirm(externalId: string): Promise<IntentoDePago> {
    const pago = await this.buscarFila(externalId);

    if (pago.status !== PaymentStatus.pending) {
      return this.aIntento(pago);
    }

    if (this.vencido(pago)) {
      return this.aIntento({
        ...pago,
        status: PaymentStatus.failed,
        failureReason: MotivoAsincrono.qr_expired,
      });
    }

    this.logger.log(`Cobro mock ${externalId} confirmado (${pago.method})`);

    return this.aIntento({ ...pago, status: PaymentStatus.paid, failureReason: null });
  }

  async refund(externalId: string): Promise<IntentoDePago> {
    const pago = await this.buscarFila(externalId);

    if (pago.status === PaymentStatus.refunded) {
      return this.aIntento(pago);
    }

    if (pago.status !== PaymentStatus.paid) {
      throw new AppException(
        ErrorCode.PAYMENT_ALREADY_SETTLED,
        'Solo se puede reembolsar un pago cobrado',
        HttpStatus.CONFLICT,
      );
    }

    await this.latencia();
    this.logger.log(`Reembolso mock de ${externalId} por ${pago.amountCents} centavos`);

    return this.aIntento({ ...pago, status: PaymentStatus.refunded });
  }

  async getReceipt(externalId: string): Promise<DatosDeComprobante> {
    const pago = await this.buscarFila(externalId);

    return {
      externalId,
      status: pago.status,
      amountCents: pago.amountCents,
      currency: pago.currency,
      method: pago.method,
      paidAt: pago.paidAt,
      methodDetails: detalleDe(pago.methodDetails),
    };
  }

  /** Cuando un QR pendiente se paga solo, sin que nadie toque nada. */
  autoConfirmaEn(creadoEn: Date): Date {
    const segundos = this.config.get('PAYMENT_QR_AUTO_CONFIRM_SECONDS');
    return new Date(creadoEn.getTime() + segundos * 1_000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Un metodo, un comportamiento
  // ─────────────────────────────────────────────────────────────────────────

  private intentoDeTarjeta(entrada: EntradaDeIntento): IntentoDePago {
    if (!entrada.card) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Faltan los datos de la tarjeta',
        HttpStatus.BAD_REQUEST,
      );
    }

    const veredicto = evaluarTarjeta(entrada.card);

    // El log lleva marca y ultimos cuatro. Nunca el PAN, ni en desarrollo: lo
    // que entra a un log termina en disco, rotado y copiado a un backup.
    this.logger.log(
      `Intento mock ${veredicto.brand} ****${veredicto.last4}: ` +
        `${veredicto.approved ? 'aprobado' : `rechazado (${veredicto.reason ?? '-'})`}`,
    );

    return {
      externalId: nuevoExternalId(),
      status: veredicto.approved ? PaymentStatus.paid : PaymentStatus.failed,
      amountCents: entrada.amountCents,
      currency: entrada.currency,
      method: PaymentMethod.card,
      methodDetails: {
        brand: veredicto.brand,
        last4: veredicto.last4,
        holder: entrada.card.holder.trim().slice(0, 60),
      },
      expiresAt: null,
      failureReason: veredicto.reason,
    };
  }

  /**
   * QR: se genera un PNG **de verdad**, aunque lo que codifica sea inventado.
   *
   * Un placeholder gris no sirve para probar la pantalla: no se puede enfocar
   * con la camara, no tiene el contraste real y no revela si el tamano elegido
   * es escaneable. El payload imita la forma de un cobro por QR boliviano
   * —identificador, monto, moneda, glosa— para que enchufar el formato real del
   * banco adquirente sea cambiar esta cadena.
   */
  private async intentoDeQr(entrada: EntradaDeIntento): Promise<IntentoDePago> {
    const externalId = nuevoExternalId();
    const referencia = entrada.metadata.registrationId ?? externalId;
    const payload = [
      'PACEUP-QR',
      externalId,
      String(entrada.amountCents),
      entrada.currency,
      referencia,
    ].join('|');

    const png = await QRCode.toBuffer(payload, {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });

    const guardado = await this.storage.save(`payments/qr/${externalId}.png`, png);
    const minutos = this.config.get('PAYMENT_QR_TTL_MINUTES');

    this.logger.log(`QR mock ${externalId} emitido, vence en ${minutos} min`);

    return {
      externalId,
      status: PaymentStatus.pending,
      amountCents: entrada.amountCents,
      currency: entrada.currency,
      method: PaymentMethod.qr,
      methodDetails: { qr: { imageUrl: guardado.url, payload } },
      expiresAt: new Date(Date.now() + minutos * 60_000),
      failureReason: null,
    };
  }

  /**
   * Transferencia bancaria: queda pendiente indefinidamente.
   *
   * No se le pone vencimiento a proposito. Una transferencia entre bancos puede
   * tardar un dia habil, y caducarla sola dejaria al usuario con el dinero
   * enviado y la inscripcion muerta. La cierra una persona desde el panel.
   */
  private intentoDeTransferencia(entrada: EntradaDeIntento): IntentoDePago {
    const externalId = nuevoExternalId();
    const referencia = (entrada.metadata.registrationId ?? externalId).slice(-8).toUpperCase();

    return {
      externalId,
      status: PaymentStatus.pending,
      amountCents: entrada.amountCents,
      currency: entrada.currency,
      method: PaymentMethod.bank_transfer,
      methodDetails: {
        bank: {
          bankName: this.config.get('PAYMENT_BANK_NAME'),
          accountNumber: this.config.get('PAYMENT_BANK_ACCOUNT'),
          accountType: this.config.get('PAYMENT_BANK_ACCOUNT_TYPE'),
          holder: this.config.get('INVOICE_LEGAL_NAME'),
          nit: this.config.get('INVOICE_NIT'),
          reference: `PACEUP-${referencia}`,
        },
      },
      expiresAt: null,
      failureReason: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Internos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Latencia artificial.
   *
   * Un cobro que responde en dos milisegundos deja la UI sin loaders y esconde
   * exactamente los bugs que aparecen cuando la red tarda: el doble tap en
   * "pagar", la pantalla que se cierra a mitad de camino. Se configura por
   * entorno y los tests la ponen en 0.
   */
  private async latencia(): Promise<void> {
    const min = this.config.get('PAYMENT_MOCK_LATENCY_MIN_MS');
    const max = this.config.get('PAYMENT_MOCK_LATENCY_MAX_MS');

    if (max <= 0) return;

    await esperar(min + Math.floor(Math.random() * (max - min + 1)));
  }

  private vencido(pago: { expiresAt: Date | null }): boolean {
    return pago.expiresAt !== null && pago.expiresAt.getTime() <= Date.now();
  }

  private async buscarFila(externalId: string) {
    const pago = await this.prisma.payment.findFirst({ where: { externalId } });

    if (!pago) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'El proveedor no conoce ese cobro',
        HttpStatus.NOT_FOUND,
      );
    }

    return pago;
  }

  private aIntento(pago: {
    externalId: string | null;
    status: PaymentStatus;
    amountCents: number;
    currency: string;
    method: PaymentMethod;
    methodDetails: unknown;
    expiresAt: Date | null;
    failureReason: string | null;
  }): IntentoDePago {
    return {
      externalId: pago.externalId ?? '',
      status: pago.status,
      amountCents: pago.amountCents,
      currency: pago.currency,
      method: pago.method,
      methodDetails: detalleDe(pago.methodDetails),
      expiresAt: pago.expiresAt,
      failureReason: pago.failureReason,
    };
  }
}

/**
 * El JSON de la columna, tipado.
 *
 * Prisma devuelve `JsonValue` —que tambien podria ser un numero o una cadena—,
 * asi que se comprueba que sea un objeto antes de creerselo. Lo escribe siempre
 * este mismo servicio, pero una columna JSON no tiene esquema y una fila vieja
 * o tocada a mano no deberia tumbar el proceso.
 */
function detalleDe(valor: unknown): DetalleDeMetodo {
  return typeof valor === 'object' && valor !== null ? valor : {};
}

/** Con el mismo aire que un `pi_...` de un PSP real, para que el cambio no sorprenda. */
function nuevoExternalId(): string {
  return `mock_pi_${randomBytes(12).toString('hex')}`;
}
