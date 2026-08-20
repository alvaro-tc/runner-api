import { Injectable, Logger } from '@nestjs/common';

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
 * El driver actual escribe en consola. Enchufar FCM es escribir otra clase con
 * este mismo `send` y cambiar el provider en `NotificationsModule`: ni un
 * servicio de negocio se entera. Ver `docs/decisiones.md` para lo que hace
 * falta del lado de Firebase.
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
