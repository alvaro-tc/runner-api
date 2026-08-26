import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import QRCode from 'qrcode';
import { enDias, log, prisma, titulo } from './comun';
import { crearEntrenamiento, generarTrack } from './track';
import { armarDorsal } from '../../src/modules/registrations/bib-number';
import { marcadores } from '../../src/modules/workouts/metrics';
import type { PaymentMethod, RegistrationStatus } from '../../generated/prisma/enums';

/** El id externo del proveedor mock tiene esta forma; se imita para que los
 *  datos sembrados no se distingan de los que produce el driver. */
const nuevoExternalId = (): string => `mock_pi_${randomBytes(12).toString('hex')}`;

interface SemillaInscripcion {
  marathonSlug: string;
  status: RegistrationStatus;
  /** Nombre de la categoria elegida, tal como esta en el catalogo. */
  categoria: string | null;
  /** Nombres de los extras elegidos, con su cantidad. */
  extras: { nombre: string; cantidad: number }[];
  metodo: PaymentMethod;
  /** Estado del cobro. `null` = todavia no hay cobro (borrador). */
  pago: 'paid' | 'pending' | 'refunded' | null;
  dorsal: number | null;
  /** Dias desde hoy en que se inscribio. Siempre negativo. */
  inscritoEnDias: number;
}

/**
 * Las cuatro inscripciones del corredor de prueba.
 *
 * Cubren los cuatro caminos que la pantalla de Carreras tiene que saber pintar:
 * una futura pagada, una futura esperando el QR, una corrida con resultado y
 * una cancelada con su reembolso. Sin las cuatro, la mitad de esa pantalla no
 * se puede mirar.
 */
const INSCRIPCIONES: SemillaInscripcion[] = [
  {
    marathonSlug: 'maraton-valle-tarija',
    status: 'confirmed',
    categoria: 'General',
    extras: [{ nombre: 'Cena del corredor', cantidad: 1 }],
    metodo: 'card',
    pago: 'paid',
    dorsal: 412,
    inscritoEnDias: -12,
  },
  {
    marathonSlug: 'maraton-la-paz-3600',
    status: 'pending_payment',
    categoria: 'Recreativa',
    extras: [{ nombre: 'Transporte a la largada', cantidad: 1 }],
    metodo: 'qr',
    pago: 'pending',
    dorsal: null,
    inscritoEnDias: -1,
  },
  {
    marathonSlug: 'carrera-10k-la-paz-invierno',
    status: 'confirmed',
    categoria: 'General',
    extras: [],
    metodo: 'card',
    pago: 'paid',
    dorsal: 337,
    inscritoEnDias: -75,
  },
  {
    marathonSlug: 'trail-oruro-21k',
    status: 'refunded',
    categoria: 'General',
    extras: [{ nombre: 'Traslado desde La Paz', cantidad: 1 }],
    metodo: 'card',
    pago: 'refunded',
    dorsal: null,
    inscritoEnDias: -40,
  },
];

const DATOS_PERSONALES = {
  fullName: 'Alvaro Quispe',
  docId: '6789012 LP',
  phone: '+591 71234567',
  emergencyContact: { name: 'Camila Rojas', phone: '+591 76543210' },
  bloodType: 'O+',
  shirtSize: 'M',
  // Las dos preguntas del CAM. Se siembran respondidas para que el CSV de
  // inscritos tenga las columnas con datos y no todas vacias.
  knowsCam: true,
  acceptsDonorCall: false,
};

/**
 * Puesto del corredor en la carrera que ya corrio.
 *
 * Se escribe en vez de calcularse porque `recalcularPuestos` ordena a los
 * corredores **que existen en la base**, y aqui hay uno: sembrar 873 corredores
 * falsos para que el puesto salga de una ordenacion real es mucho trabajo para
 * un dato que la app solo muestra. Estos son los numeros que habria devuelto el
 * cronometraje.
 */
const PUESTO_GENERAL = 37;
const PUESTO_CATEGORIA = 8;

