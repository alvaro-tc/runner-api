import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { signEs256 } from './apple-jwt';

/** Vida del `client_secret`. Apple admite hasta seis meses; se firma uno por llamada. */
const SECRETO_TTL_SEGUNDOS = 5 * 60;

/**
 * La API REST de Sign in with Apple: canjear el codigo de autorizacion por un
 * refresh token y **revocarlo** cuando el usuario borra su cuenta.
 *
 * Lo segundo es un requisito de Apple, no una cortesia: "Apps that support
 * Sign in with Apple should use the Sign in with Apple REST API to revoke user
 * tokens" al borrar la cuenta. Y para revocar hace falta un token, que solo se
 * obtiene canjeando el codigo de un solo uso que la app recibe al iniciar
 * sesion. Por eso el canje ocurre en cada login con Apple.
 *
 * Necesita la clave privada de "Sign in with Apple" del equipo (el `.p8`), su
 * Key ID y el Team ID. Sin ellos el login funciona igual —el identity token se
 * verifica con las claves publicas— pero no hay nada que revocar al borrar.
 */
@Injectable()
export class AppleClient {
  static readonly TOKEN_URL = 'https://appleid.apple.com/auth/token';
  static readonly REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

  private readonly logger = new Logger(AppleClient.name);

  constructor(private readonly config: AppConfigService) {}

  /** Hay credenciales para hablar con la API REST de Apple. */
  get enabled(): boolean {
    return Boolean(
      this.config.get('APPLE_TEAM_ID') &&
      this.config.get('APPLE_KEY_ID') &&
      this.config.get('APPLE_PRIVATE_KEY'),
    );
  }

  /**
   * El `client_secret` de "Creating a client secret": un JWT ES256 firmado con
   * la clave del equipo, con `sub` igual al `client_id` con el que se llama.
   */
  clientSecret(clientId: string): string {
    const ahora = Math.floor(Date.now() / 1000);
    return signEs256(
      { kid: this.config.get('APPLE_KEY_ID') },
      {
        iss: this.config.get('APPLE_TEAM_ID'),
        iat: ahora,
        exp: ahora + SECRETO_TTL_SEGUNDOS,
        aud: 'https://appleid.apple.com',
        sub: clientId,
      },
      this.config.get('APPLE_PRIVATE_KEY') as string,
    );
  }

  /**
   * Canjea el codigo de autorizacion (valido cinco minutos y una sola vez) por
   * el refresh token del usuario. `null` si no se pudo: el login no se cae por
   * esto, pero se registra, porque sin token no habra nada que revocar.
   */
  async exchangeCode(code: string, clientId: string): Promise<string | null> {
    if (!this.enabled) {
      this.logger.warn(
        'Login con Apple sin APPLE_TEAM_ID/APPLE_KEY_ID/APPLE_PRIVATE_KEY: no se guarda ' +
          'refresh token y no se podra revocar al borrar la cuenta',
      );
      return null;
    }

    try {
      const res = await this.post(AppleClient.TOKEN_URL, {
        client_id: clientId,
        client_secret: this.clientSecret(clientId),
        code,
        grant_type: 'authorization_code',
      });
      const token = res.body['refresh_token'];
      if (res.status !== 200 || typeof token !== 'string' || token.length === 0) {
        this.logger.warn(
          `Apple no canjeo el codigo (HTTP ${res.status}: ${String(res.body['error'])})`,
        );
        return null;
      }
      return token;
    } catch (error) {
      this.logger.warn(`No se pudo canjear el codigo de Apple: ${String(error)}`);
      return null;
    }
  }

  /**
   * Revoca el refresh token: Apple da por terminada la relacion del usuario con
   * la app y lo quita de "Apps que usan tu Apple Account". Apple responde 200
   * tambien si el token ya no valia, asi que repetirlo no hace dano.
   */
  async revoke(refreshToken: string, clientId: string): Promise<boolean> {
    if (!this.enabled) {
      this.logger.warn('No se revoca el token de Apple: faltan las credenciales del equipo');
      return false;
    }

    try {
      const res = await this.post(AppleClient.REVOKE_URL, {
        client_id: clientId,
        client_secret: this.clientSecret(clientId),
        token: refreshToken,
        token_type_hint: 'refresh_token',
      });
      if (res.status !== 200) {
        this.logger.warn(
          `Apple no revoco el token (HTTP ${res.status}: ${String(res.body['error'])})`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(`No se pudo revocar el token de Apple: ${String(error)}`);
      return false;
    }
  }

  /** POST `x-www-form-urlencoded`, como pide Apple. Aparte para los tests. */
  protected async post(
    url: string,
    form: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(10_000),
    });
    const texto = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
    } catch {
      // Revoke responde 200 sin cuerpo; un cuerpo que no es JSON no es error.
    }
    return { status: res.status, body };
  }
}
