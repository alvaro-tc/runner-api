import { Injectable, Logger } from '@nestjs/common';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { PrismaService } from '../../database/prisma.service';

/** Un push ya resuelto: destinatarios concretos y texto listo para mostrar. */
export interface PushMessage {
  /** Tokens de los dispositivos del usuario. Vacio = no hay donde entregar. */
  tokens: string[];
  title: string;
  body: string;
  /**
   * Carga util que la app lee para navegar al abrir la notificacion. Siempre
   * strings: FCM no acepta otra cosa en `data`, y descubrirlo en produccion
   * seria una migracion de formato con la app ya publicada.
   */
  data: Record<string, string>;
}

/**
 * Envio de push detras de una interfaz.
 *
 * `FcmPushSender` si hay `FIREBASE_CREDENTIALS`; si no, `ConsolePushSender`.
 * Lo decide `NotificationsModule`: ni un servicio de negocio se entera.
 */
export abstract class PushSender {
  abstract send(message: PushMessage): Promise<void>;
}

/** Driver de desarrollo: deja el push en los logs. */
@Injectable()
export class ConsolePushSender extends PushSender {
  private readonly logger = new Logger(ConsolePushSender.name);

  send(message: PushMessage): Promise<void> {
    this.logger.log(
      `\n────────── PUSH (driver console) ──────────\n` +
        `Tokens:  ${message.tokens.length === 0 ? '(ninguno)' : message.tokens.join(', ')}\n` +
        `Titulo:  ${message.title}\n` +
        `Cuerpo:  ${message.body}\n` +
        `Data:    ${JSON.stringify(message.data)}\n` +
        `───────────────────────────────────────────`,
    );
    return Promise.resolve();
  }
}

/**
 * Driver real: Firebase Cloud Messaging. Con la app cerrada, Android pinta el
 * bloque `notification` por su cuenta, sin despertar al codigo de Flutter.
 *
 * Los tokens que FCM da por muertos (app desinstalada, sesion cerrada) se
 * borran del `Device`: si no, cada aviso seguiria intentando entregarles.
 */
@Injectable()
export class FcmPushSender extends PushSender {
  private readonly logger = new Logger(FcmPushSender.name);
  private readonly messaging: Messaging;

  constructor(
    credentialsPath: string,
    private readonly prisma: PrismaService,
  ) {
    super();
    const app = initializeApp({ credential: cert(credentialsPath) });
    this.messaging = getMessaging(app);
  }

  async send(message: PushMessage): Promise<void> {
    if (message.tokens.length === 0) return;

    const res = await this.messaging.sendEachForMulticast({
      tokens: message.tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
      // `high`: con la normal, Doze retrasa el aviso hasta la siguiente ventana
      // de mantenimiento y el "pago validado" llega media hora tarde.
      android: { priority: 'high', notification: { channelId: PUSH_CHANNEL_ID } },
    });

    const muertos = res.responses
      .map((r, i) => (TOKEN_MUERTO.has(r.error?.code ?? '') ? message.tokens[i] : null))
      .filter((t): t is string => t !== null);
    if (muertos.length > 0) {
      await this.prisma.device.updateMany({
        where: { pushToken: { in: muertos } },
        data: { pushToken: null },
      });
    }
    if (res.failureCount > muertos.length) {
      this.logger.warn(`FCM: ${res.failureCount - muertos.length} envios fallaron`);
    }
  }
}

/** El canal que crea la app. Si no existe, Android usa uno generico. */
const PUSH_CHANNEL_ID = 'avisos';

const TOKEN_MUERTO = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
