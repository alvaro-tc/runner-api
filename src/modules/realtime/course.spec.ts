import {
  avanzar,
  avanceEnCircuito,
  haLlegado,
  pistaInicial,
  prepararRecorrido,
  validarRecorrido,
  type Pista,
  type PuntoRuta,
  type Recorrido,
} from './course';

/** Metros por grado, los mismos que usa el modulo. */
const M_POR_GRADO = 111_320;

/** Una recta hacia el norte desde (0,0), de `largoM` metros. */
function recta(largoM: number, pasoM = 50): [number, number][] {
  const coords: [number, number][] = [];
  for (let d = 0; d <= largoM; d += pasoM) coords.push([0, d / M_POR_GRADO]);
  return coords;
}

/** Ida hasta `largoM` y vuelta al punto de partida: el caso dificil. */
function idaYVuelta(largoM: number, pasoM = 50): [number, number][] {
  const ida = recta(largoM, pasoM);
  return [...ida, ...[...ida].reverse().slice(1)];
}

const enMetro = (d: number, desvioM = 0): PuntoRuta => ({
  lat: d / M_POR_GRADO,
  lng: desvioM / M_POR_GRADO,
});

const preparar = (coords: [number, number][], laps = 1): Recorrido => {
  const r = prepararRecorrido({ type: 'LineString', coordinates: coords }, laps);
  if (!r) throw new Error('recorrido invalido');
  return r;
};

const T0 = new Date('2026-11-01T07:00:00Z');

/** Ruido determinista: el mismo "GPS malo" en cada corrida del test. */
function ruido(i: number, amplitudM: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amplitudM;
}

/**
 * Un corredor que avanza `totalM` metros a `mps`, mandando un punto cada
 * `cadaS` segundos. `posicion` traduce metros corridos a metro sobre el eje.
 */
function correr(
  posicion: (m: number) => number,
  totalM: number,
  { mps = 3.5, cadaS = 15, ruidoM = 0, precision = 10 } = {},
): PuntoRuta[] {
  const puntos: PuntoRuta[] = [];
  for (let s = 0, i = 0; s * mps <= totalM + mps * cadaS; s += cadaS, i++) {
    const m = Math.min(totalM, s * mps);
    puntos.push({
      ...enMetro(posicion(m) + ruido(i, ruidoM), ruido(i + 7, ruidoM)),
      recordedAt: new Date(T0.getTime() + s * 1000),
      accuracyMeters: precision,
    });
  }
  return puntos;
}

/** Donde esta, sobre el eje, quien lleva `m` metros en un circuito de ida y vuelta. */
const enCircuito = (pierna: number) => (m: number) => {
  const enVuelta = m % (2 * pierna);
  return enVuelta <= pierna ? enVuelta : 2 * pierna - enVuelta;
};

describe('prepararRecorrido', () => {
  it('mide el largo de la linea', () => {
    expect(preparar(recta(1000)).total).toBeCloseTo(1000, 0);
  });

  it('pone las vueltas una tras otra', () => {
    const r = preparar(idaYVuelta(500), 3);
    expect(r.vuelta).toBeCloseTo(1000, 0);
    expect(r.total).toBeCloseTo(3000, 0);
  });

  it('devuelve null sin trazado utilizable', () => {
    expect(prepararRecorrido(null)).toBeNull();
    expect(prepararRecorrido({ type: 'LineString', coordinates: [[0, 0]] })).toBeNull();
  });
});

describe('avanzar', () => {
  const r = preparar(recta(1000));
  const en = (p: number): Pista => ({ ...pistaInicial(), progresoM: p });

  it('sigue al corredor a lo largo de la linea', () => {
    let p = pistaInicial();
    for (const metro of [100, 200, 300]) p = avanzar(r, p, enMetro(metro));
    expect(p.progresoM).toBeCloseTo(300, 0);
  });

  it('aguanta el ruido lateral del GPS', () => {
    expect(avanzar(r, en(100), enMetro(150, 25)).progresoM).toBeCloseTo(150, 0);
  });

  it('con mala precision tolera mas desvio, hasta un tope', () => {
    expect(avanzar(r, en(100), { ...enMetro(150, 90), accuracyMeters: 70 }).progresoM).toBeCloseTo(150, 0);
    expect(avanzar(r, en(100), { ...enMetro(150, 90), accuracyMeters: 10 }).progresoM).toBe(100);
  });

  it('ignora puntos con precision inservible', () => {
    expect(avanzar(r, en(100), { ...enMetro(150), accuracyMeters: 250 }).progresoM).toBe(100);
  });

  it('no retrocede por un punto ruidoso hacia atras', () => {
    expect(avanzar(r, en(300), enMetro(280)).progresoM).toBeCloseTo(300, 0);
  });

  it('no avanza si el corredor se salio de la ruta', () => {
    expect(avanzar(r, en(200), enMetro(400, 300)).progresoM).toBe(200);
  });

  it('no teletransporta a quien aparece lejos sin tiempo para llegar', () => {
    const pista = { progresoM: 100, t: T0.getTime(), ancla: enMetro(100) };
    const salto = { ...enMetro(950), recordedAt: new Date(T0.getTime() + 20_000) };
    expect(avanzar(r, pista, salto).progresoM).toBe(100);
  });

  it('tras un hueco de senal largo retoma al corredor donde reaparece', () => {
    // Tunel: dos minutos y medio sin puntos, 700 m mas adelante.
    const pista = { progresoM: 100, t: T0.getTime(), ancla: enMetro(100) };
    const vuelve = { ...enMetro(800), recordedAt: new Date(T0.getTime() + 150_000) };
    expect(avanzar(r, pista, vuelve).progresoM).toBeCloseTo(800, 0);
  });
});

