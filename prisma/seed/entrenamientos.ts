import { enDias, log, prisma, titulo } from './comun';
import { crearEntrenamiento, generarTrack } from './track';
import {
  lunesDe,
  materializar,
  rangoRitmo,
  sumarDias,
} from '../../src/modules/training-plans/plan-schedule';
import type { TrainingPlanSessionStatus } from '../../generated/prisma/enums';

/** Zona sur de La Paz: de ahi salen todos los entrenamientos del corredor. */
const CASA = { lat: -16.5417, lng: -68.0806 };
const ALTITUD = 3300;

/** Cuatro meses de historial. */
const DIAS_DE_HISTORIAL = 120;

interface Salida {
  distanceMeters: number;
  ritmoSecPerKm: number;
  feeling: number;
  notes: string | null;
}

/**
 * La semana tipo del corredor, indexada por `Date.getDay()` (0 = domingo).
 *
 * Tres salidas: series el martes, suave el viernes y la larga el domingo. Son
 * tres de los cuatro dias del plan de 21K que se siembra despues, asi que las
 * sesiones cumplidas se cuelgan de un entrenamiento de verdad — y la del
 * miercoles queda completada sin workout, que tambien pasa y la app tiene que
 * saber pintarlo.
 *
 * Sembrar dias sueltos al azar daria un historial que ningun corredor tendria y
 * dejaria la pantalla de estadisticas semanales sin forma reconocible.
 */
const SEMANA: (Salida | null)[] = [
  { distanceMeters: 16_000, ritmoSecPerKm: 330, feeling: 5, notes: 'Larga por la Costanera' },
  null,
  { distanceMeters: 10_000, ritmoSecPerKm: 300, feeling: 3, notes: 'Series de 1K, piernas duras' },
  null,
  null,
  { distanceMeters: 8000, ritmoSecPerKm: 345, feeling: 4, notes: null },
  null,
];

/**
 * Paron por la rodilla: dos semanas sin correr, a mitad del historial.
 *
 * Un historial de cuatro meses sin un solo hueco no es el de nadie. Ademas
 * cuadra con la lesion declarada en el perfil del corredor, y le da algo real
 * que mostrar a la pantalla de salud y al calculo de volumen medio.
 */
const LESION_DESDE = 74;
const LESION_HASTA = 60;

export async function sembrarDispositivo(userId: string) {
  const existente = await prisma.device.findFirst({ where: { userId } });
  if (existente) return existente;

  return prisma.device.create({
    data: {
      userId,
      uniqueId: '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
      name: 'Pixel 8',
      platform: 'android',
      appVersion: '1.0.0',
      osVersion: '15',
      lastSeenAt: new Date(),
    },
  });
}

/**
 * Cuatro meses de entrenamientos con sus posiciones GPS.
 *
 * Devuelve los workouts creados, del mas viejo al mas nuevo: el plan los
 * necesita para colgar de ellos las sesiones que ya se cumplieron.
 */
export async function sembrarEntrenamientos(userId: string, deviceId: string) {
  titulo('Entrenamientos');

  const yaHay = await prisma.workout.count({ where: { userId, type: { not: 'race' } } });
  if (yaHay > 0) {
    log(`el corredor ya tiene ${yaHay} entrenamientos`);
    return prisma.workout.findMany({ where: { userId }, orderBy: { startedAt: 'asc' } });
  }

  const creados = [];

  for (let dias = DIAS_DE_HISTORIAL; dias >= 0; dias--) {
    const fecha = enDias(-dias);
    if (dias <= LESION_DESDE && dias >= LESION_HASTA) continue;

    const salida = SEMANA[fecha.getDay()];
    if (!salida) continue;

    // La forma fisica mejora a lo largo de los cuatro meses: la ultima semana
    // se corre un 6% mas rapido que la primera. Sin esa deriva, `Riegel` sobre
    // "el mejor esfuerzo reciente" daria siempre lo mismo y la prediccion de
    // llegada no tendria nada que predecir.
    const progreso = 1 - 0.06 * (1 - dias / DIAS_DE_HISTORIAL);
    // Salidas a las 06:30 (hora local de La Paz, UTC-4).
    fecha.setUTCHours(10, 30, 0, 0);

    const puntos = generarTrack({
      inicio: fecha,
      distanceMeters: salida.distanceMeters,
      ritmoSecPerKm: Math.round(salida.ritmoSecPerKm * progreso),
      centro: CASA,
      altitudBase: ALTITUD,
      semilla: 1000 + dias,
    });

    creados.push(
      await crearEntrenamiento({
        userId,
        deviceId,
        type: 'free_run',
        puntos,
        feeling: salida.feeling,
        notes: salida.notes,
      }),
    );
  }

  const total = creados.reduce((a, w) => a + w.distanceMeters, 0);
  log(
    `${creados.length} entrenamientos, ${Math.round(total / 1000)} km en ${DIAS_DE_HISTORIAL} dias`,
  );

  return creados;
}

/**
 * Zapatillas del corredor, con la principal **cerca del umbral de desgaste**.
 *
 * Que este cerca y no pasada es deliberado: asi se puede ver la barra de
 * desgaste en amarillo, y una salida larga mas dispara el aviso de verdad, por
 * el camino real (`justCrossedWearAlert`) en vez de por un dato puesto a mano.
 */
