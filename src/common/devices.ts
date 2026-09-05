import { Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';

const logger = new Logger('Dispositivos');

/**
 * Deja al dia la fila del dispositivo (`Device`) de esta app instalada.
 *
 * **Es la unica forma de saber quien manda un punto por OsmAnd.** Ese protocolo
 * no tiene donde meter un token: el tracker solo sabe decir su `uniqueId`, y
 * `Device` es la tabla que lo traduce a una persona. Sin fila no hay traduccion
 * posible, asi que el punto se rechaza con `SESSION_NOT_ACTIVE`.
 *
 * Por eso se llama tambien **al iniciar sesion** y no solo al arrancar una
 * grabacion: quien se instala la app para su primera maraton nunca grabo un
 * entrenamiento, y hasta que hiciera uno su posicion en la salida no se podia
 * resolver — el organizador veia el corral vacio justo el dia que importa.
 *
 * El dueño se **reescribe** en cada llamada. Un `uniqueId` es un telefono, no
 * una cuenta: en el movil de pruebas donde se turnan varias, y en el prestado,
 * la fila se quedaba con el primero que lo uso y las posiciones del segundo
 * acababan resueltas contra la carrera del primero.
 *
 * No lanza: esto acompaña a un login o a un arranque de sesion, y ninguno de
 * los dos puede caerse porque la fila de un dispositivo no se pudo tocar.
 */
export async function registrarDispositivo(
  prisma: PrismaService,
  userId: string,
  uniqueId: string | null | undefined,
): Promise<{ id: string } | null> {
  if (!uniqueId || uniqueId === DISPOSITIVO_DESCONOCIDO) return null;

  try {
    return await prisma.device.upsert({
      where: { uniqueId },
      create: { userId, uniqueId },
      update: { userId, lastSeenAt: new Date() },
      select: { id: true },
    });
  } catch (error) {
    logger.warn({ err: error, uniqueId }, 'No se pudo registrar el dispositivo');
    return null;
  }
}

/** Lo que se guarda cuando el cliente no manda `deviceId`. No es un telefono. */
export const DISPOSITIVO_DESCONOCIDO = 'desconocido';
