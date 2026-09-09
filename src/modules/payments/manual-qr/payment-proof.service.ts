import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import sharp from 'sharp';
import { AppConfigService } from '../../../config/app-config.service';
import { PrismaService } from '../../../database/prisma.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { StorageService } from '../../storage/storage.service';
import {
  PaymentMethod,
  PaymentProofStatus,
  PaymentStatus,
} from '../../../../generated/prisma/enums';
import type { PaymentProof } from '../../../../generated/prisma/client';
import { PaymentsService } from '../payments.service';
import { LiveService } from '../../realtime/live.service';

/**
 * Formatos que sabemos decodificar. Todo sale convertido a WebP igual.
 *
 * ponytail: es la misma lista que `AvatarService`, copiada y no compartida
 * porque el procesado es distinto —un avatar se recorta cuadrado, un
 * comprobante tiene que seguir siendo legible— y el dia que este modulo se
 * borre no debe quedar un helper huerfano. Si aparece un tercer consumidor,
 * extraer a `common/utils/image.ts`.
 */
const FORMATOS_ACEPTADOS = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif', 'gif', 'heif', 'tiff']);

/** Tope de pixeles antes de redimensionar, contra las "decompression bombs". */
const MAX_PIXELES = 50_000_000;

/** Lo que ve el corredor y el organizador de un comprobante. */
export interface ComprobanteDto {
  id: string;
  paymentId: string;
  status: PaymentProofStatus;
  imageUrl: string;
  reference: string | null;
  note: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/**
 * TEMPORAL — comprobantes de pago del flujo de QR manual.
 * Ver `docs/pago-qr-manual.md`.
 *
 * El corredor sube una imagen; el cobro **no se da por bueno por eso**: queda
 * `pending` con un comprobante `in_review`, y solo cuando un organizador lo
 * aprueba se acredita el pago y se emite el dorsal. Es la diferencia entre "ya
 * lo mande" y "ya lo cobraron", y confundirlas es como se acaba con corredores
 * inscritos que no pagaron.
 *
 * No reimplementa nada del cobro: aprobar delega en
 * `PaymentsService.acreditarManualmente()`, que es el unico sitio donde se
 * reserva cupo y se emite dorsal.
 */
@Injectable()
export class PaymentProofService {
  private readonly logger = new Logger(PaymentProofService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
    // El ciclo es real: el checkout de pagos abre el cobro `qr_manual` y este
    // servicio lo cierra a traves de pagos. `forwardRef` lo declara en vez de
    // esconderlo moviendo la logica de sitio.
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
    // Rechazar no cambia la inscripcion —el cobro sigue pendiente—, asi que el
    // aviso hay que darlo desde aqui: nadie mas lo va a dar.
    private readonly live: LiveService,
  ) {}

  // ---------------------------------------------------------------------------
  //  Subida
  // ---------------------------------------------------------------------------

  /**
   * Guarda el comprobante de un cobro y lo deja esperando revision.
   *
   * `paymentId` ya viene autorizado por quien llama —la sesion del corredor o
   * el token publico de la web—: este servicio no sabe de usuarios a proposito,
   * porque los dos caminos que lo usan autorizan de forma distinta.
   */
  async subir(
    paymentId: string,
    archivo: { buffer: Buffer; size: number },
    referencia?: string,
  ): Promise<ComprobanteDto> {
    const pago = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    if (!pago) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No se encontro ese pago', HttpStatus.NOT_FOUND);
    }

    if (pago.method !== PaymentMethod.qr_manual) {
      throw new AppException(
        ErrorCode.PROOF_NOT_ALLOWED,
        'Solo los cobros por QR admiten comprobante',
        HttpStatus.BAD_REQUEST,
        [{ method: pago.method }],
      );
    }

    if (pago.status !== PaymentStatus.pending) {
      throw new AppException(
        ErrorCode.PROOF_NOT_ALLOWED,
        'Ese cobro ya esta cerrado',
        HttpStatus.CONFLICT,
        [{ status: pago.status }],
      );
    }