export async function sembrarInscripciones(userId: string): Promise<void> {
  titulo('Inscripciones');

  for (const semilla of INSCRIPCIONES) {
    const maraton = await prisma.marathon.findUnique({
      where: { slug: semilla.marathonSlug },
      include: { categories: true, extras: true },
    });

    if (!maraton) {
      log(`${semilla.marathonSlug} no existe en el catalogo, se omite`);
      continue;
    }

    const yaInscrito = await prisma.registration.findFirst({
      where: { userId, marathonId: maraton.id },
    });

    if (yaInscrito) {
      log(`${semilla.marathonSlug} ya tiene inscripcion`);
      continue;
    }

    const categoria = maraton.categories.find((c) => c.name === semilla.categoria) ?? null;
    const extras = semilla.extras.flatMap((e) => {
      const fila = maraton.extras.find((x) => x.name === e.nombre);

      return fila
        ? [{ extraId: fila.id, name: fila.name, quantity: e.cantidad, priceCents: fila.priceCents }]
        : [];
    });

    // El desglose se arma con la misma forma que produce `QuoteService`: el
    // comprobante en PDF lee de aqui, y una linea con otra forma sale en blanco.
    const items = [
      {
        type: 'base',
        refId: null,
        label: `Inscripcion ${maraton.name}`,
        quantity: 1,
        unitPriceCents: maraton.priceCents,
        amountCents: maraton.priceCents,
      },
      ...(categoria && categoria.extraPriceCents > 0
        ? [
            {
              type: 'category',
              refId: categoria.id,
              label: categoria.name,
              quantity: 1,
              unitPriceCents: categoria.extraPriceCents,
              amountCents: categoria.extraPriceCents,
            },
          ]
        : []),
      ...extras.map((e) => ({
        type: 'extra',
        refId: e.extraId,
        label: e.name,
        quantity: e.quantity,
        unitPriceCents: e.priceCents,
        amountCents: e.priceCents * e.quantity,
      })),
    ];

    const subtotalCents = items.reduce((a, i) => a + i.amountCents, 0);
    // El cargo por servicio esta apagado en el seed (ver `service-fee.ts`), asi
    // que no hay linea ni snapshot: el total es el subtotal. Encender la config
    // y volver a inscribirse desde la app es como se prueba el otro camino.
    const totalCents = subtotalCents;

    const registro = await prisma.registration.create({
      data: {
        userId,
        marathonId: maraton.id,
        categoryId: categoria?.id ?? null,
        status: semilla.status,
        step: 3,
        bibNumber: semilla.dorsal === null ? null : armarDorsal(maraton.name, semilla.dorsal),
        personalData: DATOS_PERSONALES,
        extras: extras,
        subtotalCents,
        serviceFeeCents: 0,
        quoteSnapshot: items,
        totalCents,
        termsAcceptedAt: enDias(semilla.inscritoEnDias),
        registeredAt: enDias(semilla.inscritoEnDias),
        cancelledAt: semilla.status === 'refunded' ? enDias(-20) : null,
      },
    });

    if (semilla.pago) {
      await crearPago(registro.id, semilla, totalCents);
    }

    log(
      `${semilla.marathonSlug}: ${semilla.status}` +
        (registro.bibNumber ? ` (dorsal ${registro.bibNumber})` : ''),
    );

    if (semilla.marathonSlug === 'carrera-10k-la-paz-invierno') {
      await sembrarCarreraCorrida(userId, registro.id, maraton);
    }
  }
}

/** El cobro que corresponde al estado de la inscripcion. */
async function crearPago(
  registrationId: string,
  semilla: SemillaInscripcion,
  amountCents: number,
): Promise<void> {
  const externalId = nuevoExternalId();
  const cuando = enDias(semilla.inscritoEnDias);

  const detalles =
    semilla.metodo === 'card'
      ? // Enmascarado siempre: del numero de tarjeta no se guarda nada mas, ni
        // en el seed. Un dato de prueba con formato de PAN completo es el que
        // alguien acaba copiando a produccion.
        { brand: 'visa', last4: '4242', holder: DATOS_PERSONALES.fullName }
      : { qr: await qrDePrueba(externalId, amountCents, registrationId) };

  await prisma.payment.create({
    data: {
      registrationId,
      method: semilla.metodo,
      status:
        semilla.pago === 'refunded' ? 'refunded' : semilla.pago === 'paid' ? 'paid' : 'pending',
      amountCents,
      methodDetails: detalles,
      idempotencyKey: randomUUID(),
      externalId,
      paidAt: semilla.pago === 'pending' ? null : cuando,
      refundedAt: semilla.pago === 'refunded' ? enDias(-20) : null,
      // El QR pendiente vence en 10 minutos desde ahora, no desde que se
      // inscribio: uno vencido hace tres dias deja la pantalla de pago inutil.
      expiresAt:
        semilla.metodo === 'qr' && semilla.pago === 'pending'
          ? new Date(Date.now() + 10 * 60_000)
          : null,
    },
  });
}

