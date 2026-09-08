import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';

/** Lo unico que nos interesa del ID token de Google. */
export interface GoogleIdentity {
  email: string;
  name: string | null;
}

/**
 * Verifica el ID token que la app obtiene del SDK nativo de Google.
 *
 * El token es un JWT firmado por Google: la comprobacion es criptografica y no
 * requiere hablar con Google en cada login (la libreria cachea las claves
 * publicas). Lo que **si** es obligatorio es el `audience`: sin el, cualquier
 * ID token emitido para cualquier otra aplicacion del mundo valdria aqui, y
 * entrar como otro usuario seria tan facil como pedirle un token a Google desde
 * una app propia.
 */
@Injectable()
export class GoogleVerifier {
  private readonly logger = new Logger(GoogleVerifier.name);
  private readonly client = new OAuth2Client();

  constructor(private readonly config: AppConfigService) {}

  /** `false` cuando no hay credenciales configuradas: el endpoint da 503. */
  get enabled(): boolean {
    return this.config.get('GOOGLE_CLIENT_IDS').length > 0;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    const audience = this.config.get('GOOGLE_CLIENT_IDS');

    if (audience.length === 0) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'El acceso con Google no esta configurado en este entorno',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const payload = await this.client
      .verifyIdToken({ idToken, audience })
      .then((ticket) => ticket.getPayload())
      .catch((error: unknown) => {
        // El detalle va al log y no al cliente: distinguir "firma mala" de
        // "caducado" solo le sirve a quien esta probando tokens.
        this.logger.warn(`ID token de Google rechazado: ${String(error)}`);
        return undefined;
      });

    if (!payload?.email) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'No se pudo validar la cuenta de Google',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Sin esta comprobacion, un dominio de Workspace mal configurado puede
    // emitir una identidad con el email de otra persona, y como aqui el email
    // es lo que decide de quien es la cuenta, eso es apropiarse de ella.
    if (!payload.email_verified) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Google no ha verificado ese correo',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return { email: payload.email, name: payload.name ?? null };
  }
}