export async function sembrarZapatillas(userId: string, kilometrosCorridos: number) {
  titulo('Zapatillas');

  if ((await prisma.shoe.count({ where: { userId } })) > 0) {
    log('el corredor ya tiene zapatillas');
    return;
  }

  const UMBRAL = 800_000;

  await prisma.shoe.createMany({
    data: [
      {
        userId,
        brand: 'Asics',
        model: 'Gel-Nimbus 26',
        // Lo corrido en estos cuatro meses mas la vida que ya traia, ajustado
        // para quedar **por debajo** del umbral: asi la barra de desgaste sale
        // en amarillo y una larga mas dispara el aviso por el camino real
        // (`justCrossedWearAlert`), no por un dato puesto a mano.
        distanceMeters: Math.max(kilometrosCorridos, 742_000),
        alertThresholdMeters: UMBRAL,
        isPrimary: true,
      },
      {
        userId,
        brand: 'Saucony',
        model: 'Endorphin Speed 4',
        distanceMeters: 96_000,
        alertThresholdMeters: 600_000,
        isPrimary: false,
      },
      {
        userId,
        brand: 'Nike',
        model: 'Pegasus 40',
        distanceMeters: 812_000,
        alertThresholdMeters: 800_000,
        isPrimary: false,
        retiredAt: enDias(-95),
      },
    ],
  });

  log('3 pares: una principal cerca del umbral, una de series y una retirada');
}

/**
 * Plan activo del corredor: media maraton, empezado hace cinco semanas.
 *
 * Las sesiones **anteriores a hoy** quedan completadas o saltadas y las que
 * vienen, pendientes. La semana en curso queda a medias a proposito: es el
 * estado que la pantalla de inicio tiene que saber pintar y el unico que no se
 * consigue con un plan recien creado ni con uno terminado.
 */
export async function sembrarPlanActivo(
  userId: string,
  workouts: { id: string; startedAt: Date }[],
) {
  titulo('Plan de entrenamiento');

  if ((await prisma.trainingPlan.count({ where: { userId } })) > 0) {
    log('el corredor ya tiene un plan');
    return;
  }

  const plantilla = await prisma.trainingPlanTemplate.findUnique({
    where: { slug: '21k-principiante-12-semanas' },
    include: { sessions: { orderBy: [{ week: 'asc' }, { weekday: 'asc' }] } },
  });

  if (!plantilla) {
    log('falta la plantilla de 21K; se omite el plan');
    return;
  }

  const lunesInicial = lunesDe(enDias(-35));
  const semanas = Array.from({ length: plantilla.totalWeeks }, (_, i) => i + 1);
  const materializadas = materializar(plantilla.sessions, semanas, lunesInicial);

  // Ritmo de referencia del corredor. En la app sale de Riegel sobre su mejor
  // esfuerzo reciente; aqui se fija a un valor coherente con los
  // entrenamientos sembrados para que los rangos de cada sesion cuadren.
  const paceBasisSecPerKm = 300;
  const hoy = new Date();

  const plan = await prisma.trainingPlan.create({
    data: {
      userId,
      templateId: plantilla.id,
      name: plantilla.name,
      totalWeeks: plantilla.totalWeeks,
      startDate: lunesInicial,
      endDate: sumarDias(lunesInicial, plantilla.totalWeeks * 7 - 1),
      paceBasisSecPerKm,
      status: 'active',
      isActive: true,
    },
  });

  let completadas = 0;

  for (const [i, s] of materializadas.entries()) {
    const pasada = s.scheduledDate.getTime() < hoy.getTime();
    // Una de cada siete pasadas queda saltada: un plan con el 100% cumplido no
    // existe, y la pantalla de progreso tiene que saber pintar el hueco.
    const saltada = pasada && i % 7 === 6;
    const status: TrainingPlanSessionStatus = !pasada
      ? 'pending'
      : saltada
        ? 'skipped'
        : 'completed';

    // La sesion cumplida se cuelga del entrenamiento de ese dia, si lo hubo.
    const workout =
      status === 'completed'
        ? workouts.find(
            (w) =>
              w.startedAt.toISOString().slice(0, 10) === s.scheduledDate.toISOString().slice(0, 10),
          )
        : undefined;

    if (status === 'completed') completadas += 1;

    await prisma.trainingPlanSession.create({
      data: {
        planId: plan.id,
        templateSessionId: s.plantilla.id,
        week: s.week,
        weekday: s.weekday,
        scheduledDate: s.scheduledDate,
        type: s.plantilla.type,
        targetDistanceMeters: s.plantilla.targetDistanceMeters,
        targetDurationSeconds: s.plantilla.targetDurationSeconds,
        ...(s.plantilla.type === 'rest'
          ? {}
          : rangoRitmo(paceBasisSecPerKm, s.plantilla.paceFactor)),
        status,
        workoutId: workout?.id ?? null,
      },
    });
  }

  const semanaEnCurso = Math.floor((hoy.getTime() - lunesInicial.getTime()) / (7 * 86_400_000)) + 1;

  log(
    `${plantilla.name}: semana ${semanaEnCurso} de ${plantilla.totalWeeks}, ` +
      `${completadas}/${materializadas.length} sesiones completadas`,
  );
}
