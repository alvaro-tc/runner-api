import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/dto/response-envelope';
import { armarPagina, decodeCursor, despuesDe, encodeCursor } from '../../common/pagination/cursor';
import type { Prisma } from '../../../generated/prisma/client';
import { cuposDisponibles, resolverEstado } from './registration-status';
import { LIMITE_POR_DEFECTO, type ListMarathonsQueryDto } from './dto/marathon.dto';
import { StorageService } from '../storage/storage.service';

/**
 * Cuantas filas se piden por vuelta cuando hay filtro de estado, y cuantas
 * vueltas como maximo. Ver `listar()` para por que existe el bucle.
 */
const MAX_VUELTAS = 4;
const TAMANO_LOTE_MAXIMO = 100;

/** Campos del resumen. El detalle agrega el resto. */
const CAMPOS_RESUMEN = {
  id: true,
  slug: true,
  name: true,
  startsAt: true,
  timezone: true,
  city: true,
  country: true,
  distanceMeters: true,
  priceCents: true,
  currency: true,
  coverUrl: true,
  paymentQrUrl: true,
  paymentQrInstructions: true,
  registrationStatus: true,
  capacity: true,
  slotsTaken: true,
  registrationClosesAt: true,
  liveStartedAt: true,
  liveFinishedAt: true,
} as const;

type FilaResumen = Prisma.MarathonGetPayload<{ select: typeof CAMPOS_RESUMEN }>;

