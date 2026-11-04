/**
 * Puestos de una maraton, sin base de datos de por medio.
 *
 * Reglas, en este orden:
 *  1. Quien **llego a la meta** va delante de quien no: un corredor que se
 *     retiro en el km 8 tiene un "tiempo" cortisimo y no puede ganar la carrera.
 *  2. Dentro de cada grupo, por tiempo oficial y luego por hora de llegada.
 *  3. Los empates comparten puesto y el siguiente salta (3, 3, 5).
 *  4. Un puesto manual (lo fijo el organizador) se respeta y reserva su lugar;
 *     los demas ocupan los huecos libres.
 *  5. El puesto por categoria sigue el orden **general final**, manuales
 *     incluidos: si el organizador corrige el general, la categoria lo acompana.
 */
export interface FilaPuesto {
  id: string;
  finishTimeSeconds: number;
  finishedAt: Date;
  manualOverallRank: number | null;
  categoryId: string | null;
  llego: boolean;
}

export interface Puesto {
  overallRank: number;
  categoryRank: number | null;
}

export function calcularPuestos(filas: readonly FilaPuesto[]): Map<string, Puesto> {
  const orden = [...filas].sort(
    (a, b) =>
      Number(b.llego) - Number(a.llego) ||
      a.finishTimeSeconds - b.finishTimeSeconds ||
      a.finishedAt.getTime() - b.finishedAt.getTime(),
  );

  const reservados = orden.flatMap((r) => (r.manualOverallRank === null ? [] : [r.manualOverallRank]));
  const general = new Map<string, number>();
  let vistos = 0;
  let puesto = 0;
  let ultimo: string | null = null;

  for (const r of orden) {
    if (r.manualOverallRank !== null) {
      general.set(r.id, r.manualOverallRank);
      continue;
    }
    vistos += 1;
    const clave = `${r.llego}:${r.finishTimeSeconds}`;
    if (clave !== ultimo) {
      // El primer lugar >= `vistos` que no este reservado por un manual.
      puesto = vistos;
      for (;;) {
        const siguiente = vistos + reservados.filter((x) => x <= puesto).length;
        if (siguiente === puesto) break;
        puesto = siguiente;
      }
      ultimo = clave;
    }
    general.set(r.id, puesto);
  }

  const porGeneral = orden
    .map((r, i) => ({ r, i, puesto: general.get(r.id)! }))
    .sort((a, b) => a.puesto - b.puesto || a.i - b.i);
  const categorias = new Map<string, { vistos: number; puesto: number; ultimo: number }>();
  const salida = new Map<string, Puesto>();

  for (const { r, puesto: overallRank } of porGeneral) {
    let categoryRank: number | null = null;
    if (r.categoryId !== null) {
      const c = categorias.get(r.categoryId) ?? { vistos: 0, puesto: 0, ultimo: -1 };
      categorias.set(r.categoryId, c);
      c.vistos += 1;
      if (overallRank !== c.ultimo) {
        c.puesto = c.vistos;
        c.ultimo = overallRank;
      }
      categoryRank = c.puesto;
    }
    salida.set(r.id, { overallRank, categoryRank });
  }

  return salida;
}
