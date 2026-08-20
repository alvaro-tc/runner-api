/**
 * Semanas Lunes–Domingo en una zona horaria concreta.
 *
 * La app pinta una tira Mon–Sun y suma "lo que corri esta semana". Calcularlo
 * en UTC da resultados falsos donde la app se usa: en La Paz (UTC-4) toda
 * carrera de domingo despues de las 20:00 locales cae en lunes UTC y se suma a
 * la semana equivocada. Asi que las fronteras se calculan en la zona del
 * usuario y se devuelven como instantes UTC, que es lo que entiende Postgres.
 */

interface PartesLocales {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMATOS = new Map<string, Intl.DateTimeFormat>();

function formateador(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATOS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATOS.set(timeZone, fmt);
  }
  return fmt;
}

/** Descompone un instante en las partes del reloj de pared de esa zona. */
function partesEn(at: Date, timeZone: string): PartesLocales {
  const partes = formateador(timeZone).formatToParts(at);
  const leer = (tipo: Intl.DateTimeFormatPartTypes): number =>
    Number(partes.find((p) => p.type === tipo)?.value ?? 0);

  return {
    year: leer('year'),
    month: leer('month'),
    day: leer('day'),
    hour: leer('hour'),
    minute: leer('minute'),
    second: leer('second'),
  };
}

/**
 * Milisegundos que el reloj local va por delante de UTC en ese instante.
 * En La Paz siempre −4 h; se calcula igual porque Bolivia no tiene horario de
 * verano pero el codigo no deberia depender de eso.
 */
function desfaseMs(at: Date, timeZone: string): number {
  const p = partesEn(at, timeZone);
  const comoSiFueraUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `at` con los milisegundos a cero: `formatToParts` no los devuelve y sin
  // esto el desfase saldria con un resto de hasta 999 ms.
  return comoSiFueraUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export interface RangoSemana {
  /** Lunes 00:00 local, como instante UTC. Inclusivo. */
  start: Date;
  /** Lunes 00:00 local de la semana siguiente. **Exclusivo**. */
  end: Date;
}

/**
 * La semana Lunes–Domingo que contiene `at`, en `timeZone`.
 *
 * El limite superior es exclusivo a proposito: `endedAt < end` no tiene el
 * problema clasico de "las 23:59:59.999" que se come el ultimo milisegundo.
 */
export function rangoSemanal(at: Date, timeZone: string): RangoSemana {
  const desfase = desfaseMs(at, timeZone);
  const local = new Date(at.getTime() + desfase);

  // getUTCDay sobre la fecha ya desplazada = el dia de la semana local.
  // Domingo es 0 en JS; aqui la semana empieza el lunes, de ahi el +6 % 7.
  const diasDesdeLunes = (local.getUTCDay() + 6) % 7;

  const medianocheLunesLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - diasDesdeLunes,
  );

  // Se recalcula el desfase EN esa frontera: si hubiera cambio de horario entre
  // hoy y el lunes, el desfase de hoy daria una hora de error.
  const aproximado = new Date(medianocheLunesLocal - desfase);
  const start = new Date(medianocheLunesLocal - desfaseMs(aproximado, timeZone));

  const finLocal = medianocheLunesLocal + 7 * 24 * 60 * 60 * 1000;
  const finAproximado = new Date(finLocal - desfase);
  const end = new Date(finLocal - desfaseMs(finAproximado, timeZone));

  return { start, end };
}
