import { aMultiplo, log, prisma, titulo } from './comun';
import type { PlanLevel, TrainingSessionType } from '../../generated/prisma/enums';

/** Una sesion dentro de la semana tipo de una plantilla. */
interface PatronSesion {
  /** 1 = lunes ... 7 = domingo (ISO-8601). */
  weekday: number;
  type: TrainingSessionType;
  /** Que fraccion del volumen de la semana se lleva esta sesion. Suman 1. */
  parte: number;
  description: string;
}

interface SemillaPlantilla {
  slug: string;
  name: string;
  description: string;
  goalDistanceMeters: number;
  level: PlanLevel;
  totalWeeks: number;
  avgWeeklyDistanceMeters: number;
  patron: PatronSesion[];
}

/**
 * Ritmo de cada tipo de sesion como multiplicador del ritmo base del corredor.
 *
 * Es el mecanismo que hace que una sola plantilla sirva para cualquier nivel: la
 * plantilla no dice "corre a 5:30", dice "corre un 15% mas lento que tu ritmo de
 * referencia", y `TrainingPlanInstantiationService` lo resuelve contra el ritmo
 * real de cada usuario (Riegel sobre su mejor esfuerzo reciente).
 */
const RITMO: Record<string, number> = {
  recovery: 1.24,
  easy: 1.15,
  long: 1.12,
  tempo: 0.96,
  intervals: 0.88,
  rest: 1,
};

/** Las que no conviene saltarse: la larga y la de calidad. */
const CLAVE: TrainingSessionType[] = ['long', 'tempo', 'intervals'];

const TRES_POR_SEMANA: PatronSesion[] = [
  { weekday: 2, type: 'easy', parte: 0.25, description: 'Rodaje suave, conversando' },
  { weekday: 4, type: 'tempo', parte: 0.25, description: 'Ritmo controlado, algo incomodo' },
  { weekday: 7, type: 'long', parte: 0.5, description: 'Tirada larga a ritmo comodo' },
];

const CUATRO_POR_SEMANA: PatronSesion[] = [
  { weekday: 2, type: 'easy', parte: 0.2, description: 'Rodaje suave' },
  { weekday: 3, type: 'tempo', parte: 0.22, description: 'Bloque a ritmo de umbral' },
  { weekday: 5, type: 'recovery', parte: 0.13, description: 'Trote de recuperacion, muy lento' },
  { weekday: 7, type: 'long', parte: 0.45, description: 'Tirada larga a ritmo comodo' },
];

const CINCO_POR_SEMANA: PatronSesion[] = [
  { weekday: 2, type: 'easy', parte: 0.18, description: 'Rodaje suave' },
  { weekday: 3, type: 'intervals', parte: 0.16, description: 'Series cortas con recuperacion' },
  { weekday: 4, type: 'easy', parte: 0.15, description: 'Rodaje suave' },
  { weekday: 6, type: 'tempo', parte: 0.11, description: 'Bloque a ritmo de umbral' },
  { weekday: 7, type: 'long', parte: 0.4, description: 'Tirada larga a ritmo comodo' },
];

/**
 * Ocho plantillas: 5K / 10K / 21K / 42K por principiante e intermedio.
 *
 * Las semanas van de 8 a 16 y las sesiones de 3 a 5, creciendo con la distancia
 * objetivo y con el nivel. No hay plantillas `advanced`: quien entrena a ese
 * nivel sigue un plan de su entrenador, no uno de catalogo.
 */
