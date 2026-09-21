import {
  avanzar,
  haCerradoVuelta,
  avanceEnCircuito,
  prepararRecorrido,
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

const enMetro = (d: number, desvioM = 0) => ({
  lat: d / M_POR_GRADO,
  lng: desvioM / M_POR_GRADO,
});

const prepararOFallar = (coords: [number, number][]): Recorrido => {
  const r = prepararRecorrido({ type: 'LineString', coordinates: coords });
  if (!r) throw new Error('recorrido invalido');
  return r;
};

describe('prepararRecorrido', () => {
  it('mide el largo de la linea', () => {
    const r = prepararOFallar(recta(1000));
    expect(r.total).toBeCloseTo(1000, 0);
  });

  it('devuelve null sin trazado utilizable', () => {
    expect(prepararRecorrido(null)).toBeNull();
    expect(prepararRecorrido({ type: 'LineString', coordinates: [[0, 0]] })).toBeNull();
  });
});

describe('avanzar', () => {
  const r = prepararOFallar(recta(1000));

  it('sigue al corredor a lo largo de la linea', () => {
    let p = 0;
    for (const metro of [100, 200, 300]) p = avanzar(r, p, enMetro(metro));
    expect(p).toBeCloseTo(300, 0);
  });

  it('aguanta el ruido lateral del GPS', () => {
    const p = avanzar(r, 100, enMetro(150, 25));
    expect(p).toBeCloseTo(150, 0);
  });

  it('no retrocede por un punto ruidoso hacia atras', () => {
    expect(avanzar(r, 300, enMetro(280))).toBeCloseTo(300, 0);
  });

  it('no avanza si el corredor se salio de la ruta', () => {
    // 300 m a un lado: eso ya no es error del sensor, es otra calle.
    expect(avanzar(r, 200, enMetro(400, 300))).toBe(200);
  });

  it('no teletransporta a quien aparece kilometros mas adelante', () => {
    // Un salto del GPS al final del recorrido no puede dar la carrera por hecha.
    expect(avanzar(r, 100, enMetro(950))).toBe(100);
  });
});

describe('ida y vuelta', () => {
  // 1 km de ida y 1 km de vuelta: la meta esta pegada a la salida.
  const r = prepararOFallar(idaYVuelta(1000));

  it('mide las dos piernas por separado', () => {
    expect(r.total).toBeCloseTo(2000, 0);
  });

  it('quien se da la vuelta antes de tiempo no llega', () => {
    let p = 0;
    // Ida hasta el 700 y vuelta al arco: 1.400 m corridos, pero solo 700 de
    // trazado cubierto, porque la pierna de vuelta empieza en el km 1.
    for (const metro of [200, 400, 600, 700, 500, 300, 100, 0]) {
      p = avanzar(r, p, enMetro(metro));
    }
    expect(p).toBeLessThan(1000);
    expect(haCerradoVuelta(r, p, enMetro(0))).toBe(false);
  });

  it('quien hace el recorrido entero llega', () => {
    let p = 0;
    for (let metro = 0; metro <= 1000; metro += 100) p = avanzar(r, p, enMetro(metro));
    for (let metro = 900; metro >= 0; metro -= 100) p = avanzar(r, p, enMetro(metro));

    expect(p).toBeCloseTo(2000, -1);
    expect(haCerradoVuelta(r, p, enMetro(0))).toBe(true);
  });

  it('estar junto a la meta no basta: cuenta el trazado cubierto', () => {
    // El corredor sigue en el arco de salida, que es tambien el de meta.
    expect(haCerradoVuelta(r, 50, enMetro(0))).toBe(false);
  });
});

describe('avanceEnCircuito', () => {
  // Un circuito de 1 km: ida de 500 m y vuelta al mismo arco. Salida y meta
  // son el mismo punto, que es lo que hace dificil contar las vueltas.
  const r = prepararOFallar(idaYVuelta(500));

  /** El corredor da una vuelta entera, punto a punto cada 100 m. */
  const unaVuelta = () => [
    ...[100, 200, 300, 400, 500].map((m) => enMetro(m)),
    ...[400, 300, 200, 100, 0].map((m) => enMetro(m)),
  ];

  it('con una sola vuelta se comporta como siempre', () => {
    const avance = avanceEnCircuito(r, { vueltas: 0, progresoM: 0 }, unaVuelta(), 1);
    expect(avance.llego).toBe(true);
    expect(avance.vueltas).toBe(1);
  });

  it('cerrar la primera vuelta de un circuito no es llegar', () => {
    const avance = avanceEnCircuito(r, { vueltas: 0, progresoM: 0 }, unaVuelta(), 5);
    expect(avance.llego).toBe(false);
    expect(avance.vueltas).toBe(1);
    // Y el progreso vuelve a cero: si no, no quedaria linea por delante que
    // cubrir y el corredor se quedaria clavado en la vuelta 1 para siempre.
    expect(avance.progresoM).toBe(0);
  });

  it('llega al cerrar la ultima vuelta, y no antes', () => {
    let estado = { vueltas: 0, progresoM: 0 };

    for (let vuelta = 1; vuelta <= 4; vuelta += 1) {
      const avance = avanceEnCircuito(r, estado, unaVuelta(), 5);
      expect(avance.llego).toBe(false);
      expect(avance.vueltas).toBe(vuelta);
      estado = { vueltas: avance.vueltas, progresoM: avance.progresoM };
    }

    const ultima = avanceEnCircuito(r, estado, unaVuelta(), 5);
    expect(ultima.llego).toBe(true);
    expect(ultima.vueltas).toBe(5);
  });

  it('cuenta varias vueltas dentro de un mismo lote', () => {
    const avance = avanceEnCircuito(
      r,
      { vueltas: 0, progresoM: 0 },
      [...unaVuelta(), ...unaVuelta()],
      5,
    );
    expect(avance.vueltas).toBe(2);
    expect(avance.llego).toBe(false);
  });

  it('quien se queda a mitad de vuelta no suma ninguna', () => {
    const avance = avanceEnCircuito(
      r,
      { vueltas: 2, progresoM: 0 },
      [200, 400, 500].map((m) => enMetro(m)),
      5,
    );
    expect(avance.vueltas).toBe(2);
    expect(avance.progresoM).toBeGreaterThan(400);
    expect(avance.llego).toBe(false);
  });
});
