import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as QRCode from 'qrcode';
import { enDias, enDiasAHora, log, prisma, titulo } from './comun';
import { rutaDeMaraton, sembrarRutas, type SemillaRuta } from './rutas';
import type { Prisma } from '../../generated/prisma/client';
import type { Gender, MarathonRegistrationStatus } from '../../generated/prisma/enums';

interface SemillaCategoria {
  name: string;
  minAge: number | null;
  maxAge: number | null;
  /** Null = abierta a cualquier genero. */
  gender: Gender | null;
  extraPriceCents: number;
}

interface SemillaExtra {
  name: string;
  priceCents: number;
  /** Null = sin limite de stock. */
  stock: number | null;
}

interface SemillaMaraton {
  slug: string;
  name: string;
  description: string;
  /** Dias desde hoy. Negativo = ya se corrio. */
  enDias: number;
  /** Hora local de largada, en la zona de la carrera. */
  horaLargada: number;
  city: string;
  distanceMeters: number;
  capacity: number;
  slotsTaken: number;
  priceCents: number;
  registrationStatus: MarathonRegistrationStatus;
  /** Dias desde hoy en que cierran las inscripciones. Null = sin fecha. */
  cierraEnDias: number | null;
  schedule: { time: string; title: string }[];
  includes: string[];
  kitPickup: Prisma.InputJsonObject | null;
  lat: number;
  lng: number;
  categorias: SemillaCategoria[];
  extras: SemillaExtra[];
}

const CATEGORIA_GENERAL: SemillaCategoria = {
  name: 'General',
  minAge: null,
  maxAge: null,
  gender: null,
  extraPriceCents: 0,
};

const CATEGORIAS_POR_EDAD: SemillaCategoria[] = [
  { name: 'Juvenil', minAge: 16, maxAge: 22, gender: null, extraPriceCents: 0 },
  CATEGORIA_GENERAL,
  { name: 'Master 40+', minAge: 40, maxAge: null, gender: null, extraPriceCents: 0 },
];

/**
 * Diez maratones bolivianas: seis por correr y cuatro corridas.
 *
 * Los estados no se eligen a dedo, se **provocan**: una a tres dias y otra con
 * menos del 10% de cupo libre salen `closing_soon` solas, una con el cupo lleno
 * sale `full`, y una con el plazo vencido sale `closed`. Asi la pantalla del
 * catalogo muestra los cuatro estados sin que nadie edite una columna a mano, y
 * si la regla de `resolverEstado` se rompe, se nota al abrir la app.
 *
 * Precios entre Bs 80 y Bs 250, que es lo que cuesta una carrera de verdad aca.
 */
