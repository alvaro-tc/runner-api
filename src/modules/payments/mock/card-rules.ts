import type { DatosDeTarjeta } from '../payment-provider';

/**
 * Reglas deterministas del mock de tarjeta.
 *
 * Funcion pura y sin dependencias: dada una tarjeta y una fecha, siempre
 * devuelve lo mismo. Eso es justamente lo que hace testeable el flujo de pago
 * de punta a punta —y demostrable en una demo— sin depender de la red ni del
 * sandbox de nadie.
 */

/** Motivos de rechazo. Codigos estables: el cliente mapea por esto, no por el texto. */
export const MotivoDeRechazo = {
  /** Numero que no pasa Luhn, CVV mal formado, mes fuera de rango. */
  invalid_card: 'invalid_card',
  /** La fecha de expiracion ya paso. */
  expired_card: 'expired_card',
  /** El emisor rechazo la operacion. */
  card_declined: 'card_declined',
} as const;

export type MotivoDeRechazo = (typeof MotivoDeRechazo)[keyof typeof MotivoDeRechazo];

/**
 * Tarjetas de prueba con resultado fijado.
 *
 * Son las mismas que usa Stripe en su sandbox a proposito: cualquiera que haya
 * integrado pagos alguna vez ya se las sabe de memoria, y ademas son validas
 * por Luhn, asi que no chocan con la validacion estructural.
 */
export const TARJETAS_DE_PRUEBA: Record<string, MotivoDeRechazo | 'approved'> = {
  '4242424242424242': 'approved',
  '4000000000000002': MotivoDeRechazo.card_declined,
  '4000000000000069': MotivoDeRechazo.expired_card,
};

export interface ResultadoDeTarjeta {
  approved: boolean;
  reason: MotivoDeRechazo | null;
  brand: string;
  last4: string;
}

/** Marca deducida del prefijo. Solo para pintar el logo correcto en la UI. */
export function marcaDe(numero: string): string {
  const n = soloDigitos(numero);

  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^6(011|5)/.test(n)) return 'discover';

  return 'unknown';
}

/**
 * Algoritmo de Luhn: el digito verificador que llevan todas las tarjetas.
 *
 * No prueba que la tarjeta exista, solo que el numero no esta mal tecleado.
 * Sirve para rechazar en el cliente lo que el emisor rechazaria igual, sin
 * gastar una llamada.
 */
export function pasaLuhn(numero: string): boolean {
  const n = soloDigitos(numero);
  if (n.length < 12 || n.length > 19) return false;

  let suma = 0;
  let duplicar = false;

  for (let i = n.length - 1; i >= 0; i--) {
    let digito = n.charCodeAt(i) - 48;

    if (duplicar) {
      digito *= 2;
      if (digito > 9) digito -= 9;
    }

    suma += digito;
    duplicar = !duplicar;
  }

  return suma % 10 === 0;
}

/**
 * Decide si el cobro pasa.
 *
 * Orden deliberado: primero lo estructural (un numero mal tecleado es
 * `invalid_card`, no un rechazo del emisor), despues la expiracion, y solo al
 * final la tabla de tarjetas de prueba. Cualquier tarjeta que no este en la
 * tabla y sea estructuralmente valida se aprueba, para que los seeds y las
 * pruebas manuales no tengan que memorizar numeros.
 */
export function evaluarTarjeta(tarjeta: DatosDeTarjeta, ahora = new Date()): ResultadoDeTarjeta {
  const numero = soloDigitos(tarjeta.number);
  const marca = marcaDe(numero);
  const last4 = numero.slice(-4);
  const base = { brand: marca, last4 };

  if (!pasaLuhn(numero) || !/^\d{3,4}$/.test(tarjeta.cvv.trim())) {
    return { ...base, approved: false, reason: MotivoDeRechazo.invalid_card };
  }

  if (tarjeta.expMonth < 1 || tarjeta.expMonth > 12) {
    return { ...base, approved: false, reason: MotivoDeRechazo.invalid_card };
  }

  if (estaVencida(tarjeta.expMonth, tarjeta.expYear, ahora)) {
    return { ...base, approved: false, reason: MotivoDeRechazo.expired_card };
  }

  const fijado = TARJETAS_DE_PRUEBA[numero];

  if (fijado && fijado !== 'approved') {
    return { ...base, approved: false, reason: fijado };
  }

  return { ...base, approved: true, reason: null };
}

/** Una tarjeta vale hasta el ULTIMO dia del mes impreso, no hasta el primero. */
function estaVencida(mes: number, anio: number, ahora: Date): boolean {
  // Dia 1 del mes siguiente: mientras `ahora` sea anterior, la tarjeta vive.
  const vence = new Date(Date.UTC(anio, mes, 1));
  return ahora.getTime() >= vence.getTime();
}

function soloDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}
