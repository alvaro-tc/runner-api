/// Agregados del resumen del admin. Puro a proposito: se prueba sin BD.

export interface FilaPagada {
  paidAt: Date | null;
  amountCents: number;
}

export interface FilaInscrita {
  personalData: unknown;
  category: string | null;
  birthDate: Date | null;
}

const ZONA = 'America/La_Paz';
const RANGOS: [string, number][] = [
  ['<18', 18],
  ['18-29', 30],
  ['30-39', 40],
  ['40-49', 50],
  ['50-59', 60],
  ['60+', Infinity],
];

/// YYYY-MM-DD en hora de La Paz: un pago de las 23:00 cuenta para ese dia, no el siguiente en UTC.
const dia = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: ZONA });

function contar<T>(items: T[], clave: (x: T) => string) {
  const out: Record<string, number> = {};
  for (const x of items) {
    const k = clave(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function siNo(personalData: unknown, campo: string): 'si' | 'no' | 'sin_dato' {
  const v =
    personalData && typeof personalData === 'object'
      ? (personalData as Record<string, unknown>)[campo]
      : undefined;
  return v === true ? 'si' : v === false ? 'no' : 'sin_dato';
}

function edad(nacimiento: Date, a: Date) {
  let e = a.getUTCFullYear() - nacimiento.getUTCFullYear();
  const m = a.getUTCMonth() - nacimiento.getUTCMonth();
  if (m < 0 || (m === 0 && a.getUTCDate() < nacimiento.getUTCDate())) e--;
  return e;
}

/// Serie diaria continua (sin huecos) desde el primer cobro hasta hoy, maximo `maxDias`.
export function serieDiaria(pagos: FilaPagada[], hoy: Date, maxDias = 60) {
  const porDia = new Map<string, { confirmed: number; revenueCents: number }>();
  for (const p of pagos) {
    if (!p.paidAt) continue;
    const k = dia(p.paidAt);
    const v = porDia.get(k) ?? { confirmed: 0, revenueCents: 0 };
    v.confirmed++;
    v.revenueCents += p.amountCents;
    porDia.set(k, v);
  }
  const primero = [...porDia.keys()].sort()[0];
  const fin = dia(hoy);
  // Mediodia UTC: sumar dias nunca cruza de fecha por la zona.
  const cursor = new Date(`${primero ?? fin}T12:00:00Z`);
  const tope = new Date(`${fin}T12:00:00Z`);
  const desde = new Date(tope.getTime() - (maxDias - 1) * 864e5);
  if (cursor < desde) cursor.setTime(desde.getTime());
  const out: { date: string; confirmed: number; revenueCents: number }[] = [];
  for (; cursor <= tope; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const k = cursor.toISOString().slice(0, 10);
    out.push({ date: k, ...(porDia.get(k) ?? { confirmed: 0, revenueCents: 0 }) });
  }
  return out;
}

export function perfilInscritas(filas: FilaInscrita[], largada: Date) {
  return {
    knowsCam: contar(filas, (f) => siNo(f.personalData, 'knowsCam')),
    acceptsDonorCall: contar(filas, (f) => siNo(f.personalData, 'acceptsDonorCall')),
    categories: contar(filas, (f) => f.category ?? 'Sin categoría'),
    ages: contar(filas, (f) =>
      f.birthDate ? RANGOS.find(([, max]) => edad(f.birthDate!, largada) < max)![0] : 'sin_dato',
    ),
  };
}
