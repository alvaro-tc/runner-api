import { ServiceFeeScope, ServiceFeeType } from '../../../generated/prisma/enums';

/**
 * Calculo del cargo por servicio. Funcion pura, sin base de datos.
 *
 * Todo el dinero es **centavos enteros**. Nunca aparece un `float` en este
 * archivo: 0.1 + 0.2 no da 0.3 en coma flotante, y un centavo que se pierde por
 * redondeo en cada inscripcion es una diferencia contable que despues nadie
 * sabe explicar. El porcentaje viaja en **puntos basicos** (1000 = 10%) por lo
 * mismo: es un entero.
 */

/** Lo que hace falta saber de una config para aplicarla. */
export interface ConfigDeFee {
  id: string;
  scope: ServiceFeeScope;
  enabled: boolean;
  type: ServiceFeeType;
  percentBps: number | null;
  fixedCents: number | null;
  minCents: number | null;
  maxCents: number | null;
  label: string;
}

/** Lo que se guarda en `Registration.serviceFeeSnapshot` al confirmar. */
export interface SnapshotDeFee {
  configId: string;
  scope: ServiceFeeScope;
  type: ServiceFeeType;
  percentBps: number | null;
  fixedCents: number | null;
  minCents: number | null;
  maxCents: number | null;
  label: string;
  /** Sobre que base se calculo. Sin esto el snapshot no se puede reauditar. */
  subtotalCents: number;
  amountCents: number;
  appliedAt: string;
}

export interface FeeAplicado {
  label: string;
  amountCents: number;
  snapshot: SnapshotDeFee;
}

const BPS_POR_UNIDAD = 10_000;

/**
 * Devuelve `null` cuando **no hay que cobrar nada ni mostrar la linea**.
 *
 * `null` no es lo mismo que `amountCents: 0`. Con el fee apagado la UI no debe
 * pintar un "Cargo por servicio  Bs 0,00": esa linea le dice al usuario que
 * existe un cargo que hoy no se le cobra, y es una promesa que nadie quiso
 * hacer. Por eso el estado "apagado" viaja como ausencia, no como cero.
 */
export function calcularServiceFee(
  config: ConfigDeFee | null,
  subtotalCents: number,
  ahora: Date = new Date(),
): FeeAplicado | null {
  if (!config || !config.enabled) return null;

  // Un subtotal de 0 (carrera gratuita, o cortesia) no genera cargo. Sin esta
  // guarda, un `minCents` de Bs 5 convertiria una inscripcion gratis en una de
  // Bs 5, que es exactamente lo contrario de lo que quiso el organizador.
  if (subtotalCents <= 0) return null;

  const bruto = montoBruto(config, subtotalCents);
  const amountCents = acotar(bruto, config.minCents, config.maxCents);

  if (amountCents <= 0) return null;

  return {
    label: config.label,
    amountCents,
    snapshot: {
      configId: config.id,
      scope: config.scope,
      type: config.type,
      percentBps: config.percentBps,
      fixedCents: config.fixedCents,
      minCents: config.minCents,
      maxCents: config.maxCents,
      label: config.label,
      subtotalCents,
      amountCents,
      appliedAt: ahora.toISOString(),
    },
  };
}

function montoBruto(config: ConfigDeFee, subtotalCents: number): number {
  const porcentaje = config.percentBps ?? 0;
  const fijo = config.fixedCents ?? 0;

  switch (config.type) {
    case ServiceFeeType.percent:
      return porcentualDe(subtotalCents, porcentaje);
    case ServiceFeeType.fixed:
      return fijo;
    case ServiceFeeType.mixed:
      return porcentualDe(subtotalCents, porcentaje) + fijo;
  }
}

/**
 * Redondeo al centavo mas cercano, con los medios hacia arriba.
 *
 * `Math.round` sobre un entero dividido es exacto aqui porque el producto
 * `subtotal * bps` cabe de sobra en un entero seguro de JS: haria falta una
 * inscripcion de mas de 900 millones de bolivianos para acercarse al limite.
 */
function porcentualDe(subtotalCents: number, bps: number): number {
  return Math.round((subtotalCents * bps) / BPS_POR_UNIDAD);
}

/** El maximo manda sobre el minimo si el organizador los cargo cruzados. */
function acotar(monto: number, min: number | null, max: number | null): number {
  let resultado = Math.max(0, monto);

  if (min !== null) resultado = Math.max(resultado, min);
  if (max !== null) resultado = Math.min(resultado, max);

  return resultado;
}

/** Solo por legibilidad en el resolver: un override apagado apaga de verdad. */
export const ALCANCE_MARATON = ServiceFeeScope.marathon;
export const ALCANCE_GLOBAL = ServiceFeeScope.global;
