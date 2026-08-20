import { randomUUID } from 'node:crypto';
import { DEFORMACION, GRADOS_POR_METRO, prisma, radioDeCircuito } from './comun';
import { calorias, consolidar, type Punto } from '../../src/modules/workouts/metrics';
import type { Prisma } from '../../generated/prisma/client';
import type { PositionSource, WorkoutType } from '../../generated/prisma/enums';

/**
 * Generacion de recorridos GPS sinteticos y alta de entrenamientos completos.
 *
 * **Las metricas las calcula `consolidar()`, la misma funcion que usa la API.**
 * No se escriben a mano en el seed: si el seed inventara sus propias distancias
 * y ritmos, la app mostraria numeros que el backend nunca habria producido, y el
 * dia que la consolidacion cambiara nadie se enteraria de que los datos de
 * ejemplo dejaron de tener sentido.
 */

/** Un punto ya listo para insertar, con lo que el telefono habria medido. */
interface PuntoGenerado extends Punto {
  speedMps: number;
  heading: number;
  batteryLevel: number;
}

/**
 * PRNG determinista (mulberry32).
 *
 * El seed **no** usa `Math.random`: con la misma semilla, dos `db:reset` dan
 * exactamente los mismos entrenamientos. Eso es lo que permite comparar una
 * captura de pantalla de ayer con la de hoy, o reproducir un bug de la app sin
 * que el dato de abajo se haya movido.
 */