/**
 * QR real, no un placeholder.
 *
 * Se escribe el PNG en `UPLOADS_DIR` con la misma clave que usaria el proveedor
 * mock. Cuesta ocho lineas y es la diferencia entre poder mirar la pantalla de
 * pago por QR y encontrarse una imagen rota.
 */
async function qrDePrueba(
  externalId: string,
  amountCents: number,
  registrationId: string,
): Promise<{ imageUrl: string; payload: string }> {
  const payload = ['PACEUP-QR', externalId, String(amountCents), 'BOB', registrationId].join('|');
  const png = await QRCode.toBuffer(payload, { type: 'png', width: 512, margin: 2 });

  const clave = `payments/qr/${externalId}.png`;
  const destino = resolve(process.env['UPLOADS_DIR'] ?? './uploads', clave);
  await mkdir(dirname(destino), { recursive: true });
  await writeFile(destino, png);

  const base = (process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');

  return { imageUrl: `${base}/uploads/${clave}`, payload };
}

/**
 * La carrera que el corredor ya corrio: entrenamiento de tipo `race`, resultado
 * oficial y marcadores de paso cada 5 km.
 *
 * Los checkpoints salen de `marcadores()`, la misma funcion que usa la API. Si
 * se escribieran a mano, el marcador del km 5 caeria en un sitio por el que el
 * corredor —segun el recorrido guardado— no paso.
 */
async function sembrarCarreraCorrida(
  userId: string,
  registrationId: string,
  maraton: {
    id: string;
    startsAt: Date;
    lat: number | null;
    lng: number | null;
    distanceMeters: number;
  },
): Promise<void> {
  const device = await prisma.device.findFirst({ where: { userId } });
  if (!device) return;

  const puntos = generarTrack({
    // Sale un minuto y medio despues del pistoletazo: el tiempo de gun y el de
    // chip no coinciden nunca, y esa diferencia es justo lo que la pantalla de
    // resultado ensena.
    inicio: new Date(maraton.startsAt.getTime() + 92_000),
    // Un 1% mas que la distancia oficial. El GPS de un telefono SIEMPRE mide
    // largo en carrera —adelantamientos, curvas cortadas por fuera, ruido— y sin
    // ese margen el recorrido no llega a cruzar la marca del ultimo kilometro y
    // se pierde un marcador de paso.
    distanceMeters: Math.round(maraton.distanceMeters * 1.01),
    ritmoSecPerKm: 312,
    centro: { lat: maraton.lat ?? -16.5, lng: maraton.lng ?? -68.15 },
    altitudBase: 3300,
    semilla: 20260601,
  });

  const workout = await crearEntrenamiento({
    userId,
    deviceId: device.id,
    type: 'race',
    puntos,
    feeling: 5,
    notes: 'Salio redonda. Los ultimos 2K con el grupo de cabeza de mi categoria.',
    registrationId,
    marathonId: maraton.id,
  });

  const marcas = marcadores(puntos);
  const finishedAt = puntos.at(-1)!.recordedAt;

  const resultado = await prisma.raceResult.create({
    data: {
      registrationId,
      workoutId: workout.id,
      // Gun time: desde la largada oficial, no desde que el corredor cruzo el
      // arco de salida.
      finishTimeSeconds: Math.round((finishedAt.getTime() - maraton.startsAt.getTime()) / 1000),
      chipTimeSeconds: workout.durationSeconds,
      avgPaceSecPerKm: workout.avgPaceSecPerKm,
      avgSpeedMps: workout.avgSpeedMps,
      distanceMeters: workout.distanceMeters,
      elevationGainMeters: workout.elevationGainMeters,
      bestKmIndex: workout.bestKmIndex,
      overallRank: PUESTO_GENERAL,
      categoryRank: PUESTO_CATEGORIA,
      finishedAt,
    },
  });

  await prisma.raceCheckpoint.createMany({
    data: marcas.map((m) => ({ raceResultId: resultado.id, ...m })),
  });

  log(`  resultado cargado: ${marcas.length} marcadores, puesto ${PUESTO_GENERAL} general`);
}