const MARATONES: SemillaMaraton[] = [
  // ─── Futuras ─────────────────────────────────────────────────────────────
  {
    slug: 'media-maraton-santa-cruz',
    name: 'Media Maraton Santa Cruz',
    description:
      '21K planos por el segundo anillo, largada de madrugada para escaparle al calor. La mas ' +
      'rapida del calendario boliviano: es donde se buscan marcas personales.',
    // A tres dias: `closing_soon` por fecha, sin tocar la columna.
    enDias: 3,
    horaLargada: 6,
    city: 'Santa Cruz de la Sierra',
    distanceMeters: 21_097,
    capacity: 1500,
    slotsTaken: 830,
    priceCents: 18_000,
    registrationStatus: 'closing_soon',
    cierraEnDias: 1,
    schedule: [
      { time: '05:00', title: 'Acreditacion y entrega de chips' },
      { time: '06:00', title: 'Largada 21K' },
      { time: '09:30', title: 'Premiacion' },
    ],
    includes: ['remera tecnica', 'medalla finisher', 'chip de cronometraje', 'hidratacion'],
    kitPickup: {
      from: enDias(1).toISOString(),
      to: enDias(2).toISOString(),
      address: 'Av. Monsenor Rivero 245, Santa Cruz',
      lat: -17.7739,
      lng: -63.1817,
    },
    lat: -17.7833,
    lng: -63.1821,
    categorias: CATEGORIAS_POR_EDAD,
    extras: [
      { name: 'Remera tecnica adicional', priceCents: 10_000, stock: 120 },
      { name: 'Foto profesional', priceCents: 7000, stock: null },
    ],
  },
  {
    slug: 'carrera-10k-cochabamba',
    name: 'Carrera 10K Cochabamba',
    description:
      '10K por la avenida Costanera y el parque Tunari. Cupo chico, plana y con mucha sombra: ' +
      'la primera carrera de mucha gente.',
    // A dos semanas y con menos del 10% de cupo libre: `closing_soon` por cupo.
    enDias: 14,
    horaLargada: 7,
    city: 'Cochabamba',
    distanceMeters: 10_000,
    capacity: 800,
    slotsTaken: 765,
    priceCents: 12_000,
    registrationStatus: 'closing_soon',
    cierraEnDias: 11,
    schedule: [
      { time: '06:15', title: 'Acreditacion' },
      { time: '07:00', title: 'Largada' },
      { time: '09:00', title: 'Premiacion' },
    ],
    includes: ['remera', 'medalla finisher', 'hidratacion'],
    kitPickup: null,
    lat: -17.3895,
    lng: -66.1568,
    categorias: [CATEGORIA_GENERAL, CATEGORIAS_POR_EDAD[2]!],
    extras: [{ name: 'Bolsa de corredor', priceCents: 4500, stock: 300 }],
  },
  {
    slug: 'trail-oruro-21k',
    name: 'Trail Oruro 21K',
    description:
      '21K de montana por los cerros de Oruro, con 850 m de desnivel positivo. Exige experiencia ' +
      'en terreno tecnico y calzado de trail.',
    enDias: 30,
    horaLargada: 8,
    city: 'Oruro',
    distanceMeters: 21_097,
    capacity: 400,
    slotsTaken: 180,
    priceCents: 15_000,
    // Plazo vencido con cupo de sobra: el unico camino a `closed` que no es
    // "se lleno". Sirve para probar que la UI no ofrece inscribirse.
    registrationStatus: 'closed',
    cierraEnDias: -2,
    schedule: [
      { time: '07:00', title: 'Charla tecnica obligatoria' },
      { time: '08:00', title: 'Largada' },
    ],
    includes: ['remera tecnica', 'medalla finisher', 'seguro', 'hidratacion'],
    kitPickup: null,
    lat: -17.9833,
    lng: -67.1167,
    categorias: [CATEGORIA_GENERAL],
    extras: [{ name: 'Traslado desde La Paz', priceCents: 9000, stock: 40 }],
  },
  {
    slug: 'maraton-valle-tarija',
    name: 'Maraton del Valle de Tarija',
    description:
      '42K entre vinedos, con el ultimo tramo por la ribera del Guadalquivir. Perfil suave y ' +
      'clima seco: buena para debutar en la distancia.',
    enDias: 45,
    horaLargada: 6,
    city: 'Tarija',
    distanceMeters: 42_195,
    capacity: 1200,
    slotsTaken: 410,
    priceCents: 22_000,
    registrationStatus: 'open',
    cierraEnDias: 38,
    schedule: [
      { time: '05:00', title: 'Acreditacion' },
      { time: '06:00', title: 'Largada 42K' },
      { time: '06:30', title: 'Largada 21K' },
      { time: '12:30', title: 'Premiacion' },
    ],
    includes: ['remera tecnica', 'medalla finisher', 'chip de cronometraje', 'hidratacion'],
    kitPickup: {
      from: enDias(43).toISOString(),
      to: enDias(44).toISOString(),
      address: 'Plaza Luis de Fuentes, Tarija',
      lat: -21.5355,
      lng: -64.7296,
    },
    lat: -21.5355,
    lng: -64.7296,
    categorias: [
      { name: 'Elite masculino', minAge: 18, maxAge: 39, gender: 'male', extraPriceCents: 0 },
      { name: 'Elite femenino', minAge: 18, maxAge: 39, gender: 'female', extraPriceCents: 0 },
      { name: 'Master 40+', minAge: 40, maxAge: null, gender: null, extraPriceCents: 0 },
      CATEGORIA_GENERAL,
    ],
    extras: [
      { name: 'Remera tecnica adicional', priceCents: 11_000, stock: 200 },
      { name: 'Cena del corredor', priceCents: 6000, stock: 150 },
    ],
  },
  {
    slug: 'maraton-la-paz-3600',
    name: 'Maraton La Paz 3600',
    description:
      'La maraton mas alta del mundo. 42K por El Alto y la hoyada, con largada al amanecer desde ' +
      'la plaza Villarroel. La altura la convierte en otra carrera: hay que correrla por ' +
      'esfuerzo, no por ritmo.',
    enDias: 75,
    horaLargada: 6,
    city: 'La Paz',
    distanceMeters: 42_195,
    capacity: 3000,
    slotsTaken: 1240,
    priceCents: 25_000,
    registrationStatus: 'open',
    cierraEnDias: 68,
    schedule: [
      { time: '05:00', title: 'Acreditacion y entrega de chips' },
      { time: '06:30', title: 'Largada 42K' },
      { time: '07:00', title: 'Largada 21K' },
      { time: '12:00', title: 'Premiacion' },
    ],
    includes: ['remera tecnica', 'medalla finisher', 'chip de cronometraje', 'hidratacion'],
    kitPickup: {
      from: enDias(72).toISOString(),
      to: enDias(74).toISOString(),
      address: 'Av. Arce 2299, La Paz',
      lat: -16.5097,
      lng: -68.1274,
    },
    lat: -16.4955,
    lng: -68.1336,
    categorias: [
      { name: 'Elite masculino', minAge: 18, maxAge: 39, gender: 'male', extraPriceCents: 0 },
      { name: 'Elite femenino', minAge: 18, maxAge: 39, gender: 'female', extraPriceCents: 0 },
      { name: 'Master 40+', minAge: 40, maxAge: null, gender: null, extraPriceCents: 0 },
      { name: 'Recreativa', minAge: null, maxAge: null, gender: null, extraPriceCents: 0 },
    ],
    extras: [
      { name: 'Remera tecnica adicional', priceCents: 12_000, stock: 400 },
      { name: 'Transporte a la largada', priceCents: 3500, stock: 200 },
      { name: 'Foto profesional', priceCents: 8000, stock: null },
    ],
  },
  {
    slug: 'nocturna-5k-sucre',
    name: 'Nocturna 5K Sucre',
    description:
      '5K nocturna por el centro historico, sin cronometraje. Pensada para quien corre por ' +
      'primera vez: se puede caminar tramos y no hay tiempo de corte.',
    // A cuatro meses y con el cupo lleno: `full` sin que nadie edite el estado.
    enDias: 120,
    horaLargada: 19,
    city: 'Sucre',
    distanceMeters: 5000,
    capacity: 600,
    slotsTaken: 600,
    priceCents: 8000,
    registrationStatus: 'full',
    cierraEnDias: null,
    schedule: [
      { time: '18:00', title: 'Acreditacion' },
      { time: '19:00', title: 'Largada' },
    ],
    includes: ['remera', 'hidratacion'],
    kitPickup: null,
    lat: -19.0333,
    lng: -65.2627,
    categorias: [CATEGORIA_GENERAL],
    extras: [],
  },

  // ─── Pasadas ─────────────────────────────────────────────────────────────
  {
    slug: 'carrera-10k-la-paz-invierno',
    name: 'Carrera 10K La Paz Invierno',
    description: '10K por la zona sur, de Calacoto a Obrajes y vuelta. Fria y con buen ritmo.',
    enDias: -30,
    horaLargada: 8,
    city: 'La Paz',
    distanceMeters: 10_000,
    capacity: 900,
    slotsTaken: 874,
    priceCents: 10_000,
    registrationStatus: 'closed',
    cierraEnDias: -35,
    schedule: [{ time: '08:00', title: 'Largada' }],
    includes: ['remera', 'medalla finisher', 'chip de cronometraje'],
    kitPickup: null,
    lat: -16.5417,
    lng: -68.0806,
    categorias: CATEGORIAS_POR_EDAD,
    extras: [{ name: 'Foto profesional', priceCents: 7000, stock: null }],
  },
  {
    slug: 'maraton-potosi-42k',
    name: 'Maraton de Potosi',
    description: '42K alrededor del Cerro Rico, a 4.000 m. La mas dura del calendario.',
    enDias: -60,
    horaLargada: 7,
    city: 'Potosi',
    distanceMeters: 42_195,
    capacity: 700,
    slotsTaken: 512,
    priceCents: 20_000,
    registrationStatus: 'closed',
    cierraEnDias: -67,
    schedule: [
      { time: '06:00', title: 'Acreditacion' },
      { time: '07:00', title: 'Largada' },
    ],
    includes: ['remera tecnica', 'medalla finisher', 'chip de cronometraje', 'hidratacion'],
    kitPickup: null,
    lat: -19.5836,
    lng: -65.7531,
    categorias: [CATEGORIA_GENERAL, CATEGORIAS_POR_EDAD[2]!],
    extras: [],
  },
  {
    slug: 'media-maraton-el-alto',
    name: 'Media Maraton El Alto',
    description: '21K por la ceja y la avenida 6 de Marzo, a 4.150 m sobre el nivel del mar.',
    enDias: -120,
    horaLargada: 7,
    city: 'El Alto',
    distanceMeters: 21_097,
    capacity: 1000,
    slotsTaken: 1000,
    priceCents: 16_000,
    registrationStatus: 'closed',
    cierraEnDias: -127,
    schedule: [{ time: '07:00', title: 'Largada' }],
    includes: ['remera', 'medalla finisher', 'hidratacion'],
    kitPickup: null,
    lat: -16.5,
    lng: -68.1833,
    categorias: [CATEGORIA_GENERAL],
    extras: [],
  },
  {
    slug: '5k-familiar-trinidad',
    name: '5K Familiar Trinidad',
    description: '5K plana por el centro de Trinidad. Se puede correr con carrito de bebe.',
    enDias: -200,
    horaLargada: 7,
    city: 'Trinidad',
    distanceMeters: 5000,
    capacity: 500,
    slotsTaken: 320,
    priceCents: 9000,
    registrationStatus: 'closed',
    cierraEnDias: -205,
    schedule: [{ time: '07:00', title: 'Largada' }],
    includes: ['remera', 'hidratacion'],
    kitPickup: null,
    lat: -14.8333,
    lng: -64.9,
    categorias: [CATEGORIA_GENERAL],
    extras: [],
  },
];


