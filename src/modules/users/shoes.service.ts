import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { camposPresentes } from '../../common/utils/patch';
import type { Prisma } from '../../../generated/prisma/client';
import type { CreateShoeDto, UpdateShoeDto } from './dto/shoe.dto';

/** Lo que devuelve `sumarDistancia`: la zapatilla ya actualizada + el cruce. */
export type DistanciaSumada = ReturnType<typeof toDto> & { justCrossedWearAlert: boolean };

interface ZapatillaCruda {
  id: string;
  brand: string;
  model: string;
  distanceMeters: number;
  alertThresholdMeters: number;
  isPrimary: boolean;
  retiredAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class ShoesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Las retiradas se ocultan por defecto: el listado es "con que corro hoy". */
  async list(userId: string, includeRetired = false) {
    const zapatillas = await this.prisma.shoe.findMany({
      where: { userId, ...(includeRetired ? {} : { retiredAt: null }) },
      orderBy: [{ isPrimary: 'desc' }, { retiredAt: 'asc' }, { createdAt: 'desc' }],
    });

    return zapatillas.map(toDto);
  }

  /**
   * La primera zapatilla se marca principal sola.
   *
   * Sin esto, el usuario registra su unico par y el acumulador de kilometros
   * (que suma a la principal al consolidar un workout) no tiene a quien sumar.
   * Ese silencio es peor que decidir por el.
   */
  async create(userId: string, dto: CreateShoeDto) {
    const enUso = await this.prisma.shoe.count({ where: { userId, retiredAt: null } });
    const principal = dto.isPrimary ?? enUso === 0;

    const zapatilla = await this.prisma.$transaction(async (tx) => {
      if (principal) await desmarcarPrincipales(tx, userId);

      return tx.shoe.create({
        data: {
          userId,
          brand: dto.brand,
          model: dto.model,
          distanceMeters: dto.distanceMeters ?? 0,
          ...(dto.alertThresholdMeters === undefined
            ? {}
            : { alertThresholdMeters: dto.alertThresholdMeters }),
          isPrimary: principal,
        },
      });
    });

    return toDto(zapatilla);
  }

  async update(userId: string, shoeId: string, dto: UpdateShoeDto) {
    const actual = await this.buscarPropia(userId, shoeId);

    const data: Prisma.ShoeUpdateInput = camposPresentes(dto, [
      'brand',
      'model',
      'distanceMeters',
      'alertThresholdMeters',
    ]);

    const retirando = dto.retired === true;
    if (dto.retired !== undefined) {
      data.retiredAt = dto.retired ? (actual.retiredAt ?? new Date()) : null;
    }

    // Una zapatilla retirada no puede seguir siendo la principal: seguiria
    // acumulando los kilometros de un par que ya esta en el armario. Retirar
    // manda sobre `isPrimary` si llegan los dos en la misma peticion.
    if (retirando) data.isPrimary = false;
    else if (dto.isPrimary !== undefined) data.isPrimary = dto.isPrimary;

    const quiereSerPrincipal = dto.isPrimary === true && !retirando;

    const zapatilla = await this.prisma.$transaction(async (tx) => {
      if (quiereSerPrincipal) {
        await desmarcarPrincipales(tx, userId, shoeId);
        // Volver a poner en uso una retirada al marcarla principal: pedir las
        // dos cosas por separado seria un paso de mas sin ninguna ganancia.
        if (actual.retiredAt && dto.retired === undefined) data.retiredAt = null;
      }

      return tx.shoe.update({ where: { id: shoeId }, data });
    });

    return toDto(zapatilla);
  }

  /**
   * Borrado real, no logico.
   *
   * Los kilometros de una zapatilla son un contador, no historial: el workout
   * guarda su propia distancia y no depende de esta fila. Nada se pierde.
   */
  async remove(userId: string, shoeId: string): Promise<{ ok: true }> {
    const zapatilla = await this.buscarPropia(userId, shoeId);
    await this.prisma.shoe.delete({ where: { id: zapatilla.id } });

    return { ok: true };
  }

  /**
   * Suma la distancia de un entrenamiento a la zapatilla principal.
   *
   * Se llama al consolidar un workout y **dentro de su transaccion**: si la
   * consolidacion se cae, los kilometros no se quedan sumados a un
   * entrenamiento que no llego a existir.
   *
   * Sin zapatilla principal devuelve `null` y no pasa nada. No es un error:
   * mucha gente no registra sus zapatillas nunca, y tumbar la consolidacion por
   * un dato opcional seria perder el entrenamiento entero.
   */
  async sumarDistancia(
    tx: Prisma.TransactionClient,
    userId: string,
    distanceMeters: number,
  ): Promise<DistanciaSumada | null> {
    if (distanceMeters <= 0) return null;

    const principal = await tx.shoe.findFirst({
      where: { userId, isPrimary: true, retiredAt: null },
    });
    if (!principal) return null;

    const actualizada = await tx.shoe.update({
      where: { id: principal.id },
      data: { distanceMeters: { increment: distanceMeters } },
    });

    const dto = toDto(actualizada);

    return {
      ...dto,
      // El aviso sale solo al CRUZAR el umbral, no cada vez que `wearAlert` sea
      // true: pasado el umbral lo seria en todos los entrenamientos siguientes,
      // y una notificacion por salida es lo que hace que el usuario apague los
      // push para siempre.
      justCrossedWearAlert:
        dto.wearAlert &&
        actualizada.alertThresholdMeters > 0 &&
        principal.distanceMeters < actualizada.alertThresholdMeters,
    };
  }

  /**
   * Filtrar por `userId` ES la autorizacion. Buscar por id y comparar despues
   * deja escapar un 404 distinto para "existe pero no es tuya", que es un
   * enumerador de ids ajenos.
   */
  private async buscarPropia(userId: string, shoeId: string): Promise<ZapatillaCruda> {
    const zapatilla = await this.prisma.shoe.findFirst({ where: { id: shoeId, userId } });

    if (!zapatilla) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Zapatilla no encontrada', HttpStatus.NOT_FOUND);
    }

    return zapatilla;
  }
}

/** Solo hay una principal a la vez. Se ejecuta dentro de la transaccion. */
function desmarcarPrincipales(
  tx: Prisma.TransactionClient,
  userId: string,
  excepto?: string,
): Promise<unknown> {
  return tx.shoe.updateMany({
    where: { userId, isPrimary: true, ...(excepto ? { id: { not: excepto } } : {}) },
    data: { isPrimary: false },
  });
}

/** El desgaste se calcula al leer: es una division, no vale la pena guardarla. */
export function toDto(zapatilla: ZapatillaCruda) {
  const ratio =
    zapatilla.alertThresholdMeters > 0
      ? zapatilla.distanceMeters / zapatilla.alertThresholdMeters
      : 0;

  return {
    id: zapatilla.id,
    brand: zapatilla.brand,
    model: zapatilla.model,
    distanceMeters: zapatilla.distanceMeters,
    alertThresholdMeters: zapatilla.alertThresholdMeters,
    isPrimary: zapatilla.isPrimary,
    retiredAt: zapatilla.retiredAt?.toISOString() ?? null,
    wearRatio: Math.round(ratio * 100) / 100,
    wearAlert: zapatilla.distanceMeters >= zapatilla.alertThresholdMeters,
    createdAt: zapatilla.createdAt.toISOString(),
  };
}
