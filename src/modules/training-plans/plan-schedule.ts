/**
 * Del calendario de una plantilla al calendario real del usuario.
 *
 * Todo lo de aqui es funcion pura sobre fechas: sin Prisma, sin Nest y sin
 * `Date.now()`. Es la parte del modulo que decide en que dia cae cada sesion y
 * que semanas sobreviven cuando el plan no entra completo, o sea justo la que
 * conviene poder probar con una tabla de casos en vez de con una base de datos.
 *
 * Las fechas van y vienen como `Date` a medianoche UTC, que es lo que espera
 * una columna `@db.Date`: un dia de calendario, sin hora y sin zona.
 */

const DIA_MS = 86_400_000;

/** Ultimas semanas del plan. Son el afinamiento previo a la carrera. */
export const SEMANAS_TAPERING = 2;

/** Primera semana + tapering. Por debajo de esto no queda plan que instanciar. */
export const SEMANAS_MINIMAS = 1 + SEMANAS_TAPERING;

/** Margen del rango de ritmo alrededor del objetivo: +-4%. */
const MARGEN_RITMO = 0.04;

// ─── Aritmetica de dias ────────────────────────────────────────────────────

/**
 * El dia de calendario que era `at` en esa zona, como medianoche UTC.
 *
 * Una largada a las 06:00 de La Paz son las 10:00 UTC del mismo dia, pero una
 * a las 21:00 de un domingo ya es lunes en UTC. Anclar el plan a la fecha UTC
 * correria el plan entero una semana en ese caso.
 */
export function fechaLocal(at: Date, timeZone: string): Date {
  // 'en-CA' da directamente YYYY-MM-DD, que es lo unico que se necesita.
  return new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone }).format(at)}T00:00:00.000Z`);
}

export function sumarDias(fecha: Date, dias: number): Date {
  return new Date(fecha.getTime() + dias * DIA_MS);
}

/** Dia de la semana ISO: 1 = lunes ... 7 = domingo. */
export function diaIso(fecha: Date): number {
  return ((fecha.getUTCDay() + 6) % 7) + 1;
}

/** El lunes de esa semana (el mismo dia si ya es lunes). */
export function lunesDe(fecha: Date): Date {
  return sumarDias(fecha, -(diaIso(fecha) - 1));
}

/**
 * El lunes en que puede arrancar un plan pedido para `fecha`.
 *
 * Hacia adelante, no hacia atras: un plan que empieza "hoy miercoles" no puede
 * materializar la sesion del lunes pasado como pendiente.
 */
export function lunesDesde(fecha: Date): Date {
  const dia = diaIso(fecha);
  return dia === 1 ? fecha : sumarDias(fecha, 8 - dia);
}

/**
 * Semanas completas que caben entre `desde` y la semana de `hasta`, inclusive.
 *
 * Se cuenta por semanas y no por dias porque un plan se vive en semanas: si la
 * carrera es el domingo, esa semana cuenta entera aunque falten tres dias.
 */
export function semanasDisponibles(desde: Date, hasta: Date): number {
  const inicio = lunesDesde(desde);
  const ultima = lunesDe(hasta);
  return Math.floor((ultima.getTime() - inicio.getTime()) / (7 * DIA_MS)) + 1;
}

// ─── Recorte ───────────────────────────────────────────────────────────────

/**
 * Que semanas de la plantilla sobreviven cuando solo hay `disponibles`.
 *
 * Se recorta **desde el medio**: la primera semana marca el arranque y las dos
 * ultimas son el tapering, que es lo que hace llegar entero a la largada.
 * Sacrificar el tapering para conservar volumen es exactamente al reves de lo
 * que hay que hacer.
 *
 * Dentro del medio se van las semanas **mas tempranas**, que son las de base
 * general: quien tiene 8 semanas para un plan de 16 no necesita empezar por el
 * principio, necesita entrar donde el plan ya esta en carga.
 *
 * Devuelve `[]` si ni recortando todo el medio entra: el llamador lo traduce a
 * `PLAN_DOES_NOT_FIT`.
 */
export function semanasConservadas(totalWeeks: number, disponibles: number): number[] {
  const todas = Array.from({ length: totalWeeks }, (_, i) => i + 1);
  if (disponibles >= totalWeeks) return todas;
  if (disponibles < SEMANAS_MINIMAS) return [];

  const aRecortar = totalWeeks - disponibles;
  const base = todas.slice(1, totalWeeks - SEMANAS_TAPERING);
  if (aRecortar > base.length) return [];

  return [todas[0]!, ...base.slice(aRecortar), ...todas.slice(totalWeeks - SEMANAS_TAPERING)];
}

// ─── Ritmos ────────────────────────────────────────────────────────────────

export interface RangoRitmo {
  paceMinSecPerKm: number;
  paceMaxSecPerKm: number;
}

/**
 * El rango objetivo de una sesion: ritmo base x `paceFactor`, +-4%.
 *
 * `min` es el ritmo mas **rapido** del rango (menos segundos por km), que es lo
 * contrario de lo que sugiere el nombre si uno piensa en velocidad. Se llama
 * asi porque el cliente lo pinta como "4:50 - 5:15" y ahi el orden es numerico.
 */
export function rangoRitmo(paceBasisSecPerKm: number, paceFactor: number): RangoRitmo {
  const objetivo = paceBasisSecPerKm * paceFactor;
  return {
    paceMinSecPerKm: Math.round(objetivo * (1 - MARGEN_RITMO)),
    paceMaxSecPerKm: Math.round(objetivo * (1 + MARGEN_RITMO)),
  };
}

// ─── Materializacion ───────────────────────────────────────────────────────

/** Lo minimo que hace falta de una sesion de plantilla para ubicarla. */
export interface SesionPlantilla {
  week: number;
  weekday: number;
}

export interface SesionMaterializada<T extends SesionPlantilla> {
  plantilla: T;
  /** Semana dentro del plan del usuario, ya renumerada desde 1. */
  week: number;
  weekday: number;
  scheduledDate: Date;
}

/**
 * Ubica cada sesion de las semanas conservadas en su fecha real.
 *
 * Las semanas se **renumeran**: si se recorto de la 2 a la 5, la semana 6 de la
 * plantilla es la semana 2 del plan. El usuario ve "semana 2 de 8", no un salto
 * inexplicable en el numero.
 */
export function materializar<T extends SesionPlantilla>(
  sesiones: readonly T[],
  semanas: readonly number[],
  lunesInicial: Date,
): SesionMaterializada<T>[] {
  const posicion = new Map(semanas.map((semana, i) => [semana, i + 1]));

  return sesiones
    .filter((s) => posicion.has(s.week))
    .map((s) => {
      const week = posicion.get(s.week)!;
      return {
        plantilla: s,
        week,
        weekday: s.weekday,
        scheduledDate: sumarDias(lunesInicial, (week - 1) * 7 + (s.weekday - 1)),
      };
    })
    .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());
}
