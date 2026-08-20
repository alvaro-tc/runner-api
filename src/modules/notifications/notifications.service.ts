import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PushSender } from './push.sender';

/**
 * Catalogo de eventos que la API puede notificar.
 *
 * Es una union discriminada y no un string suelto a proposito: agregar un
 * evento obliga a escribir su texto en `redactar()`, asi que no se puede
 * disparar una notificacion que llegue al telefono vacia.
 */
export type NotificationEvent = {
  type: 'shoe.wear_alert';
  shoeId: string;
  brand: string;
  model: string;
  distanceMeters: number;
};

/** Texto y carga util de cada evento. Todo en `data` viaja como string. */
function redactar(event: NotificationEvent): {
  title: string;
  body: string;
  data: Record<string, string>;
} {
  switch (event.type) {
    case 'shoe.wear_alert':
      return {
        title: 'Tus zapatillas pasaron el umbral',
        body:
          `${event.brand} ${event.model} acumula ${Math.round(event.distanceMeters / 1000)} km. ` +
          'Revisa el desgaste antes de la proxima salida larga.',
        data: { type: event.type, shoeId: event.shoeId },
      };
  }
}

/**
 * Punto unico de salida de notificaciones.
 *
 * Resuelve **a quien** se le entrega (preferencias del usuario + tokens de sus
 * dispositivos) y delega el **como** en `PushSender`. Esa division es la que
 * permite cambiar de consola a FCM sin volver a escribir la regla de "si el
 * usuario apago los push, no se le manda nada": esa regla no es del transporte.
 *
 * Nunca lanza. Una notificacion es un efecto secundario agradable: que falle no
 * puede tumbar el cierre de un entrenamiento que ya se guardo.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PushSender,
  ) {}

  async notify(userId: string, event: NotificationEvent): Promise<void> {
    try {
      const prefs = await this.prisma.userPreferences.findUnique({
        where: { userId },
        select: { notifications: true },
      });

      // Ausente es "si": el usuario que nunca toco el ajuste espera recibirlas.
      // Solo un `false` explicito calla.
      const banderas =
        typeof prefs?.notifications === 'object' && prefs.notifications !== null
          ? (prefs.notifications as Record<string, unknown>)
          : {};

      if (banderas['push'] === false) return;

      const dispositivos = await this.prisma.device.findMany({
        where: { userId, pushToken: { not: null } },
        select: { pushToken: true },
      });

      await this.sender.send({
        tokens: dispositivos.map((d) => d.pushToken).filter((t): t is string => t !== null),
        ...redactar(event),
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo notificar ${event.type} a ${userId}: ${(error as Error).message}`,
      );
    }
  }
}