    // Un segundo comprobante encima de uno sin revisar le da al organizador dos
    // imagenes y ninguna verdad. Para corregir, primero hay que rechazar.
    const enRevision = await this.prisma.paymentProof.findFirst({
      where: { paymentId, status: PaymentProofStatus.in_review },
      select: { id: true },
    });

    if (enRevision) {
      throw new AppException(
        ErrorCode.PROOF_ALREADY_IN_REVIEW,
        'Ya hay un comprobante esperando revision para este pago',
        HttpStatus.CONFLICT,
        [{ proofId: enRevision.id }],
      );
    }

    const webp = await this.procesar(archivo);
    const clave = `payments/proofs/${paymentId}/${randomUUID()}.webp`;
    await this.storage.save(clave, webp);

    const comprobante = await this.prisma.paymentProof.create({
      data: { paymentId, imageKey: clave, reference: referencia?.trim() || null },
    });

    this.logger.log(`Comprobante ${comprobante.id} subido para el cobro ${paymentId}`);

    return this.toDto(comprobante);
  }

  // ---------------------------------------------------------------------------
  //  Revision
  // ---------------------------------------------------------------------------

  /** Comprobantes esperando a que alguien los mire, del mas viejo al mas nuevo. */
  async pendientes(limite = 100) {
    const filas = await this.prisma.paymentProof.findMany({
      where: { status: PaymentProofStatus.in_review },
      // Del mas viejo primero: es una cola de trabajo, no un muro de novedades.
      orderBy: { createdAt: 'asc' },
      take: limite,
      include: {
        payment: {
          include: {
            registration: {
              include: {
                user: { select: { id: true, name: true, email: true, ci: true } },
                marathon: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    return filas.map((f) => ({
      ...this.toDto(f),
      amountCents: f.payment.amountCents,
      currency: f.payment.currency,
      registrationId: f.payment.registrationId,
      marathon: f.payment.registration.marathon.name,
      runner: f.payment.registration.user.name,
      runnerCi: f.payment.registration.user.ci,
      runnerEmail: f.payment.registration.user.email,
    }));
  }

  /** El ultimo comprobante de un cobro. Es lo que la app pinta junto al estado. */
  async ultimoDe(paymentId: string): Promise<ComprobanteDto | null> {
    const fila = await this.prisma.paymentProof.findFirst({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
    });

    return fila ? this.toDto(fila) : null;
  }

  /**
   * Da el comprobante por bueno: acredita el cobro y confirma la inscripcion.
   *
   * El orden importa. Primero se marca el comprobante —condicionado a
   * `in_review`, para que dos organizadores impacientes no aprueben el mismo—
   * y solo el que gano esa carrera llama a acreditar. Al reves, dos
   * aprobaciones simultaneas pedirian dos dorsales.
   */
  async aprobar(proofId: string, adminUserId: string, nota?: string) {
    const comprobante = await this.buscar(proofId);

    const { count } = await this.prisma.paymentProof.updateMany({
      where: { id: proofId, status: PaymentProofStatus.in_review },
      data: {
        status: PaymentProofStatus.approved,
        reviewedById: adminUserId,
        reviewedAt: new Date(),
        note: nota?.trim() || null,
      },
    });

    if (count === 0) {
      throw new AppException(
        ErrorCode.PROOF_ALREADY_REVIEWED,
        'Ese comprobante ya lo reviso alguien',
        HttpStatus.CONFLICT,
        [{ status: comprobante.status }],
      );
    }

    try {
      await this.payments.acreditarManualmente(
        comprobante.paymentId,
        adminUserId,
        comprobante.reference ?? undefined,
      );
    } catch (error) {
      // Acreditar fallo —se agoto el cupo mientras el comprobante esperaba—:
      // el comprobante vuelve a `in_review` para que no quede aprobado sobre un
      // cobro que sigue pendiente, que es un estado que nadie sabria leer.
      await this.prisma.paymentProof.update({
        where: { id: proofId },
        data: { status: PaymentProofStatus.in_review, reviewedById: null, reviewedAt: null },
      });

      throw error;
    }

    this.logger.log(`Comprobante ${proofId} aprobado por ${adminUserId}`);

    return this.toDto(await this.buscar(proofId));
  }

  /**
   * Rechaza el comprobante. El **cobro sigue `pending`** a proposito: lo normal
   * es que el corredor haya subido la captura equivocada, y dejarlo `failed` le
   * obligaria a rehacer la inscripcion entera por una foto.
   */
  async rechazar(proofId: string, adminUserId: string, motivo: string) {
    const comprobante = await this.buscar(proofId);

    const { count } = await this.prisma.paymentProof.updateMany({
      where: { id: proofId, status: PaymentProofStatus.in_review },
      data: {
        status: PaymentProofStatus.rejected,
        reviewedById: adminUserId,
        reviewedAt: new Date(),
        note: motivo.trim(),
      },
    });

    if (count === 0) {
      throw new AppException(
        ErrorCode.PROOF_ALREADY_REVIEWED,
        'Ese comprobante ya lo reviso alguien',
        HttpStatus.CONFLICT,
        [{ status: comprobante.status }],
      );
    }

    this.logger.log(`Comprobante ${proofId} rechazado por ${adminUserId}: ${motivo}`);

    const pago = await this.prisma.payment.findUnique({
      where: { id: comprobante.paymentId },
      select: { registrationId: true },
    });

    if (pago) await this.live.anunciarInscripcion(pago.registrationId);

    return this.toDto(await this.buscar(proofId));
  }

  // ---------------------------------------------------------------------------
  //  Internos
  // ---------------------------------------------------------------------------

  private async buscar(proofId: string): Promise<PaymentProof> {
    const fila = await this.prisma.paymentProof.findUnique({ where: { id: proofId } });

    if (!fila) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No se encontro ese comprobante',
        HttpStatus.NOT_FOUND,
      );
    }

    return fila;
  }

  toDto(fila: PaymentProof): ComprobanteDto {
    return {
      id: fila.id,
      paymentId: fila.paymentId,
      status: fila.status,
      // En la BD vive la clave; la URL se arma al leer, como en todo el resto.
      imageUrl: this.storage.url(fila.imageKey),
      reference: fila.reference,
      note: fila.note,
      reviewedAt: fila.reviewedAt?.toISOString() ?? null,
      createdAt: fila.createdAt.toISOString(),
    };
  }

  /**
   * Valida y reencoda el comprobante.
   *
   * El tipo real se decide **decodificando**, no por el `Content-Type` ni por
   * la extension: los dos los escribe el cliente. Se reencoda a WebP, lo que de
   * paso tira el EXIF —una foto de telefono lleva las coordenadas GPS de donde
   * se tomo, y un comprobante suele sacarse en casa—.
   *
   * No se recorta ni se cuadra: lo unico que importa de esta imagen es que el
   * numero de transaccion siga siendo legible.
   */
  private async procesar(archivo: { buffer: Buffer; size: number }): Promise<Buffer> {
    const maximo = this.config.get('PAYMENT_PROOF_MAX_BYTES');

    if (archivo.size > maximo) {
      throw new AppException(
        ErrorCode.FILE_TOO_LARGE,
        `El comprobante supera el maximo de ${Math.round(maximo / 1024 / 1024)} MB`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const imagen = sharp(archivo.buffer, { failOn: 'error', limitInputPixels: MAX_PIXELES });

    let formato: string | undefined;
    try {
      formato = (await imagen.metadata()).format;
    } catch (error) {
      this.logger.debug(`Comprobante rechazado: ${(error as Error).message}`);
      throw this.noEsImagen();
    }

    if (!formato || !FORMATOS_ACEPTADOS.has(formato)) throw this.noEsImagen();

    try {
      return await imagen
        .rotate() // aplica la orientacion EXIF, o sale tumbado
        .resize({
          width: this.config.get('PAYMENT_PROOF_MAX_WIDTH_PX'),
          // Sin ampliar: una captura de 700 px ya es legible y estirarla solo
          // la emborrona y pesa mas.
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toBuffer();
    } catch (error) {
      this.logger.debug(`Comprobante ilegible: ${(error as Error).message}`);
      throw this.noEsImagen();
    }
  }

  private noEsImagen(): AppException {
    return new AppException(
      ErrorCode.INVALID_IMAGE,
      'El comprobante no es una imagen valida (JPEG, PNG, WebP, AVIF, GIF o HEIF)',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }
}
