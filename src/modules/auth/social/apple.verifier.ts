import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { decodeJwt, sha256Hex, verifyRs256 } from './apple-jwt';

/** Lo que importa del identity token de Apple. */
export interface AppleIdentity {
  /**
   * El identificador estable del usuario para este equipo de desarrollo. Es
   * **la** identidad: el email puede ser un relay, dejar de compartirse o
   * cambiar; el `sub` no.
   */
  sub: string;
  /** El real o el de "Ocultar mi correo" (`@privaterelay.appleid.com`). */
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
  /**
   * Para que app se emitio el token (el bundle ID en iOS). Es el `client_id`
   * con el que hay que canjear el codigo y revocar despues: Apple exige que
   * sea el mismo.
   */
  clientId: string;
}

/** Una notificacion servidor a servidor de Apple, ya verificada. */
export interface AppleAccountEvent {
  type: string;
  sub: string;
  email: string | null;
}

/** Claves publicas de Apple: se refrescan una vez al dia o al ver un `kid` nuevo. */
const CLAVES_TTL_MS = 24 * 60 * 60 * 1000;
/** Margen para no ir a Apple en cada token con un `kid` desconocido. */
const CLAVES_REINTENTO_MS = 60 * 1000;
/** Holgura de reloj entre este servidor y el de Apple. */
const HOLGURA_SEGUNDOS = 30;

/**
 * Verifica lo que firma Apple: el identity token que la app recibe al iniciar
 * sesion y las notificaciones servidor a servidor.
 *
 * Sigue al pie de la letra "Verifying a user" de la documentacion de Apple:
 * firma con la clave publica de `appleid.apple.com/auth/keys`, `nonce`, `iss`,
 * `aud` y `exp`. El `aud` es lo que separa "un token de Apple" de "un token de
 * Apple **para nosotros**": sin el, el token emitido para cualquier otra app
 * del mundo valdria aqui.
 */
@Injectable()
export class AppleVerifier {
  static readonly ISSUER = 'https://appleid.apple.com';
  static readonly KEYS_URL = 'https://appleid.apple.com/auth/keys';

  private readonly logger = new Logger(AppleVerifier.name);
  private claves = new Map<string, KeyObject>();
  private cargadasEn = 0;

  constructor(private readonly config: AppConfigService) {}

  /** `false` sin client IDs configurados: el endpoint responde 503. */
  get enabled(): boolean {
    return this.config.get('APPLE_CLIENT_IDS').length > 0;
  }

  /**
   * [rawNonce] es el nonce **sin** hashear que genero la app. Apple recibio su
   * SHA-256 y lo devuelve dentro del token: comprobarlo aqui es lo que impide
   * reenviar un token robado, porque el nonce solo lo conocia esa app en ese
   * momento.
   */
  async verifyIdentityToken(identityToken: string, rawNonce: string): Promise<AppleIdentity> {
    this.exigirConfiguracion();
    const claims = await this.verificar(identityToken, { exigirExp: true });

    const nonce = claims['nonce'];
    if (typeof nonce !== 'string' || nonce !== sha256Hex(rawNonce)) {
      this.logger.warn('Identity token de Apple con nonce que no coincide');
      throw this.rechazo();
    }

    const sub = claims['sub'];
    if (typeof sub !== 'string' || sub.length === 0) throw this.rechazo();

    const email = typeof claims['email'] === 'string' ? claims['email'] : null;

    return {
      sub,
      email,
      emailVerified: verdadero(claims['email_verified']),
      isPrivateEmail: verdadero(claims['is_private_email']),
      clientId: claims['aud'] as string,
    };
  }

  /**
   * El `payload` del POST que Apple manda a nuestro endpoint de notificaciones.
   * Mismo emisor, mismas claves y mismo `aud` que el identity token.
   */
  async verifyNotification(payload: string): Promise<AppleAccountEvent> {
    this.exigirConfiguracion();
    // Las notificaciones de ejemplo de Apple no traen `exp`: llevan `iat`.
    const claims = await this.verificar(payload, { exigirExp: false });

    // `events` llega como texto JSON aunque la documentacion lo pinte como
    // objeto; se aceptan las dos formas.
    let eventos: unknown = claims['events'];
    if (typeof eventos === 'string') {
      try {
        eventos = JSON.parse(eventos);
      } catch {
        eventos = null;
      }
    }

    const evento = eventos as Record<string, unknown> | null;
    if (
      !evento ||
      typeof evento['type'] !== 'string' ||
      typeof evento['sub'] !== 'string' ||
      evento['sub'].length === 0
    ) {
      throw this.rechazo();
    }

    return {
      type: evento['type'],
      sub: evento['sub'],
      email: typeof evento['email'] === 'string' ? evento['email'] : null,
    };
  }

