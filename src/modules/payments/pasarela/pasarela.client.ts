import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';

/** Estados de un cobro en la pasarela (`Documentacion-api.md` §5). */
export type EstadoPasarela =
  | 'PENDING'
  | 'AWAITING_PAYMENT'
  | 'AWAITING_RECEIPT'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'DISPUTED';

export interface CobroPasarela {
  intent_id: string;
  status: EstadoPasarela;
  qr?: {
    payload: string;
    base_amount: string;
    final_amount: string;
    currency: string;
    reference: string;
    expires_at: string;
    expiry_notice?: string;
  };
}

/** `"150.01"` -> 15001. Por texto, nunca por float: es dinero. */
export function aCentavos(monto: string): number {
  const [entero, dec = ''] = monto.trim().split('.');
  return Number(entero) * 100 + Number(dec.padEnd(2, '0').slice(0, 2));
}

/** 15001 -> `"150.01"`. */
export function aMonto(centavos: number): string {
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;
}

/**
 * Cliente de la API de cobros QR. La api key vive solo aqui, en el servidor.
 *
 * No implementa `PaymentProvider` a proposito: ese contrato es para tarjeta y
 * tiene `refund`, que esta API no ofrece. Aqui solo hay crear y consultar.
 */
@Injectable()
export class PasarelaClient {
  private readonly logger = new Logger(PasarelaClient.name);

  constructor(private readonly config: AppConfigService) {}

  get configurada(): boolean {
    return !!(this.config.get('PASARELA_API_URL') && this.config.get('PASARELA_API_KEY'));
  }

  /** Abre el cobro. `clave` es la Idempotency-Key: reintentar devuelve el mismo. */
  async crear(clave: string, centavos: number, moneda: string): Promise<CobroPasarela> {
    const monto = aMonto(centavos);
    // Precalentar hace el cobro instantaneo; si falla, el cobro sale igual (mas lento).
    await this.llamar('POST', '/v1/pool/warm', { base_amounts: [monto] }).catch(() => undefined);
    return this.llamar<CobroPasarela>(
      'POST',
      '/v1/payment-intents',
      { base_amount: monto, currency: moneda, ttl_seconds: this.config.get('PASARELA_QR_TTL_SECONDS') },
      { 'Idempotency-Key': clave },
    );
  }

  consultar(intentId: string): Promise<CobroPasarela> {
    return this.llamar('GET', `/v1/payment-intents/${encodeURIComponent(intentId)}`);
  }

  private async llamar<T>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<T> {
    if (!this.configurada) {
      throw new AppException(
        ErrorCode.PASARELA_UNAVAILABLE,
        'La API de pagos no esta configurada en el servidor',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    let res: Response;
    try {
      res = await fetch(this.config.get('PASARELA_API_URL')!.replace(/\/$/, '') + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.get('PASARELA_API_KEY')}`,
          'Content-Type': 'application/json',
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(90_000), // sin pool, generar en el telefono tarda ~55 s
      });
    } catch (e) {
      this.logger.error(`Pasarela ${method} ${path}: ${(e as Error).message}`);
      throw new AppException(
        ErrorCode.PASARELA_UNAVAILABLE,
        'No pudimos conectar con la API de pagos. Intenta de nuevo en un momento.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      this.logger.warn(`Pasarela ${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
      const retryAfter = Number(json.retry_after ?? res.headers.get('retry-after')) || null;
      throw new AppException(
        ErrorCode.PASARELA_UNAVAILABLE,
        res.status === 503
          ? `La API de pagos no tiene capacidad ahora${retryAfter ? `: intenta en ${retryAfter} s` : ''}`
          : `La API de pagos respondio ${res.status}`,
        HttpStatus.SERVICE_UNAVAILABLE,
        [{ status: res.status, reason: json.reason ?? json.error ?? null, retryAfter }],
      );
    }
    return json as T;
  }
}