export const PLANTILLAS: SemillaPlantilla[] = [
  {
    slug: '5k-principiante-8-semanas',
    name: '5K para empezar',
    description:
      'Ocho semanas para completar tus primeros 5K corriendo sin parar. Tres salidas por semana, ' +
      'y solo la del domingo pasa de la media hora.',
    goalDistanceMeters: 5000,
    level: 'beginner',
    totalWeeks: 8,
    avgWeeklyDistanceMeters: 15_000,
    patron: TRES_POR_SEMANA,
  },
  {
    slug: '5k-intermedio-8-semanas',
    name: '5K por marca',
    description:
      'Ocho semanas para bajar tu tiempo en 5K. Cuatro salidas por semana con series y un bloque ' +
      'de umbral: asume que ya corres 5K de corrido.',
    goalDistanceMeters: 5000,
    level: 'intermediate',
    totalWeeks: 8,
    avgWeeklyDistanceMeters: 28_000,
    patron: CUATRO_POR_SEMANA,
  },
  {
    slug: '10k-principiante-10-semanas',
    name: '10K para empezar',
    description:
      'Diez semanas de 5K a 10K. Tres salidas por semana, subiendo la tirada larga poco a poco.',
    goalDistanceMeters: 10_000,
    level: 'beginner',
    totalWeeks: 10,
    avgWeeklyDistanceMeters: 22_000,
    patron: TRES_POR_SEMANA,
  },
  {
    slug: '10k-intermedio-10-semanas',
    name: '10K por marca',
    description:
      'Diez semanas para correr 10K mas rapido. Cuatro salidas por semana con trabajo de umbral ' +
      'y tiradas de hasta 12K.',
    goalDistanceMeters: 10_000,
    level: 'intermediate',
    totalWeeks: 10,
    avgWeeklyDistanceMeters: 38_000,
    patron: CUATRO_POR_SEMANA,
  },
  {
    slug: '21k-principiante-12-semanas',
    name: 'Media maraton para terminarla',
    description:
      'Doce semanas para completar tus primeros 21K. Cuatro salidas por semana y una larga que ' +
      'llega a 21K antes del afinamiento.',
    goalDistanceMeters: 21_097,
    level: 'beginner',
    totalWeeks: 12,
    avgWeeklyDistanceMeters: 35_000,
    patron: CUATRO_POR_SEMANA,
  },
  {
    slug: '21k-intermedio-12-semanas',
    name: 'Media maraton por marca',
    description:
      'Doce semanas para atacar tu mejor tiempo en 21K. Cinco salidas por semana, series y ' +
      'largas a ritmo de carrera.',
    goalDistanceMeters: 21_097,
    level: 'intermediate',
    totalWeeks: 12,
    avgWeeklyDistanceMeters: 52_000,
    patron: CINCO_POR_SEMANA,
  },
  {
    slug: '42k-principiante-16-semanas',
    name: 'Maraton para terminarla',
    description:
      'Dieciseis semanas para cruzar tu primera meta de 42K. El objetivo es llegar, no el ' +
      'tiempo: cuatro salidas por semana y largas de hasta 27K.',
    goalDistanceMeters: 42_195,
    level: 'beginner',
    totalWeeks: 16,
    avgWeeklyDistanceMeters: 45_000,
    patron: CUATRO_POR_SEMANA,
  },
  {
    slug: '42k-intermedio-16-semanas',
    name: 'Maraton por marca',
    description:
      'Dieciseis semanas de volumen alto para correr 42K por tiempo. Cinco salidas por semana y ' +
      'largas con tramos a ritmo de carrera.',
    goalDistanceMeters: 42_195,
    level: 'intermediate',
    totalWeeks: 16,
    avgWeeklyDistanceMeters: 65_000,
    patron: CINCO_POR_SEMANA,
  },
];

/**
 * Cuanto volumen lleva cada semana, como multiplo del promedio de la plantilla.
 *
 * Tres reglas, y ninguna es decorativa:
 *
 * - **Rampa** del 78% al 120%: la carga sube, que es de lo que se trata.
 * - **Semana de descarga** cada cuatro: la adaptacion ocurre en el descanso, y
 *   un plan que solo sube produce lesionados, no maratonistas.
 * - **Afinamiento** en las dos ultimas: se baja al 65% y al 45%. Esas dos
 *   semanas son las que `TrainingPlanInstantiationService` protege cuando tiene
 *   que recortar el plan — recorta del medio, nunca de aqui.
 */
export function factorSemanal(week: number, totalWeeks: number): number {
  const semanasDeCarga = totalWeeks - 2;

  if (week > semanasDeCarga) return week === totalWeeks ? 0.45 : 0.65;

  const rampa = 0.78 + (0.42 * (week - 1)) / Math.max(1, semanasDeCarga - 1);

  return week % 4 === 0 ? rampa * 0.75 : rampa;
}

/**
 * Techo de la tirada larga. Nadie entrena la maraton corriendo 42K: se llega a
 * ~30K y el resto lo pone el dia de la carrera. En distancias cortas, en cambio,
 * la larga si pasa del objetivo — un plan de 10K con largas de 14K es normal.
 */
