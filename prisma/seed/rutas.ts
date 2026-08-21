import { DEFORMACION, log, prisma, radioDeCircuito, titulo } from './comun';
import type { Prisma } from '../../generated/prisma/client';

/**
 * Recorridos preestablecidos.
 *
 * Van **antes** que las maratones porque cada carrera se crea eligiendo uno:
 * es el flujo que usa el panel de verdad, y sembrar las maratones con una
 * geometria suelta dejaria un entorno de prueba donde ese paso no existe.
 */

/** Circuito cerrado deformado, centrado en `lat`/`lng`, que mide `metros`. */
export function circuito(lat: number, lng: number, metros: number): Prisma.InputJsonObject {
  const PUNTOS = 60;
  const radioGrados = radioDeCircuito(metros);
  // Un grado de longitud se acorta con la latitud; sin esto el circuito sale
  // ovalado y la distancia dibujada no cuadra con la anunciada.
  const correccion = Math.cos((lat * Math.PI) / 180);

  const coordinates = Array.from({ length: PUNTOS + 1 }, (_, i) => {
    const angulo = (i / PUNTOS) * 2 * Math.PI;
    const r = radioGrados * (1 + DEFORMACION * Math.sin(3 * angulo));

    return [
      Number((lng + (r * Math.cos(angulo)) / correccion).toFixed(6)),
      Number((lat + r * Math.sin(angulo)).toFixed(6)),
    ];
  });

  return { type: 'LineString', coordinates };
}

/** Lo minimo que hace falta para derivar un recorrido de una carrera. */
export interface SemillaRuta {
  slug: string;
  name: string;
  description: string;
  city: string;
  distanceMeters: number;
  lat: number;
  lng: number;
  elevationGainMeters: number | null;
}

/**
 * Recorridos que **no** tienen carrera asociada.
 *
 * Existen para que el selector del panel tenga opciones libres: con solo los
 * circuitos ya usados, "crear una maraton eligiendo su recorrido" se probaria
 * siempre reciclando el de otra carrera.
 */
const RUTAS_SUELTAS: SemillaRuta[] = [
  {
    slug: 'circuito-parque-urbano-central',
    name: 'Circuito Parque Urbano Central',
    description: 'Ocho vueltas al parque, plano y cerrado al trafico. El de las carreras cortas.',
    city: 'La Paz',
    distanceMeters: 5000,
    lat: -16.4986,
    lng: -68.1335,
    elevationGainMeters: 40,
  },
  {
    slug: 'circuito-lago-alalay',
    name: 'Circuito Lago Alalay',
    description: 'La vuelta completa a la laguna por el paseo peatonal. Sin cruces con vehiculos.',
    city: 'Cochabamba',
    distanceMeters: 10_000,
    lat: -17.4075,
    lng: -66.1417,
    elevationGainMeters: 60,
  },
  {
    slug: 'circuito-avenida-costanera',
    name: 'Circuito Avenida Costanera',
    description: 'Ida y vuelta por la costanera. El mas rapido de los tres: casi sin desnivel.',
    city: 'Santa Cruz de la Sierra',
    distanceMeters: 21_097,
    lat: -17.7639,
    lng: -63.1532,
    elevationGainMeters: 15,
  },
];

/** Lo que una maraton necesita copiarse del recorrido que eligio. */
export interface RutaSembrada {
  id: string;
  distanceMeters: number;
  startLat: number;
  startLng: number;
  geoJson: Prisma.InputJsonObject;
}

/** Slug del recorrido derivado de una carrera. Un solo sitio que lo decide. */
export const rutaDeMaraton = (slugMaraton: string): string => `circuito-${slugMaraton}`;

/**
 * Siembra un recorrido por carrera mas los sueltos. Idempotente por `slug`.
 *
 * Devuelve el mapa `slug de recorrido -> fila`, que es lo que `sembrarMaratones`
 * usa para copiar geometria y distancia sin volver a generarlas.
 */
export async function sembrarRutas(
  derivadas: readonly SemillaRuta[],
): Promise<Map<string, RutaSembrada>> {
  titulo('Recorridos');

  const sembradas = new Map<string, RutaSembrada>();

  for (const semilla of [...derivadas, ...RUTAS_SUELTAS]) {
    const existente = await prisma.route.findUnique({ where: { slug: semilla.slug } });

    if (existente) {
      log(`${semilla.slug} ya existe`);
      sembradas.set(semilla.slug, {
        id: existente.id,
        distanceMeters: existente.distanceMeters,
        startLat: existente.startLat,
        startLng: existente.startLng,
        geoJson: existente.geoJson as Prisma.InputJsonObject,
      });
      continue;
    }

    const geoJson = circuito(semilla.lat, semilla.lng, semilla.distanceMeters);
    const [startLng, startLat] = (geoJson['coordinates'] as [number, number][])[0]!;

    const ruta = await prisma.route.create({
      data: {
        slug: semilla.slug,
        name: semilla.name,
        description: semilla.description,
        city: semilla.city,
        distanceMeters: semilla.distanceMeters,
        elevationGainMeters: semilla.elevationGainMeters,
        startLat,
        startLng,
        geoJson,
      },
    });

    sembradas.set(semilla.slug, {
      id: ruta.id,
      distanceMeters: ruta.distanceMeters,
      startLat: ruta.startLat,
      startLng: ruta.startLng,
      geoJson,
    });

    log(`${semilla.slug} creado (${semilla.distanceMeters} m)`);
  }

  return sembradas;
}