/** El recorrido que le toca a cada carrera del catalogo de ejemplo. */
function aSemillaDeRuta(maraton: SemillaMaraton): SemillaRuta {
  const km = Math.round(maraton.distanceMeters / 1000);

  return {
    slug: rutaDeMaraton(maraton.slug),
    name: `Circuito ${maraton.city} ${km}K`,
    description: `Trazado oficial de ${km} kilometros usado por ${maraton.name}.`,
    city: maraton.city,
    distanceMeters: maraton.distanceMeters,
    lat: maraton.lat,
    lng: maraton.lng,
    elevationGainMeters: null,
  };
}

/** Idempotente por `slug`: una maraton ya sembrada se deja como esta, incluido
 *  lo que se haya editado desde el panel. */
export async function sembrarMaratones(): Promise<void> {
  // Un recorrido por carrera, sembrado antes: la maraton se crea eligiendo uno,
  // igual que desde el panel.
  const rutas = await sembrarRutas(MARATONES.map(aSemillaDeRuta));

  titulo('Maratones');

  for (const semilla of MARATONES) {
    const existente = await prisma.marathon.findUnique({ where: { slug: semilla.slug } });

    if (existente) {
      // Una maraton sembrada antes de que existieran los recorridos se quedo
      // sin `routeId`. Se rellena y nada mas: la geometria que ya tiene es la
      // que se le mostro a la gente, y pisarla seria cambiarle el mapa a una
      // carrera en pie.
      if (!existente.routeId) {
        await prisma.marathon.update({
          where: { id: existente.id },
          data: { routeId: rutas.get(rutaDeMaraton(semilla.slug))!.id },
        });
        log(`${semilla.slug} ya existe (vinculada a su recorrido)`);
      } else {
        log(`${semilla.slug} ya existe`);
      }
      continue;
    }

    const { categorias, extras, enDias: dias, horaLargada, cierraEnDias, ...datos } = semilla;
    const startsAt = enDiasAHora(dias, horaLargada);
    const ruta = rutas.get(rutaDeMaraton(semilla.slug))!;

    await prisma.marathon.create({
      data: {
        ...datos,
        startsAt,
        // TEMPORAL — cobro por QR manual. Ver `docs/pago-qr-manual.md`. Sin un
        // QR sembrado no se puede probar el flujo en local: el checkout
        // responderia `QR_NOT_CONFIGURED` y ahi se acaba la prueba.
        paymentQrUrl: await sembrarQrDeCobro(semilla.slug),
        paymentQrInstructions:
          'Escanea con tu banca movil, paga el monto exacto y pon la glosa que aparece abajo ' +
          'en el detalle de la transferencia.',
        registrationClosesAt: cierraEnDias === null ? null : enDias(cierraEnDias),
        kitPickup: datos.kitPickup ?? undefined,
        // Copiada del recorrido, no generada aqui: es exactamente lo que hace
        // el alta del panel cuando se elige un `routeId`.
        routeId: ruta.id,
        routeGeoJson: ruta.geoJson,
        distanceMeters: ruta.distanceMeters,
        // Publicada dos meses antes de correrse, no "ahora": una carrera que ya
        // ocurrio no pudo publicarse despues de su largada, y `publishedAt` es
        // justo el campo que alguien va a mirar cuando cuadre fechas.
        publishedAt: new Date(Math.min(startsAt.getTime() - 60 * 86_400_000, Date.now())),
        categories: { create: categorias },
        extras: { create: extras },
      },
    });

    log(`${semilla.slug} creada (${semilla.registrationStatus})`);
  }
}

/**
 * TEMPORAL — genera el QR de cobro de una maraton de ejemplo.
 * Ver `docs/pago-qr-manual.md`.
 *
 * Es un QR **de verdad**, escaneable, aunque lo que codifique sea inventado: un
 * placeholder gris deja sin probar justo lo unico que hace el usuario en esa
 * pantalla, que es apuntarle el telefono.
 *
 * Escribe directo en `UPLOADS_DIR` en vez de pasar por `StorageService` porque
 * el seed corre fuera del contenedor de Nest y no tiene inyeccion de
 * dependencias. Devuelve la **clave**, que es lo que se guarda en la columna.
 */
async function sembrarQrDeCobro(slug: string): Promise<string> {
  const clave = `marathons/qr/${slug}.png`;
  const raiz = resolve(process.env['UPLOADS_DIR'] ?? './uploads');
  const destino = join(raiz, clave);

  const png = await QRCode.toBuffer(`PACEUP-COBRO|${slug}`, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });

  await mkdir(dirname(destino), { recursive: true });
  await writeFile(destino, png);

  return clave;
}