describe('ida y vuelta', () => {
  const r = preparar(idaYVuelta(1000));

  it('quien se da la vuelta antes de tiempo no llega', () => {
    let p = pistaInicial();
    for (const metro of [200, 400, 600, 700, 500, 300, 100, 0]) p = avanzar(r, p, enMetro(metro));
    expect(p.progresoM).toBeLessThan(1000);
    expect(haLlegado(r, p, enMetro(0))).toBe(false);
  });

  it('quien hace el recorrido entero llega', () => {
    let p = pistaInicial();
    for (let metro = 0; metro <= 1000; metro += 100) p = avanzar(r, p, enMetro(metro));
    for (let metro = 900; metro >= 0; metro -= 100) p = avanzar(r, p, enMetro(metro));
    expect(haLlegado(r, p, enMetro(0))).toBe(true);
  });

  it('estar junto a la meta no basta: cuenta el trazado cubierto', () => {
    expect(haLlegado(r, { ...pistaInicial(), progresoM: 50 }, enMetro(0))).toBe(false);
  });
});

describe('circuito de 3 vueltas', () => {
  // 1 km por vuelta: ida de 500 m y vuelta al mismo arco. Se pasa 3 veces por la meta.
  const r = preparar(idaYVuelta(500), 3);
  const vuelta = enCircuito(500);

  it('pasar por el arco al cerrar la 1.a y la 2.a vuelta no es llegar', () => {
    const avance = avanceEnCircuito(r, pistaInicial(T0), correr(vuelta, 2000));
    expect(avance.llego).toBe(false);
    expect(avance.vueltas).toBe(2);
  });

  it('llega al cerrar la 3.a vuelta', () => {
    const avance = avanceEnCircuito(r, pistaInicial(T0), correr(vuelta, 3000));
    expect(avance.llego).toBe(true);
    expect(avance.vueltas).toBe(3);
  });

  it('con GPS ruidoso (±35 m) y puntos cada 30 s tambien completa', () => {
    const v = validarRecorrido(r, correr(vuelta, 3000, { cadaS: 30, ruidoM: 35, precision: 40 }), T0);
    expect(v.completo).toBe(true);
    expect(v.vueltas).toBe(3);
  });

  it('aunque ningun punto caiga bajo el arco entre vuelta y vuelta', () => {
    // Cada 45 s a 3,5 m/s: puntos a ~160 m, el arco casi nunca queda a < 60 m.
    expect(validarRecorrido(r, correr(vuelta, 3000, { cadaS: 45 }), T0).completo).toBe(true);
  });

  it('quien da solo 2 vueltas no completa', () => {
    const v = validarRecorrido(r, correr(vuelta, 2000), T0);
    expect(v.llego).toBe(false);
    expect(v.completo).toBe(false);
    expect(v.vueltas).toBe(2);
  });

  it('quedarse parado en el arco con el GPS rebotando no suma vueltas', () => {
    const quieto: PuntoRuta[] = Array.from({ length: 120 }, (_, i) => ({
      ...enMetro(Math.abs(ruido(i, 30)), ruido(i + 3, 30)),
      recordedAt: new Date(T0.getTime() + i * 10_000),
      accuracyMeters: 30,
    }));
    const v = validarRecorrido(r, quieto, T0);
    expect(v.vueltas).toBe(0);
    expect(v.llego).toBe(false);
  });

  it('la hora de llegada es la del cruce, no la del ultimo punto', () => {
    const puntos = correr(vuelta, 3000);
    const ultimo = puntos.at(-1)!.recordedAt!.getTime();
    // Sigue mandando puntos diez minutos despues de cruzar.
    const despues = Array.from({ length: 20 }, (_, i) => ({
      ...enMetro(0, 20),
      recordedAt: new Date(ultimo + (i + 1) * 30_000),
    }));
    const v = validarRecorrido(r, [...puntos, ...despues], T0);
    expect(v.llegadaAt!.getTime()).toBeLessThanOrEqual(ultimo);
  });
});

describe('cobertura', () => {
  const r = preparar(recta(5000));
  const metroDe = (p: PuntoRuta) => p.lat * M_POR_GRADO;

  it('un corte de senal corto no invalida la carrera', () => {
    const puntos = correr((m) => m, 5000).filter((p) => metroDe(p) < 2000 || metroDe(p) > 2600);
    expect(validarRecorrido(r, puntos, T0).completo).toBe(true);
  });

  it('quien apaga el GPS media carrera llega pero no completa', () => {
    const puntos = correr((m) => m, 5000).filter((p) => metroDe(p) < 1000 || metroDe(p) > 4000);
    const v = validarRecorrido(r, puntos, T0);
    expect(v.llego).toBe(true);
    expect(v.cobertura).toBeLessThan(0.8);
    expect(v.completo).toBe(false);
  });
});