function prng(semilla: number): () => number {
  let a = semilla >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface OpcionesDeTrack {
  inicio: Date;
  distanceMeters: number;
  /** Ritmo medio objetivo. La variacion por kilometro la pone el generador. */
  ritmoSecPerKm: number;
  centro: { lat: number; lng: number };
  altitudBase: number;
  semilla: number;
}

/** Un punto cada 10 segundos. */
const SEGUNDOS_ENTRE_PUNTOS = 10;

/**
 * Recorrido de un entrenamiento: un circuito cerrado alrededor de un punto, a
 * ritmo variable y con el ruido de un GPS de telefono.
 *
 * Un punto cada 10 s y no cada segundo, que es lo que manda la app de verdad:
 * a 1 Hz, cuarenta entrenamientos serian 130.000 filas y un `db:reset` de
 * varios minutos. A 10 s hay un punto cada ~30 m, de sobra para que los splits,
 * el desnivel y los marcadores de paso salgan bien. La constante esta arriba
 * por si alguien quiere el detalle fino.
 */
export function generarTrack(o: OpcionesDeTrack): PuntoGenerado[] {
  const azar = prng(o.semilla);
  const duracion = Math.round((o.distanceMeters / 1000) * o.ritmoSecPerKm);
  const cantidad = Math.max(2, Math.floor(duracion / SEGUNDOS_ENTRE_PUNTOS));

  const radioGrados = radioDeCircuito(o.distanceMeters);
  const correccion = Math.cos((o.centro.lat * Math.PI) / 180);

  const puntos: PuntoGenerado[] = [];
  let recorrido = 0;

  for (let i = 0; i < cantidad; i++) {
    // El ritmo oscila ±8% a lo largo de la salida (cuestas, semaforos, piernas).
    const factor = 1 + 0.08 * Math.sin(i / 9) + (azar() - 0.5) * 0.05;
    const velocidad = 1000 / (o.ritmoSecPerKm * factor);
    recorrido += velocidad * SEGUNDOS_ENTRE_PUNTOS;

    const angulo = (recorrido / o.distanceMeters) * 2 * Math.PI;
    const r = radioGrados * (1 + DEFORMACION * Math.sin(3 * angulo));
    // ±1,5 m de ruido lateral. Poco a proposito: el ruido se suma en cada
    // tramo y con ±4 m un "10K" acababa midiendo 10,7 km. Un GPS de telefono
    // mide algo largo —eso es real— pero un 7% no lo es.
    const ruido = () => (azar() - 0.5) * 3 * GRADOS_POR_METRO;

    // Uno de cada cien puntos llega con precision pesima. Es real —un tunel, un
    // edificio— y ademas hace que el seed ejercite el filtro de `consolidar()`
    // en vez de darle solo datos perfectos que nunca prueban nada.
    const malo = azar() < 0.01;

    puntos.push({
      recordedAt: new Date(o.inicio.getTime() + i * SEGUNDOS_ENTRE_PUNTOS * 1000),
      lat: Number((o.centro.lat + r * Math.sin(angulo) + ruido()).toFixed(6)),
      lng: Number((o.centro.lng + (r * Math.cos(angulo)) / correccion + ruido()).toFixed(6)),
      altitude: Number((o.altitudBase + 18 * Math.sin(angulo * 2) + azar() * 3).toFixed(1)),
      accuracyMeters: malo
        ? Number((35 + azar() * 25).toFixed(1))
        : Number((4 + azar() * 7).toFixed(1)),
      speedMps: Number(velocidad.toFixed(2)),
      heading: Number((((angulo * 180) / Math.PI + 90) % 360).toFixed(1)),
      batteryLevel: Math.max(5, Math.round(95 - (i / cantidad) * 25)),
    });
  }

  return puntos;
}

export interface EntrenamientoSembrado {
  userId: string;
  deviceId: string;
  type: WorkoutType;
  puntos: PuntoGenerado[];
  feeling: number | null;
  notes: string | null;
  registrationId?: string | null;
  marathonId?: string | null;
  source?: PositionSource;
}

/**
 * Crea un entrenamiento completo: workout con sus metricas, splits, sesion de
 * tracking cerrada y todas sus posiciones.
 *
 * Devuelve el workout ya creado.
 */
export async function crearEntrenamiento(datos: EntrenamientoSembrado) {
  const metricas = consolidar(datos.puntos);
  const inicio = datos.puntos[0]!.recordedAt;
  const fin = datos.puntos.at(-1)!.recordedAt;

  const peso = await prisma.userProfile
    .findUnique({ where: { userId: datos.userId }, select: { weightGrams: true } })
    .then((p) => p?.weightGrams ?? null);

  const workout = await prisma.workout.create({
    data: {
      userId: datos.userId,
      // El cliente lo genera antes de tener red; aqui vale cualquier uuid, pero
      // tiene que existir: es la clave de idempotencia del sync.
      clientUuid: randomUUID(),
      type: datos.type,
      registrationId: datos.registrationId ?? null,
      startedAt: inicio,
      endedAt: fin,
      durationSeconds: metricas.durationSeconds,
      movingSeconds: metricas.movingSeconds,
      distanceMeters: metricas.distanceMeters,
      avgPaceSecPerKm: metricas.avgPaceSecPerKm,
      avgSpeedMps: metricas.avgSpeedMps,
      elevationGainMeters: metricas.elevationGainMeters,
      bestKmIndex: metricas.bestKmIndex,
      calories: calorias(metricas.distanceMeters, metricas.movingSeconds, peso),
      feeling: datos.feeling,
      notes: datos.notes,
      splits: { create: metricas.splits },
    },
  });

  const sesion = await prisma.trackingSession.create({
    data: {
      userId: datos.userId,
      workoutId: workout.id,
      marathonId: datos.marathonId ?? null,
      deviceId: datos.deviceId,
      status: 'finished',
      // Marcador, no credencial: la sesion esta cerrada y no admite ingesta.
      ingestToken: `seed:${workout.id}`,
      startedAt: inicio,
      lastPositionAt: fin,
      finishedAt: fin,
    },
  });

  const filas: Prisma.PositionCreateManyInput[] = datos.puntos.map((p, i) => ({
    trackingSessionId: sesion.id,
    workoutId: workout.id,
    userId: datos.userId,
    deviceId: datos.deviceId,
    recordedAt: p.recordedAt,
    receivedAt: p.recordedAt,
    lat: p.lat,
    lng: p.lng,
    altitude: p.altitude,
    speedMps: p.speedMps,
    accuracyMeters: p.accuracyMeters,
    heading: p.heading,
    batteryLevel: p.batteryLevel,
    source: datos.source ?? 'app_batch',
    clientPointId: `${workout.id}-${i}`,
  }));

  // Por lotes: un `createMany` de 300.000 parametros es una sentencia que
  // Postgres rechaza por limite de parametros, no una optimizacion valiente.
  for (let i = 0; i < filas.length; i += 500) {
    await prisma.position.createMany({ data: filas.slice(i, i + 500) });
  }

  return workout;
}
