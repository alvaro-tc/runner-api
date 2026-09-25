import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { UserRole } from '../../../generated/prisma/enums';
import type { Notification } from '../../../generated/prisma/client';
import { LiveService } from '../realtime/live.service';
import { PushSender } from './push.sender';

/**
 * Catalogo de eventos que la API puede notificar.
 *
 * Es una union discriminada y no un string suelto a proposito: agregar un
 * evento obliga a escribir su texto en `redactar()`, asi que no se puede
 * disparar una notificacion que llegue al telefono vacia.
 */
export type NotificationEvent =
  | {
      type: 'shoe.wear_alert';
      shoeId: string;
      brand: string;
      model: string;
      distanceMeters: number;
    }
  | {
      /** A los organizadores: un corredor subio un comprobante que revisar. */
      type: 'payment.proof_submitted';
      proofId: string;
      paymentId: string;
      registrationId: string;
      marathonId: string;
      marathonName: string;
      runnerName: string;
      amountCents: number;
      currency: string;
    }
  | {
      /** Al corredor: un organizador dio su pago por bueno. */
      type: 'payment.approved';
      paymentId: string;
      registrationId: string;
      marathonId: string;
      marathonName: string;
      bibNumber: string | null;
    }
  | {
      /** Al corredor: rechazaron su comprobante. El cobro sigue abierto. */
      type: 'payment.rejected';
      paymentId: string;
      registrationId: string;
      marathonId: string;
      marathonName: string;
      reason: string;
    };

/** Lo que ve la app de una notificacion de su bandeja. */
export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, string>;
  readAt: string | null;
  createdAt: string;
}

function monto(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

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
    case 'payment.proof_submitted':
      return {
        title: 'Nuevo pago por validar',
        body:
          `${event.runnerName} envio su comprobante de ` +
          `${monto(event.amountCents, event.currency)} para ${event.marathonName}.`,
        data: {
          type: event.type,
          proofId: event.proofId,
          paymentId: event.paymentId,
          registrationId: event.registrationId,
          marathonId: event.marathonId,
          // Para que la app redacte el texto en el idioma del usuario.
          marathonName: event.marathonName,
          runnerName: event.runnerName,
          amountCents: String(event.amountCents),
          currency: event.currency,
        },
      };
    case 'payment.approved':
      return {
        title: 'Pago validado',
        body:
          `Un organizador confirmo tu pago para ${event.marathonName}.` +
          (event.bibNumber ? ` Tu dorsal es el ${event.bibNumber}.` : ' Ya estas inscrito.'),
        data: {
          type: event.type,
          paymentId: event.paymentId,
          registrationId: event.registrationId,
          marathonId: event.marathonId,
          marathonName: event.marathonName,
          ...(event.bibNumber ? { bibNumber: event.bibNumber } : {}),
        },
      };
    case 'payment.rejected':
      return {
        title: 'Comprobante rechazado',
        body:
          `Un organizador rechazo tu comprobante para ${event.marathonName}: ${event.reason}. ` +
          'Sube uno nuevo para completar tu inscripcion.',
        data: {
          type: event.type,
          paymentId: event.paymentId,
          registrationId: event.registrationId,
          marathonId: event.marathonId,
          marathonName: event.marathonName,
          reason: event.reason,
        },
      };
  }
}

/**
 * Punto unico de salida de notificaciones.
 *
 * Guarda el aviso en la bandeja del usuario —es lo que cuenta la campana de la
 * app—, lo empuja por su sala del socket y resuelve el push: preferencias del
 * usuario + tokens de sus dispositivos, delegando el **como** en `PushSender`.
 * Esa division es la que permite cambiar de consola a FCM sin volver a escribir
 * la regla de "si el usuario apago los push, no se le manda nada": esa regla no
 * es del transporte.
 *
 * Nunca lanza. Una notificacion es un efecto secundario agradable: que falle no
 * puede tumbar el cierre de un entrenamiento o la validacion de un pago.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PushSender,
    private readonly live: LiveService,
  ) {}

  async notify(userId: string, event: NotificationEvent): Promise<void> {
    try {
      const mensaje = redactar(event);

      // La bandeja no mira las preferencias: apagar los push calla el
      // telefono, no borra el historial.
      const fila = await this.prisma.notification.create({
        data: { userId, type: event.type, ...mensaje },
      });
      this.live.anunciarNotificacion(userId, this.toDto(fila));

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
        ...mensaje,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo notificar ${event.type} a ${userId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * A todo el equipo que valida pagos. No hay organizador por maraton —el rol
   * las ve todas—, asi que el aviso va a todos los que pueden atenderlo.
   */
  async notifyStaff(event: NotificationEvent): Promise<void> {
    try {
      const equipo = await this.prisma.user.findMany({
        where: { role: { in: [UserRole.admin, UserRole.organizer] }, deletedAt: null },
        select: { id: true },
      });
      await Promise.all(equipo.map((u) => this.notify(u.id, event)));
    } catch (error) {
      this.logger.warn(`No se pudo avisar al equipo de ${event.type}: ${(error as Error).message}`);
    }
  }

  // ─── Bandeja ─────────────────────────────────────────────────────────────

  // ponytail: las 50 ultimas, sin paginar. Paginar cuando alguien eche en falta las viejas.
  async list(userId: string): Promise<{ items: NotificationDto[]; unreadCount: number }> {
    const [filas, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items: filas.map((f) => this.toDto(f)), unreadCount };
  }

  /** Filtra por dueño: un id ajeno simplemente no casa con nada. */
  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /**
   * El token se cuelga del `Device` de esta instalacion, y el dueño se
   * reescribe como en `registrarDispositivo`: en un telefono que se turnan dos
   * cuentas, los avisos son del que inicio sesion el ultimo. Otra fila con el
   * mismo token (reinstalacion con `deviceId` nuevo) lo suelta, o ese telefono
   * recibiria cada aviso dos veces.
   */
  async setPushToken(userId: string, uniqueId: string, token: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.device.updateMany({
        where: { pushToken: token, uniqueId: { not: uniqueId } },
        data: { pushToken: null },
      }),
      this.prisma.device.upsert({
        where: { uniqueId },
        create: { userId, uniqueId, pushToken: token },
        update: { userId, pushToken: token, lastSeenAt: new Date() },
      }),
    ]);
  }

  private toDto(fila: Notification): NotificationDto {
    return {
      id: fila.id,
      type: fila.type,
      title: fila.title,
      body: fila.body,
      data: fila.data as Record<string, string>,
      readAt: fila.readAt?.toISOString() ?? null,
      createdAt: fila.createdAt.toISOString(),
    };
  }
}
