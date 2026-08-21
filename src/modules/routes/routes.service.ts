import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { camposPresentes } from '../../common/utils/patch';
import { aSlug } from '../../common/utils/slug';
import { simplificarHasta, type LineStringGeoJson } from '../races/route';
import type { Prisma } from '../../../generated/prisma/client';
import { resolverRecorrido } from './linestring';
import type { CreateRouteDto, ListRoutesQueryDto, UpdateRouteDto } from './dto/route.dto';

const CAMPOS_RESUMEN = {
  id: true,
  slug: true,
  name: true,
  description: true,
  city: true,
  country: true,
  distanceMeters: true,
  startLat: true,
  startLng: true,
  elevationGainMeters: true,
  archivedAt: true,
} as const;

type FilaResumen = Prisma.RouteGetPayload<{ select: typeof CAMPOS_RESUMEN }>;

/**
 * Catalogo de recorridos preestablecidos.
 *
 * Es el paso previo a crear una maraton: el organizador elige un trazado ya
 * cargado en vez de dibujar uno, y la carrera se queda con una **copia** de esa
 * geometria (ver `model Route` en el esquema). Este servicio es quien resuelve
 * esa copia, para que el modulo de admin no tenga que saber que forma tiene un
 * GeoJSON valido.
 */
@Injectable()
export class RoutesService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Consulta ────────────────────────────────────────────────────────────

  /** Sin paginar a proposito: una ciudad tiene circuitos, no miles. */
  async listar(query: ListRoutesQueryDto) {
    const filas = await this.prisma.route.findMany({
      where: {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(query.city ? { city: { contains: query.city, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ city: 'asc' }, { distanceMeters: 'asc' }],
      select: CAMPOS_RESUMEN,
    });

    return filas.map(toResumen);
  }

  /**
   * Un recorrido con su geometria.
   *
   * Sale **simplificado** salvo que se pida entero: el movil lo pinta en un
   * mapa de 400 px y los vertices que no cambian un pixel solo engordan el
   * JSON. El panel, que edita el trazado, pide `full`.
   */
  async detalle(slugOId: string, full = false) {
    const ruta = await this.buscar(slugOId);
    const geo = ruta.geoJson as unknown as LineStringGeoJson;

    return {
      ...toResumen(ruta),
      geoJson: full ? geo : simplificarGeo(geo),
    };
  }

  // ─── Escritura (la usa el panel, via AdminService) ───────────────────────

  async crear(dto: CreateRouteDto) {
    const recorrido = this.exigirGeometria(dto.geoJson);
    const slug = await this.slugLibre(dto.slug ?? aSlug(dto.name));

    const ruta = await this.prisma.route.create({
      data: {
        slug,
        name: dto.name,
        description: dto.description ?? null,
        city: dto.city,
        country: dto.country ?? 'BO',
        elevationGainMeters: dto.elevationGainMeters ?? null,
        distanceMeters: recorrido.distanceMeters,
        startLat: recorrido.startLat,
        startLng: recorrido.startLng,
        geoJson: recorrido.geoJson as unknown as Prisma.InputJsonValue,
      },
      select: CAMPOS_RESUMEN,
    });

    return toResumen(ruta);
  }

  /**
   * Edita un recorrido. Lo que no venga no se toca.
   *
   * Cambiar la geometria **no** toca las maratones que ya lo usaron: se
   * llevaron su copia. Eso es lo que se quiere — el trazado de una carrera
   * corrida es historia, no configuracion.
   */
  async actualizar(id: string, dto: UpdateRouteDto) {
    const actual = await this.buscar(id);
    const datos: Prisma.RouteUncheckedUpdateInput = camposPresentes(dto, [
      'name',
      'description',
      'city',
      'country',
      'elevationGainMeters',
    ]);

    if (dto.geoJson !== undefined) {
      const recorrido = this.exigirGeometria(dto.geoJson);
      datos.geoJson = recorrido.geoJson as unknown as Prisma.InputJsonValue;
      datos.distanceMeters = recorrido.distanceMeters;
      datos.startLat = recorrido.startLat;
      datos.startLng = recorrido.startLng;
    }

    if (dto.slug !== undefined && dto.slug !== actual.slug) {
      datos.slug = await this.slugLibre(dto.slug, actual.id);
    }

    if (dto.archived !== undefined) {
      datos.archivedAt = dto.archived ? (actual.archivedAt ?? new Date()) : null;
    }

    const ruta = await this.prisma.route.update({
      where: { id: actual.id },
      data: datos,
      select: CAMPOS_RESUMEN,
    });

    return toResumen(ruta);
  }

  /**
   * Borra un recorrido, y solo si ninguna maraton salio de el.
   *
   * Con carreras detras la accion correcta es archivar: la relacion es
   * `SetNull`, asi que borrar no rompe nada, pero deja carreras sin saber de
   * donde vino su trazado. Archivar lo saca del selector y conserva el rastro.
   */
  async borrar(id: string) {
    const ruta = await this.buscar(id);
    const usos = await this.prisma.marathon.count({ where: { routeId: ruta.id } });

    if (usos > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `${usos} maraton(es) salieron de este recorrido. Archivalo en vez de borrarlo.`,
        HttpStatus.CONFLICT,
        [{ marathons: usos }],
      );
    }

    await this.prisma.route.delete({ where: { id: ruta.id } });
  }

  // ─── Para el alta de maratones ───────────────────────────────────────────

  /**
   * Lo que una maraton hereda al elegir este recorrido.
   *
   * Devuelve la geometria y la distancia **medida**, no la declarada por nadie.
   * Un recorrido archivado no se puede elegir: si sigue en un selector es un
   * bug del panel, y dejarlo pasar aqui lo esconderia.
   */
  async paraMaraton(routeId: string) {
    const ruta = await this.buscar(routeId);

    if (ruta.archivedAt) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Ese recorrido esta archivado y no se puede usar en una carrera nueva',
        HttpStatus.CONFLICT,
      );
    }

    return {
      routeId: ruta.id,
      routeGeoJson: ruta.geoJson as unknown as Prisma.InputJsonValue,
      distanceMeters: ruta.distanceMeters,
      lat: ruta.startLat,
      lng: ruta.startLng,
    };
  }

  // ─── Interno ─────────────────────────────────────────────────────────────

  private exigirGeometria(entrada: unknown) {
    const recorrido = resolverRecorrido(entrada);

    if (!recorrido) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'El recorrido tiene que ser un LineString GeoJSON de al menos 100 m, con pares [lng, lat]',
        HttpStatus.BAD_REQUEST,
      );
    }

    return recorrido;
  }

  private async buscar(slugOId: string) {
    const ruta = await this.prisma.route.findFirst({
      where: { OR: [{ id: slugOId }, { slug: slugOId }] },
    });

    if (!ruta) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No se encontro ese recorrido',
        HttpStatus.NOT_FOUND,
      );
    }

    return ruta;
  }

  private async slugLibre(base: string, excluyendoId?: string): Promise<string> {
    const raiz = base || 'recorrido';

    for (let intento = 1; ; intento += 1) {
      const candidato = intento === 1 ? raiz : `${raiz}-${intento}`;
      const chocando = await this.prisma.route.findUnique({
        where: { slug: candidato },
        select: { id: true },
      });

      if (!chocando || chocando.id === excluyendoId) return candidato;
    }
  }
}

function toResumen(ruta: FilaResumen) {
  return {
    id: ruta.id,
    slug: ruta.slug,
    name: ruta.name,
    description: ruta.description,
    city: ruta.city,
    country: ruta.country,
    distanceMeters: ruta.distanceMeters,
    startLat: ruta.startLat,
    startLng: ruta.startLng,
    elevationGainMeters: ruta.elevationGainMeters,
    archived: ruta.archivedAt !== null,
  };
}

/** Misma simplificacion que usa el recorrido de una carrera: un solo criterio. */
function simplificarGeo(geo: LineStringGeoJson): LineStringGeoJson {
  const puntos = geo.coordinates.map(([lng, lat]) => ({ lat, lng }));
  const { puntos: reducidos } = simplificarHasta(puntos);

  return {
    type: 'LineString',
    coordinates: reducidos.map((p) => [p.lng, p.lat]),
  };
}