  /** Firma, `iss`, `aud` y `exp`. Devuelve los claims solo si todo cuadra. */
  private async verificar(
    token: string,
    { exigirExp }: { exigirExp: boolean },
  ): Promise<Record<string, unknown>> {
    const partes = decodeJwt(token);

    // Solo RS256: es lo que publica Apple. Aceptar el `alg` que diga el propio
    // token es la puerta clasica a que alguien firme con `none` o con HMAC.
    if (!partes || partes.header['alg'] !== 'RS256' || typeof partes.header['kid'] !== 'string') {
      throw this.rechazo();
    }

    const clave = await this.clave(partes.header['kid']);
    if (!clave || !verifyRs256(partes, clave)) {
      this.logger.warn('Token de Apple con firma invalida o clave desconocida');
      throw this.rechazo();
    }

    const claims = partes.payload;
    const ahora = Math.floor(Date.now() / 1000);

    if (claims['iss'] !== AppleVerifier.ISSUER) throw this.rechazo();

    const aceptados = this.config.get('APPLE_CLIENT_IDS');
    const aud = claims['aud'];
    const audiencias = Array.isArray(aud) ? aud : [aud];
    const propio = audiencias.find(
      (a): a is string => typeof a === 'string' && aceptados.includes(a),
    );
    if (!propio) {
      this.logger.warn(`Token de Apple para otra app (aud=${String(aud)})`);
      throw this.rechazo();
    }
    // Se normaliza a la audiencia propia: es la que se usa como `client_id`.
    claims['aud'] = propio;

    const exp = claims['exp'];
    if (exigirExp && typeof exp !== 'number') throw this.rechazo();
    if (typeof exp === 'number' && ahora - HOLGURA_SEGUNDOS >= exp) {
      throw this.rechazo();
    }

    return claims;
  }

  /** La clave publica de Apple para ese `kid`, cacheada. */
  private async clave(kid: string): Promise<KeyObject | undefined> {
    const caducadas = Date.now() - this.cargadasEn > CLAVES_TTL_MS;
    // Un `kid` desconocido puede ser una rotacion de Apple: se recargan, pero no
    // mas de una vez por minuto, para que tokens basura no nos hagan ir a
    // Apple en bucle.
    const desconocida = !this.claves.has(kid) && Date.now() - this.cargadasEn > CLAVES_REINTENTO_MS;

    if (caducadas || desconocida) {
      try {
        const jwks = await this.fetchKeys();
        const nuevas = new Map<string, KeyObject>();
        for (const jwk of jwks) {
          if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
          nuevas.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        }
        this.claves = nuevas;
        this.cargadasEn = Date.now();
      } catch (error) {
        // Sin red hacia Apple se sigue con las claves que hubiera: un corte de
        // un minuto no puede tirar el login de todo el mundo.
        this.logger.error(`No se pudieron leer las claves publicas de Apple: ${String(error)}`);
      }
    }

    return this.claves.get(kid);
  }

  /** Las claves publicas de Apple. Aparte para poder sustituirlo en los tests. */
  protected async fetchKeys(): Promise<(JsonWebKey & { kid?: string })[]> {
    const res = await fetch(AppleVerifier.KEYS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cuerpo = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    return cuerpo.keys ?? [];
  }

  private exigirConfiguracion(): void {
    if (!this.enabled) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'El acceso con Apple no esta configurado en este entorno',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Un solo error para todo: distinguir "firma mala" de "caducado" o de "nonce
   * distinto" solo le sirve a quien esta probando tokens. El motivo va al log.
   */
  private rechazo(): AppException {
    return new AppException(
      ErrorCode.INVALID_CREDENTIALS,
      'No se pudo validar la cuenta de Apple',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

/** Apple manda algunos booleanos como texto (`"true"`). */
function verdadero(valor: unknown): boolean {
  return valor === true || valor === 'true';
}