@Injectable()
export class MarathonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Catalogo paginado por cursor, ordenado por fecha de largada.
   *
   * El filtro por `status` se aplica en memoria y no en SQL porque el estado se
   * **deriva** (ver `registration-status.ts`) y una de sus reglas —"queda menos
   * del 10% del cupo"— es aritmetica entre dos columnas, que Prisma no sabe
   * expresar en un `where`. Las salidas eran escribir la regla otra vez en SQL
   * crudo (dos copias que se desincronizan en el primer cambio) o esto: pedir
   * lotes y quedarse con los que pasan.
   *
   * La consecuencia esta documentada en `docs/api.md`: con filtro de estado,
   * una pagina puede venir corta —o vacia— y aun asi traer `nextCursor`. El
   * cliente pagina hasta que `nextCursor` sea `null`, no hasta que una pagina
   * venga vacia. Sin filtro (el caso normal) es una sola consulta.
   */
  async listar(
    query: ListMarathonsQueryDto,
  ): Promise<Paginated<ReturnType<typeof this.toResumen>>> {
    const limit = query.limit ?? LIMITE_POR_DEFECTO;
    const ahora = new Date();
    const where = this.filtros(query, ahora);
    const tamanoLote = query.status
      ? Math.min(limit * 3, TAMANO_LOTE_MAXIMO)
      : // Sin filtro basta una fila extra para saber si hay pagina siguiente.
        limit + 1;

    const aceptadas: FilaResumen[] = [];
    let cursor = decodeCursor(query.cursor);
    let quedanFilas = true;
    let vueltas = 0;

    while (aceptadas.length <= limit && quedanFilas && vueltas < MAX_VUELTAS) {
      const lote = await this.prisma.marathon.findMany({
        where: cursor
          ? { AND: [where, { OR: despuesDe('startsAt', new Date(cursor.v), cursor.id) }] }
          : where,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: tamanoLote,
        select: CAMPOS_RESUMEN,
      });

      quedanFilas = lote.length === tamanoLote;
      const ultima = lote.at(-1);
      if (ultima) cursor = { v: ultima.startsAt.toISOString(), id: ultima.id };

      for (const maraton of lote) {
        if (!query.status || resolverEstado(maraton, ahora) === query.status) {
          aceptadas.push(maraton);
        }
      }

      vueltas++;
    }

    const pagina = armarPagina(aceptadas, limit, (m) => ({
      v: m.startsAt.toISOString(),
      id: m.id,
    }));

    // Se corto el barrido con filas sin mirar: hay que decirle al cliente por
    // donde seguir, o creeria que el catalogo se acabo.
    const nextCursor = pagina.nextCursor ?? (quedanFilas && cursor ? encodeCursor(cursor) : null);

    return new Paginated(
      pagina.items.map((m) => this.toResumen(m, ahora)),
      nextCursor,
    );
  }

  /** Las proximas N carreras publicadas, para el carrusel del home. */
  async proximas(limit: number) {
    const ahora = new Date();

    const maratones = await this.prisma.marathon.findMany({
      where: { ...this.visibles(ahora), startsAt: { gte: ahora } },
      orderBy: { startsAt: 'asc' },
      take: limit,
      select: CAMPOS_RESUMEN,
    });

    return maratones.map((m) => this.toResumen(m, ahora));
  }

  /**
   * Una sola maraton con el contrato del catalogo.
   *
   * Existe para el home, que ya sabe **cual** quiere destacar y solo necesita
   * sus campos de resumen. Tirar de `detalle()` traeria recorrido, cronograma y
   * datos del kit para pintar una tarjeta.
   */
  async resumen(id: string) {
    const ahora = new Date();

    const maraton = await this.prisma.marathon.findFirst({
      where: { ...this.visibles(ahora), id },
      select: CAMPOS_RESUMEN,
    });

    return maraton ? this.toResumen(maraton, ahora) : null;
  }

  async detalle(slugOId: string) {
    const ahora = new Date();

    const maraton = await this.prisma.marathon.findFirst({
      where: { ...this.visibles(ahora), OR: [{ slug: slugOId }, { id: slugOId }] },
      include: {
        categories: { orderBy: { extraPriceCents: 'asc' } },
        extras: { orderBy: { priceCents: 'asc' } },
      },
    });

    if (!maraton) throw this.noExiste();

    return {
      ...this.toResumen(maraton, ahora),
      description: maraton.description,
      lat: maraton.lat,
      lng: maraton.lng,
      routeGeoJson: maraton.routeGeoJson,
      schedule: maraton.schedule,
      includes: maraton.includes,
      kitPickup: maraton.kitPickup,
      categories: maraton.categories.map(toCategoria),
      extras: maraton.extras.map(toExtra),
    };
  }

  async categorias(slugOId: string) {
    const maraton = await this.buscarVisible(slugOId, {
      categories: { orderBy: { extraPriceCents: 'asc' } },
    });

    return maraton.categories.map(toCategoria);
  }

  async extras(slugOId: string) {
    const maraton = await this.buscarVisible(slugOId, {
      extras: { orderBy: { priceCents: 'asc' } },
    });

    return maraton.extras.map(toExtra);
  }

  /**
   * Busca una maraton visible por slug o por id, para uso interno de otros
   * modulos (inscripciones en la Fase 7). Lanza 404 si no la puede mostrar.
   */
  async buscarVisibleOFallar(slugOId: string) {
    return this.buscarVisible(slugOId, {});
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async buscarVisible<I extends Prisma.MarathonInclude>(slugOId: string, include: I) {
    const ahora = new Date();

    const maraton = await this.prisma.marathon.findFirst({
      where: { ...this.visibles(ahora), OR: [{ slug: slugOId }, { id: slugOId }] },
      include,
    });

    if (!maraton) throw this.noExiste();
    return maraton;
  }

  /**
   * Solo lo publicado se ve.
   *
   * `publishedAt` en el futuro es un embargo: el organizador deja la maraton
   * cargada y la API la empieza a mostrar sola a la hora acordada, sin que
   * nadie tenga que estar despierto para apretar un boton.
   */
  private visibles(ahora: Date): Prisma.MarathonWhereInput {
    return { publishedAt: { not: null, lte: ahora } };
  }

  private filtros(query: ListMarathonsQueryDto, ahora: Date): Prisma.MarathonWhereInput {
    const where: Prisma.MarathonWhereInput = this.visibles(ahora);

    if (query.city) {
      // `insensitive` cubre mayusculas; los acentos no, y "Potosi" vs "Potosí"
      // seguiria fallando. Se resuelve con `unaccent` en la Fase 15, cuando el
      // panel cargue nombres reales y se sepa que hace falta de verdad.
      where.city = { contains: query.city, mode: 'insensitive' };
    }

    if (query.from || query.to) {
      where.startsAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    return where;
  }

  private toResumen(maraton: FilaResumen, ahora: Date) {
    return {
      id: maraton.id,
      slug: maraton.slug,
      name: maraton.name,
      startsAt: maraton.startsAt.toISOString(),
      timezone: maraton.timezone,
      city: maraton.city,
      country: maraton.country,
      distanceMeters: maraton.distanceMeters,
      priceCents: maraton.priceCents,
      currency: maraton.currency,
      // El afiche es lo que la app pinta en Home; sale siempre como URL
      // cargable, venga de storage o del sitio del organizador.
      coverUrl: this.storage.publicUrl(maraton.coverUrl),
      // TEMPORAL — cobro por QR manual. La app decide con esto si ofrece el
      // metodo: sin QR cargado, ofrecerlo seria prometer un pago imposible.
      paymentQrUrl: this.storage.publicUrl(maraton.paymentQrUrl),
      paymentQrInstructions: maraton.paymentQrInstructions,
      // El campo homonimo de la BD es solo la intencion del admin; lo que sale
      // por la API es el estado resuelto.
      registrationStatus: resolverEstado(maraton, ahora),
      capacity: maraton.capacity,
      slotsTaken: maraton.slotsTaken,
      slotsAvailable: cuposDisponibles(maraton),
      registrationClosesAt: maraton.registrationClosesAt?.toISOString() ?? null,
      // La largada de verdad, la que dio el admin. Es lo que mira el movil del
      // inscrito para saber si tiene que estar corriendo ahora mismo; `startsAt`
      // es lo programado y casi nunca coincide.
      liveStartedAt: maraton.liveStartedAt?.toISOString() ?? null,
      liveFinishedAt: maraton.liveFinishedAt?.toISOString() ?? null,
    };
  }

  private noExiste(): AppException {
    return new AppException(
      ErrorCode.NOT_FOUND,
      'No se encontro esa maraton',
      HttpStatus.NOT_FOUND,
    );
  }
}

function toCategoria(categoria: {
  id: string;
  name: string;
  minAge: number | null;
  maxAge: number | null;
  gender: string | null;
  extraPriceCents: number;
}) {
  return {
    id: categoria.id,
    name: categoria.name,
    minAge: categoria.minAge,
    maxAge: categoria.maxAge,
    gender: categoria.gender,
    extraPriceCents: categoria.extraPriceCents,
  };
}

function toExtra(extra: { id: string; name: string; priceCents: number; stock: number | null }) {
  return {
    id: extra.id,
    name: extra.name,
    priceCents: extra.priceCents,
    // `stock: null` es "sin limite", no "sin stock". Se expone resuelto para
    // que la UI no tenga que aprenderse esa distincion.
    available: extra.stock === null || extra.stock > 0,
    stock: extra.stock,
  };
}
