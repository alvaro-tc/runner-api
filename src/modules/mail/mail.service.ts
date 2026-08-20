import { Injectable, Logger } from '@nestjs/common';

export interface Mail {
  to: string;
  subject: string;
  /// Cuerpo en texto plano. Sin HTML por ahora: no hay plantillas que mantener.
  body: string;
}

/**
 * Envio de correo detras de una interfaz.
 *
 * El driver actual escribe en consola. Enchufar SMTP (nodemailer) o un servicio
 * externo (Resend, Brevo) es escribir otra clase con este mismo `send` y
 * cambiar el provider en `MailModule`: ningun servicio de negocio se entera.
 */
export abstract class MailService {
  abstract send(mail: Mail): Promise<void>;
}

/**
 * Driver de desarrollo: deja el correo en los logs.
 *
 * En el caso de recuperacion de contrasena, el enlace aparece en la consola del
 * servidor. Es suficiente para desarrollar y probar el flujo completo sin
 * depender de un proveedor.
 */
@Injectable()
export class ConsoleMailService extends MailService {
  private readonly logger = new Logger(ConsoleMailService.name);

  send(mail: Mail): Promise<void> {
    this.logger.log(
      `\n────────── CORREO (driver console) ──────────\n` +
        `Para:    ${mail.to}\n` +
        `Asunto:  ${mail.subject}\n\n` +
        `${mail.body}\n` +
        `─────────────────────────────────────────────`,
    );
    return Promise.resolve();
  }
}
