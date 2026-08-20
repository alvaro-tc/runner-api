import { aCsv } from './csv';

interface Fila {
  nombre: string;
  dorsal: string | null;
  pagado: boolean;
  fecha: Date;
}

const COLUMNAS = [
  { header: 'Nombre', valor: (f: Fila) => f.nombre },
  { header: 'Dorsal', valor: (f: Fila) => f.dorsal },
  { header: 'Pagado', valor: (f: Fila) => f.pagado },
  { header: 'Fecha', valor: (f: Fila) => f.fecha },
];

const FECHA = new Date('2026-08-19T14:00:00.000Z');

/** El CSV sin el BOM, para poder comparar líneas a mano. */
function lineas(csv: string): string[] {
  return csv
    .replace(/^\ufeff/, '')
    .trimEnd()
    .split('\r\n');
}

describe('aCsv', () => {
  it('emite cabecera y filas, con BOM para que Excel lea los acentos', () => {
    const csv = aCsv([{ nombre: 'Ana', dorsal: 'A-1', pagado: true, fecha: FECHA }], COLUMNAS);

    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(lineas(csv)).toEqual([
      'Nombre,Dorsal,Pagado,Fecha',
      'Ana,A-1,true,2026-08-19T14:00:00.000Z',
    ]);
  });

  it('entrecomilla lo que llevaría comas o saltos de línea', () => {
    const csv = aCsv(
      [{ nombre: 'Quispe, Ana\nSegunda', dorsal: null, pagado: false, fecha: FECHA }],
      COLUMNAS,
    );

    expect(csv).toContain('"Quispe, Ana\nSegunda"');
  });

  it('duplica las comillas de dentro', () => {
    const csv = aCsv(
      [{ nombre: 'Ana "La Rápida"', dorsal: null, pagado: false, fecha: FECHA }],
      COLUMNAS,
    );

    expect(csv).toContain('"Ana ""La Rápida"""');
  });

  it('neutraliza las fórmulas: una celda no se ejecuta al abrir el archivo', () => {
    const csv = aCsv(
      [{ nombre: '=HYPERLINK("http://malo","clic")', dorsal: '+1', pagado: false, fecha: FECHA }],
      COLUMNAS,
    );

    expect(csv).toContain('"\'=HYPERLINK(');
    expect(csv).toContain("'+1");
  });

  it('deja la celda vacía ante null y undefined', () => {
    const csv = aCsv([{ nombre: '', dorsal: null, pagado: false, fecha: FECHA }], COLUMNAS);

    expect(lineas(csv)[1]!.startsWith(',,false,')).toBe(true);
  });

  it('sin filas devuelve solo la cabecera', () => {
    expect(lineas(aCsv([], COLUMNAS))).toEqual(['Nombre,Dorsal,Pagado,Fecha']);
  });
});
