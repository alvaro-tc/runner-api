import type {
  PaymentMethod,
  PaymentProviderName,
  PaymentStatus,
} from '../../../generated/prisma/enums';

/**
 * Contrato del proveedor de pagos.
 *
 * El resto de la aplicacion **nunca** habla con un PSP concreto: pide un cobro
 * a esta interfaz y guarda lo que devuelve. Hoy detras hay un mock; el dia que
 * entre un proveedor real (QR Simple del BCB via banco adquirente, una pasarela
 * local) se escribe otra implementacion y se cambia el provider del modulo. El
 * flujo de inscripcion, los estados y la tabla `payments` no se tocan.
 *
 * Los cuatro metodos son los del enunciado: `createIntent` abre el cobro,
 * `confirm` lo resuelve, `refund` lo revierte y `getReceipt` da los datos del
 * comprobante.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** Lo que la app necesita para pintar la pantalla del QR. */
export interface DetalleDeQr {
  /** URL publica del PNG ya generado. La app lo muestra tal cual. */
  imageUrl: string;
  /** Cadena que codifica el QR. Sirve para "copiar codigo" y para depurar. */
  payload: string;
}

/** Datos bancarios para que el usuario haga la transferencia. */
export interface DetalleDeBanco {
  bankName: string;
  accountNumber: string;
  accountType: string;
  holder: string;
  nit: string;
  /** Glosa que el usuario tiene que poner en la transferencia. Es lo que
   *  permite a quien confirma a mano saber a que inscripcion corresponde. */
  reference: string;
}

/**
 * TEMPORAL — QR de cobro del organizador, verificado a mano.
 *
 * No lo emite ningun proveedor: es la imagen que cargo el organizador en la
 * maraton. Va en un campo propio y no reutiliza `qr` a proposito: el dia que
 * entre una pasarela real se borra este campo y el `qr` de verdad se queda como
 * esta. Ver `docs/pago-qr-manual.md`.
 */
export interface DetalleDeQrManual {
  /**
   * Contenido del QR **como texto**, tal como lo cargo el organizador. Lo
   * dibuja el cliente: un string viaja en bytes donde una imagen viaja en
   * cientos de KB, y el codigo sale nitido a cualquier tamano.
   */
  payload: string;
  /** URL publica del QR de la maraton, si se subio como imagen. Respaldo. */
  imageUrl: string | null;
  /** Instrucciones del organizador: a que cuenta llega, que glosa poner. */
  instructions: string | null;
  /** Glosa que identifica la inscripcion en el extracto del organizador. */
  reference: string;
}

/** Datos enmascarados que SI se pueden guardar y mostrar. Nunca el PAN. */
export interface DetalleDeMetodo {
  /** `visa`, `mastercard`, `amex`, `unknown`. Solo para el metodo `card`. */
  brand?: string;
  /** Ultimos cuatro digitos. Lo unico del numero que se persiste. */
  last4?: string;
  /** Nombre impreso en la tarjeta, tal como lo tecleo el usuario. */
  holder?: string;
  /** Solo para el metodo `qr`. */
  qr?: DetalleDeQr;
  /** Solo para el metodo `bank_transfer`. */
  bank?: DetalleDeBanco;
  /** TEMPORAL — solo para el metodo `qr_manual`. */
  manualQr?: DetalleDeQrManual;
}

/**
 * Un cobro visto desde el proveedor. Es lo que se vuelca sobre la fila
 * `Payment`: el servicio no interpreta nada, solo persiste.
 */
export interface IntentoDePago {
  /** Id del lado del proveedor. Con un PSP real seria el `pi_...` de su API. */
  externalId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  method: PaymentMethod;
  methodDetails: DetalleDeMetodo;
  /** Solo lo llenan los metodos asincronos (QR): cuando caduca el codigo. */
  expiresAt: Date | null;
  /** Motivo del rechazo cuando `status = failed`. Codigo estable, no texto. */
  failureReason: string | null;
}

export interface EntradaDeIntento {
  amountCents: number;
  currency: string;
  method: PaymentMethod;
  /** Datos crudos del metodo. El proveedor es el UNICO que ve el PAN completo,
   *  y lo descarta: de aca para afuera solo circula `brand` + `last4`. */
  card?: DatosDeTarjeta;
  /** Contexto para trazar el cobro: inscripcion, maraton, usuario. */
  metadata: Record<string, string>;
}

export interface DatosDeTarjeta {
  number: string;
  holder: string;
  expMonth: number;
  expYear: number;
  cvv: string;
}

export interface DatosDeComprobante {
  externalId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  method: PaymentMethod;
  paidAt: Date | null;
  methodDetails: DetalleDeMetodo;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;

  /** Abre el cobro. Con `card` puede quedar resuelto en el acto; con `qr` o
   *  `bank_transfer` queda `pending` esperando confirmacion externa. */
  createIntent(entrada: EntradaDeIntento): Promise<IntentoDePago>;

  /** Resuelve un cobro pendiente. Idempotente: confirmar dos veces devuelve el
   *  mismo intento sin cobrar de nuevo. */
  confirm(externalId: string): Promise<IntentoDePago>;

  /** Revierte un cobro ya realizado. */
  refund(externalId: string): Promise<IntentoDePago>;

  /** Datos para el comprobante. El PDF se arma en el checkpoint 8c. */
  getReceipt(externalId: string): Promise<DatosDeComprobante>;
}
