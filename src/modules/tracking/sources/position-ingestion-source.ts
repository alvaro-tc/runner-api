import { PositionSource } from '../../../../generated/prisma/enums';
import type { OsmAndQueryDto, PositionPointDto } from '../dto/tracking.dto';

/**
 * Un punto ya normalizado, listo para guardar.
 *
 * Es lo unico que ve `TrackingService`: de donde vino el punto —la app, un
 * reloj hablando OsmAnd, un tracker fisico— deja de importar en cuanto llega a
 * esta forma.
 */
export interface PuntoNormalizado {
  clientPointId: string;
  recordedAt: Date;
  lat: number;
  lng: number;
  altitude: number | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  heading: number | null;
  batteryLevel: number | null;
}

/**
 * Una fuente de posiciones.
 *
 * La puerta que el PROMT pide dejar abierta: agregar Traccar, un reloj o
 * cualquier otro origen es escribir un adaptador de veinte lineas que traduzca
 * su payload a `PuntoNormalizado[]`, no reescribir el modulo. Lo que **no**
 * cambia por fuente es la validacion, el dedupe ni el guardado: eso vive una
 * sola vez en `TrackingService`.
 */
export interface PositionIngestionSource<T = unknown> {
  /** Queda grabado en cada fila, para poder auditar de donde salio un recorrido. */
  readonly source: PositionSource;

  /** Traduce el payload propio de la fuente. No valida: de eso se encarga el servicio. */
  aPuntos(payload: T): PuntoNormalizado[];
}

/**
 * La app oficial: lotes de 15-30 s en JSON.
 *
 * Es la fuente normal y la unica que existe hoy. Su traduccion es casi la
 * identidad porque el DTO se diseno para esto; el trabajo real de las otras
 * fuentes sera precisamente no tener que tocar nada mas.
 */
export class AppBatchSource implements PositionIngestionSource<PositionPointDto[]> {
  readonly source = PositionSource.app_batch;

  aPuntos(puntos: PositionPointDto[]): PuntoNormalizado[] {
    return puntos.map((p) => ({
      clientPointId: p.clientPointId,
      recordedAt: new Date(p.recordedAt),
      lat: p.lat,
      lng: p.lng,
      altitude: p.altitude ?? null,
      speedMps: p.speed ?? null,
      accuracyMeters: p.accuracy ?? null,
      heading: p.heading ?? null,
      batteryLevel: p.battery ?? null,
    }));
  }
}

/**
 * Protocolo OsmAnd: un punto por peticion, todo en la query string.
 *
 * Es el idioma que hablan Traccar Client, varios relojes y casi cualquier
 * tracker barato. Traducirlo cuesta esta clase, y por eso vale la pena la
 * interfaz: el endpoint que lo recibe no valida, ni deduplica, ni guarda —de
 * eso ya se encarga `TrackingService`, igual que para la app.
 */
export class OsmAndSource implements PositionIngestionSource<OsmAndQueryDto> {
  readonly source = PositionSource.osmand;

  aPuntos(q: OsmAndQueryDto): PuntoNormalizado[] {
    const recordedAt = momento(q.timestamp);

    return [
      {
        // El protocolo no manda identificador de punto, asi que lo fabricamos
        // con el segundo exacto: un tracker que reintenta manda el mismo
        // timestamp, y el dedupe lo caza igual que con la app.
        clientPointId: `osmand-${Math.floor(recordedAt.getTime() / 1000)}`,
        recordedAt,
        lat: Number(q.lat),
        lng: Number(q.lon),
        altitude: numero(q.altitude),
        speedMps: numero(q.speed),
        accuracyMeters: numero(q.accuracy),
        heading: numero(q.bearing),
        batteryLevel: q.batt === undefined ? null : Math.round(Number(q.batt)),
      },
    ];
  }
}

/**
 * El `timestamp` de OsmAnd llega en tres formatos segun quien lo mande: unix en
 * segundos (lo normal), unix en milisegundos, o ISO-8601. Se distinguen por
 * magnitud; si no viene, vale la hora del servidor.
 */
function momento(valor: string | undefined): Date {
  if (!valor) return new Date();

  const n = Number(valor);
  if (Number.isFinite(n)) return new Date(n > 1e11 ? n : n * 1000);

  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? new Date(0) : fecha;
}

function numero(valor: string | undefined): number | null {
  if (valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}
