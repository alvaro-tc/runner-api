import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MarathonsService } from '../marathons/marathons.service';
import { ServiceFeeConfigService } from './service-fee.service';
import { calcularServiceFee, type SnapshotDeFee } from './service-fee';

/** Lo que hay que saber para cotizar. Sale de la inscripcion o del cliente. */
export interface EntradaCotizacion {
  marathonId: string;
  categoryId?: string | null;
  extras?: { extraId: string; quantity: number }[];
}

export type TipoDeLinea = 'base' | 'category' | 'extra';

export interface LineaCotizacion {
  type: TipoDeLinea;
  /** Id de la categoria o del extra. Null en la cuota base. */
  refId: string | null;
  label: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface Cotizacion {
  marathonId: string;
  currency: string;
  items: LineaCotizacion[];
  subtotalCents: number;
  /** `null` = no hay cargo y **la UI no debe pintar la linea**. */
  serviceFee: { label: string; amountCents: number } | null;
  totalCents: number;
  /** Para persistir al confirmar. No viaja al cliente. */
  serviceFeeSnapshot: SnapshotDeFee | null;
}

/** Tope por extra. Nadie compra 300 remeras, y sin tope el total desborda. */
export const MAX_CANTIDAD_POR_EXTRA = 10;

/**
 * La **unica** fuente del total.
 *
 * El precio no se calcula en el movil, ni en el controlador, ni dos veces. El
 * cliente pinta lo que dice `/quote` y al confirmar el backend vuelve a
 * cotizar: si el organizador cambio un precio mientras el usuario dudaba, se
 * cobra el precio real y no el que quedo en la pantalla. Un total que se arma
 * en el cliente es un total negociable.
 */
@Injectable()
export class QuoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marathons: MarathonsService,
    private readonly fees: ServiceFeeConfigService,
  ) {}

  /**
   * Cotiza sin tocar nada: no reserva cupo ni stock.
   *
   * Se puede cotizar una carrera cerrada o llena a proposito: es informacion, y
   * quien decide si se puede comprar es el checkout (Fase 7). Mezclar las dos
   * cosas obligaria a la pantalla de detalle a manejar errores de compra solo
   * para mostrar un precio.
   */
  async cotizar(entrada: EntradaCotizacion): Promise<Cotizacion> {
    const maraton = await this.marathons.buscarVisibleOFallar(entrada.marathonId);

    const items: LineaCotizacion[] = [
      {
        type: 'base',
        refId: null,
        label: 'Inscripcion',
        quantity: 1,
        unitPriceCents: maraton.priceCents,
        amountCents: maraton.priceCents,
      },
    ];

    if (entrada.categoryId) {
      items.push(await this.lineaDeCategoria(maraton.id, entrada.categoryId));
    }

    items.push(...(await this.lineasDeExtras(maraton.id, entrada.extras ?? [])));

    const subtotalCents = items.reduce((suma, linea) => suma + linea.amountCents, 0);

    const config = await this.fees.resolverPara(maraton.id);
    const fee = calcularServiceFee(config, subtotalCents);

    return {
      marathonId: maraton.id,
      currency: maraton.currency,
      items,
      subtotalCents,
      serviceFee: fee ? { label: fee.label, amountCents: fee.amountCents } : null,
      totalCents: subtotalCents + (fee?.amountCents ?? 0),
      serviceFeeSnapshot: fee?.snapshot ?? null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * La categoria se busca **acotada a la maraton**, no por id suelto. Sin el
   * `marathonId` en el where, un id de otra carrera colaria su recargo aqui.
   */
  private async lineaDeCategoria(marathonId: string, categoryId: string): Promise<LineaCotizacion> {
    const categoria = await this.prisma.marathonCategory.findFirst({
      where: { id: categoryId, marathonId },
    });

    if (!categoria) {
      throw new AppException(
        ErrorCode.INVALID_CATEGORY,
        'Esa categoria no pertenece a esta maraton',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      type: 'category',
      refId: categoria.id,
      label: categoria.name,
      quantity: 1,
      unitPriceCents: categoria.extraPriceCents,
      amountCents: categoria.extraPriceCents,
    };
  }

  private async lineasDeExtras(
    marathonId: string,
    pedidos: { extraId: string; quantity: number }[],
  ): Promise<LineaCotizacion[]> {
    if (pedidos.length === 0) return [];

    // Se agrupan por id antes de mirar el stock: mandar el mismo extra dos
    // veces con cantidad 1 tiene que valer lo mismo, y chocar contra el mismo
    // limite, que mandarlo una vez con cantidad 2.
    const cantidades = new Map<string, number>();
    for (const pedido of pedidos) {
      cantidades.set(pedido.extraId, (cantidades.get(pedido.extraId) ?? 0) + pedido.quantity);
    }

    const extras = await this.prisma.marathonExtra.findMany({
      where: { id: { in: [...cantidades.keys()] }, marathonId },
    });

    const porId = new Map(extras.map((e) => [e.id, e]));

    return [...cantidades].map(([extraId, quantity]) => {
      const extra = porId.get(extraId);

      if (!extra) {
        throw new AppException(
          ErrorCode.INVALID_EXTRA,
          'Ese adicional no pertenece a esta maraton',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (quantity > MAX_CANTIDAD_POR_EXTRA) {
        throw new AppException(
          ErrorCode.INVALID_EXTRA,
          `No se pueden pedir mas de ${MAX_CANTIDAD_POR_EXTRA} unidades de "${extra.name}"`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // `stock: null` es sin limite. Y esto NO reserva: entre cotizar y pagar,
      // el stock puede agotarse. La reserva ocurre en la transaccion del
      // checkout (Fase 7); aca solo se evita cotizar lo imposible.
      if (extra.stock !== null && quantity > extra.stock) {
        throw new AppException(
          ErrorCode.EXTRA_OUT_OF_STOCK,
          extra.stock === 0
            ? `"${extra.name}" esta agotado`
            : `Solo quedan ${extra.stock} unidades de "${extra.name}"`,
          HttpStatus.CONFLICT,
        );
      }

      return {
        type: 'extra' as const,
        refId: extra.id,
        label: extra.name,
        quantity,
        unitPriceCents: extra.priceCents,
        amountCents: extra.priceCents * quantity,
      };
    });
  }
}
