import {
  aLineString,
  simplificar,
  simplificarHasta,
  MAX_PUNTOS_RECORRIDO,
  type Coordenada,
} from './route';

/** Metros por grado de latitud, el mismo que usa el modulo. */
const GRADO = 111_320;

/** Recta hacia el norte desde el ecuador, `n` puntos cada `metros`. */
function recta(n: number, metros: number): Coordenada[] {
  return Array.from({ length: n }, (_, i) => ({ lat: (i * metros) / GRADO, lng: 0 }));
}

describe('simplificar', () => {
  it('reduce una recta a sus dos extremos', () => {
    const salida = simplificar(recta(500, 1), 5);

    expect(salida).toHaveLength(2);
    expect(salida[0]!.lat).toBe(0);
  });

  it('conserva un vertice que se sale de la tolerancia', () => {
    const desvio = 20 / GRADO;
    const puntos: Coordenada[] = [
      { lat: 0, lng: 0 },
      { lat: desvio, lng: 100 / GRADO },
      { lat: 0, lng: 200 / GRADO },
    ];

    expect(simplificar(puntos, 5)).toHaveLength(3);
    // El mismo vertice, con una tolerancia mayor que el desvio, sobra.
    expect(simplificar(puntos, 30)).toHaveLength(2);
  });

  it('deja pasar recorridos de menos de tres puntos', () => {
    expect(simplificar([], 5)).toEqual([]);
    expect(simplificar(recta(2, 1000), 5)).toHaveLength(2);
  });
});

describe('simplificarHasta', () => {
  it('sube la tolerancia hasta caber en el tope', () => {
    // Zigzag de 30 m de amplitud: ninguna tolerancia pequena lo reduce.
    const puntos: Coordenada[] = Array.from({ length: 6000 }, (_, i) => ({
      lat: (i % 2 === 0 ? 0 : 30) / GRADO,
      lng: (i * 5) / GRADO,
    }));

    const { puntos: salida, toleranciaMetros } = simplificarHasta(puntos);

    expect(salida.length).toBeLessThanOrEqual(MAX_PUNTOS_RECORRIDO);
    expect(toleranciaMetros).toBeGreaterThan(5);
  });
});

describe('aLineString', () => {
  it('invierte el orden a [lng, lat] y redondea', () => {
    const linea = aLineString([
      { lat: -16.4956789, lng: -68.1336789 },
      { lat: -16.5, lng: -68.14 },
    ]);

    expect(linea?.type).toBe('LineString');
    expect(linea?.coordinates[0]).toEqual([-68.13368, -16.49568]);
  });

  it('devuelve null sin recorrido dibujable', () => {
    expect(aLineString([{ lat: 0, lng: 0 }])).toBeNull();
  });
});
