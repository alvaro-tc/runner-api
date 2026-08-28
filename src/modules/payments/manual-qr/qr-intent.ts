import { randomUUID } from 'node:crypto';
import { PaymentMethod, PaymentStatus } from '../../../../generated/prisma/enums';
import type { IntentoDePago } from '../payment-provider';

/**
 * TEMPORAL — el "intento de cobro" del QR manual. Ver `docs/pago-qr-manual.md`.
 *
 * Es una funcion y no un `PaymentProvider` a proposito: **no hay proveedor**.
 * Nadie va a llamar a `confirm()` ni a `refund()` sobre esto; el cobro lo cierra
 * una persona mirando un comprobante. Implementarlo como proveedor obligaria a
 * escribir tres metodos que solo pueden mentir.
 *
 * El QR que se devuelve es el que cargo el organizador en la maraton: el mismo
 * para todos los inscritos. Lo que distingue un pago de otro es la `reference`,
 * que es lo que el corredor pone en la glosa y lo que el organizador cuadra
 * contra su extracto.
 */
export function intentoDeQrManual(entrada: {
  amountCents: number;
  currency: string;
  /**
    * Contenido del QR **como texto**: lo dibuja el cliente. Es el dato que
    * habilita el metodo; la imagen es solo un respaldo para las maratones que
    * todavia tienen el QR subido como archivo.
    */
  qrPayload: string;
  /** URL publica del QR, ya resuelta por `StorageService.publicUrl()`. */
  qrImageUrl: string | null;
  instructions: string | null;
  /** Glosa. Se arma de la inscripcion para que sea corta y unica. */
  reference: string;
  /** Horas que tiene el corredor para subir el comprobante. */
  ttlHoras: number;
}): IntentoDePago {
  return {
    // El prefijo deja claro de un vistazo, en la tabla y en los logs, que
    // detras de este cobro no hubo ningun PSP.
    externalId: `manual_${randomUUID()}`,
    status: PaymentStatus.pending,
    amountCents: entrada.amountCents,
    currency: entrada.currency,
    method: PaymentMethod.qr_manual,
    methodDetails: {
      manualQr: {
        payload: entrada.qrPayload,
        imageUrl: entrada.qrImageUrl,
        instructions: entrada.instructions,
        reference: entrada.reference,
      },
    },
    // No es para soltar cupo —un cobro pendiente no reserva plaza— sino para
    // que quien vuelve tres dias despues reciba un QR y una glosa nuevos en vez
    // de subir el comprobante a un cobro que ya nadie mira. Es un vencimiento
    // blando: lo resuelve la siguiente lectura, no un cron.
    expiresAt: new Date(Date.now() + entrada.ttlHoras * 60 * 60 * 1000),
    failureReason: null,
  };
}

/**
 * Glosa corta y unica por inscripcion.
 *
 * Los ultimos seis del cuid bastan para distinguir inscripciones de la misma
 * maraton, y caben en el campo de glosa de cualquier banca movil — que es el
 * unico requisito real: si no cabe, el corredor la recorta y deja de servir.
 */
export function glosaDe(registrationId: string): string {
  return `PU-${registrationId.slice(-6).toUpperCase()}`;
}