function techoDeLarga(goalDistanceMeters: number): number {
  // Maraton: se llega a 30K y el resto lo pone el dia de la carrera.
  if (goalDistanceMeters >= 42_195) return 30_000;
  // Media: la larga llega justo a la distancia, nunca la pasa.
  if (goalDistanceMeters >= 21_097) return goalDistanceMeters;

  // 5K y 10K: aqui el limite no lo pone la carrera sino el corredor. Un 20% por
  // encima del objetivo con suelo de 10 km — en un plan de 5K la larga es de
  // 10, no de 6.
  return Math.max(Math.round(goalDistanceMeters * 1.2), 10_000);
}

/**
 * Reparte el volumen de una semana entre sus sesiones, respetando el techo de
 * la larga.
 *
 * Lo que la larga no puede absorber **se reparte entre las demas**, no se
 * pierde. Si se descartara, un plan de 5K con 28 km semanales entregaria 22:
 * el techo de la larga terminaria recortando el volumen total, que es una
 * decision que nadie tomo.
 */
function repartir(volumen: number, patron: PatronSesion[], techo: number): number[] {
  let sobrante = 0;

  const crudas = patron.map((s) => {
    const bruta = volumen * s.parte;
    if (s.type !== 'long') return bruta;

    sobrante += Math.max(0, bruta - techo);

    return Math.min(bruta, techo);
  });

  if (sobrante === 0) return crudas;

  const parteDelResto = patron.reduce((a, s) => a + (s.type === 'long' ? 0 : s.parte), 0);

  return crudas.map((d, i) =>
    patron[i]!.type === 'long' ? d : d + (sobrante * patron[i]!.parte) / parteDelResto,
  );
}

/**
 * Normaliza los factores para que su media sea exactamente 1.
 *
 * Sin esto, el afinamiento y las semanas de descarga arrastran la media a ~0.83
 * y el plan entrega un 17% menos de kilometros de los que anuncia el catalogo.
 * El corredor elige la plantilla POR ese numero: si dice 38 km por semana y
 * entrega 30, el catalogo miente. Se normaliza la forma de la curva, que es lo
 * que importa, y el nivel lo fija `avgWeeklyDistanceMeters`.
 */
function factoresNormalizados(totalWeeks: number): number[] {
  const crudos = Array.from({ length: totalWeeks }, (_, i) => factorSemanal(i + 1, totalWeeks));
  const media = crudos.reduce((a, f) => a + f, 0) / totalWeeks;

  return crudos.map((f) => f / media);
}

/** Una fila de `training_plan_template_sessions`, lista para insertar. */
interface SesionGenerada {
  week: number;
  weekday: number;
  type: TrainingSessionType;
  targetDistanceMeters: number;
  paceFactor: number;
  description: string;
  isKeySession: boolean;
}

/** Las sesiones de una plantilla, semana a semana. Funcion pura: se puede probar. */
export function sesionesDe(plantilla: SemillaPlantilla): SesionGenerada[] {
  const techo = techoDeLarga(plantilla.goalDistanceMeters);
  const factores = factoresNormalizados(plantilla.totalWeeks);
  const sesiones: SesionGenerada[] = [];

  for (let week = 1; week <= plantilla.totalWeeks; week++) {
    const volumen = plantilla.avgWeeklyDistanceMeters * factores[week - 1]!;

    const repartidas = repartir(volumen, plantilla.patron, techo);

    plantilla.patron.forEach((s, i) => {
      const distancia = aMultiplo(repartidas[i]!, 500);

      sesiones.push({
        week,
        weekday: s.weekday,
        type: s.type,
        // Minimo de 2 km: una sesion de 1,5 km en la semana de descarga no es
        // un entrenamiento, es un paseo, y ensucia el resumen semanal.
        targetDistanceMeters: Math.max(distancia, 2000),
        paceFactor: RITMO[s.type] ?? 1,
        description: s.description,
        isKeySession: CLAVE.includes(s.type),
      });
    });
  }

  return sesiones;
}

/** Idempotente por `slug`. */
export async function sembrarPlantillas(): Promise<void> {
  titulo('Plantillas de plan');

  for (const plantilla of PLANTILLAS) {
    const existente = await prisma.trainingPlanTemplate.findUnique({
      where: { slug: plantilla.slug },
    });

    if (existente) {
      log(`${plantilla.slug} ya existe`);
      continue;
    }

    const { patron, ...datos } = plantilla;
    const sesiones = sesionesDe(plantilla);

    await prisma.trainingPlanTemplate.create({
      data: {
        ...datos,
        weeklySessions: patron.length,
        sessions: { create: sesiones },
      },
    });

    log(`${plantilla.slug} creada (${plantilla.totalWeeks} semanas, ${sesiones.length} sesiones)`);
  }
}
