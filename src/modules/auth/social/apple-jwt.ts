import { createHash, sign, verify, type KeyObject } from 'node:crypto';

/**
 * Lo minimo de JWT que necesita Sign in with Apple, sobre `node:crypto`.
 *
 * Son dos operaciones y ninguna mas: **verificar** con RS256 lo que firma Apple
 * (el identity token y las notificaciones servidor a servidor) y **firmar** con
 * ES256 el `client_secret` que Apple exige para hablar con su API REST. Una
 * libreria de JWT entera para esto seria una dependencia mas que actualizar.
 */

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** `base64url(header).base64url(payload)`: lo que cubre la firma. */
  signingInput: string;
  signature: Buffer;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Separa un JWS compacto. `null` si no tiene forma de JWT: no lanza. */
export function decodeJwt(token: string): JwtParts | null {
  const partes = token.split('.');
  if (partes.length !== 3 || partes.some((p) => p.length === 0)) return null;

  try {
    const header: unknown = JSON.parse(Buffer.from(partes[0]!, 'base64url').toString('utf8'));
    const payload: unknown = JSON.parse(Buffer.from(partes[1]!, 'base64url').toString('utf8'));
    if (!esObjeto(header) || !esObjeto(payload)) return null;

    return {
      header,
      payload,
      signingInput: `${partes[0]}.${partes[1]}`,
      signature: Buffer.from(partes[2]!, 'base64url'),
    };
  } catch {
    return null;
  }
}

/** Firma RS256 —la que usa Apple— contra una clave publica ya importada. */
export function verifyRs256(parts: JwtParts, key: KeyObject): boolean {
  try {
    return verify('RSA-SHA256', Buffer.from(parts.signingInput), key, parts.signature);
  } catch {
    return false;
  }
}

/**
 * JWS compacto firmado con ES256 (P-256 + SHA-256).
 *
 * `ieee-p1363` y no DER: JWS quiere la firma como `r || s` de 64 bytes, y
 * `node:crypto` por defecto la devuelve en DER, que Apple rechaza.
 */
export function signEs256(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string,
): string {
  const b64 = (valor: unknown) => Buffer.from(JSON.stringify(valor)).toString('base64url');
  const entrada = `${b64({ ...header, alg: 'ES256' })}.${b64(payload)}`;
  const firma = sign('sha256', Buffer.from(entrada), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  });
  return `${entrada}.${firma.toString('base64url')}`;
}

/** SHA-256 en hex: es como la app manda el nonce a Apple y como vuelve en el token. */
export function sha256Hex(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}
