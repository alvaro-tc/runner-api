import {
  aPayload,
  acumular,
  debeEmitir,
  foto,
  nuevoEstado,
  podar,
  type EstadoCorredor,
  type PuntoLive,
} from './live-state';

/** Mismo radio que usa `haversine`: 25 m del test son 25 m de verdad. */
const METROS_POR_GRADO_LAT = 111_194.93;
const BASE = new Date('2026-08-19T10:00:00.000Z');

/** `n` puntos hacia el norte desde el ecuador, uno por segundo. */
function recta(n: number, metrosPorPunto: number, desdeIndice = 0): PuntoLive[] {
  return Array.from({ length: n }, (_, i) => ({
    recordedAt: new Date(BASE.getTime() + (desdeIndice + i) * 1000),
    lat: ((desdeIndice + i) * metrosPorPunto) / METROS_POR_GRADO_LAT,
    lng: 0,
  }));
}

describe('acumular', () => {
  it('suma la distancia del lote y guarda el último punto', () => {
    const estado = nuevoEstado('m1', 'A-001');
    const ultimo = acumular(estado, recta(11, 10));

    // Once puntos, diez tramos de 10 m.
    expect(estado.distanceMeters).toBeCloseTo(100, 0);
    expect(ultimo).toBe(estado.ultimoPunto);
  });

  it('encadena lotes sin perder el tramo entre ellos', () => {
    const estado = nuevoEstado('m1', 'A-001');
    acumular(estado, recta(11, 10));
    acumular(estado, recta(10, 10, 11));

    // 20 tramos de 10 m: el que une los dos lotes cuenta igual.
    expect(estado.distanceMeters).toBeCloseTo(200, 0);
  });

  it('no se cree el orden en que llega el lote', () => {
    const ordenado = nuevoEstado('m1', null);
    const desordenado = nuevoEstado('m1', null);

    const puntos = recta(11, 10);
    acumular(ordenado, puntos);
    acumular(desordenado, [...puntos].reverse());

    expect(desordenado.distanceMeters).toBeCloseTo(ordenado.distanceMeters, 0);
  });

  it('un lote vacío no rompe ni mueve nada', () => {
    const estado = nuevoEstado('m1', null);

    expect(acumular(estado, [])).toBeNull();
    expect(estado.distanceMeters).toBe(0);
  });
});

describe('debeEmitir', () => {
  const conUltimoEnvio = (ms: number): EstadoCorredor => ({
    ...nuevoEstado('m1', null),
    ultimoEnvioMs: ms,
  });

  it('deja pasar el primero', () => {
    expect(debeEmitir(nuevoEstado('m1', null), 1_000_000, 5000)).toBe(true);
  });

  it('corta lo que llega dentro de la ventana', () => {
    expect(debeEmitir(conUltimoEnvio(1_000_000), 1_003_000, 5000)).toBe(false);
  });

  it('vuelve a dejar pasar justo al cumplirse la ventana', () => {
    expect(debeEmitir(conUltimoEnvio(1_000_000), 1_005_000, 5000)).toBe(true);
  });
});

describe('podar', () => {
  it('tira lo que lleva demasiado sin tocarse y conserva lo vivo', () => {
    const ahora = Date.now();
    const estados = new Map<string, EstadoCorredor>([
      ['viejo', { ...nuevoEstado('m1', null), ultimoUsoMs: ahora - 8 * 60 * 60 * 1000 }],
      ['vivo', { ...nuevoEstado('m1', null), ultimoUsoMs: ahora - 1000 }],
    ]);

    expect(podar(estados, ahora, 6 * 60 * 60 * 1000)).toBe(1);
    expect([...estados.keys()]).toEqual(['vivo']);
  });
});

describe('aPayload', () => {
  it('lleva el dorsal y nada que identifique a la persona', () => {
    const estado = nuevoEstado('m1', 'A-042');
    const ultimo = acumular(estado, recta(11, 10))!;

    const payload = aPayload(estado, ultimo);

    expect(Object.keys(payload).sort()).toEqual(['bib', 'distanceMeters', 'lat', 'lng', 't']);
    expect(payload.bib).toBe('A-042');
    expect(payload.t).toBe(ultimo.recordedAt.toISOString());
    expect(payload.distanceMeters).toBe(100);
  });
});

describe('foto', () => {
  it('solo los de esa maraton, y solo los que ya mandaron algo', () => {
    const conPunto = nuevoEstado('m1', 'A-1');
    acumular(conPunto, recta(2, 10));
    const otra = nuevoEstado('m2', 'B-1');
    acumular(otra, recta(2, 10));

    const estados = new Map<string, EstadoCorredor>([
      ['s1', conPunto],
      ['s2', otra],
      // Sesion abierta que todavia no mando ni un punto: no tiene donde pintarse.
      ['s3', nuevoEstado('m1', 'A-2')],
    ]);

    expect(foto(estados, 'm1').map((p) => p.bib)).toEqual(['A-1']);
  });
});
