import { MAX_VERTICES, largoDeLineString, metrosEntre, resolverRecorrido } from './linestring';

/** Un grado de latitud sobre la esfera de radio medio, que es el modelo que
 *  usa el modulo. El valor elipsoidal (110.574 m en el ecuador) se aparta un
 *  0,6%: irrelevante para dibujar un recorrido, pero delataria el test. */
const GRADO_LAT = 111_195;

/** Recta hacia el norte desde el ecuador: `n` vertices cada `metros`. */
function recta(n: number, metros: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [0, (i * metros) / GRADO_LAT]);
}

describe('metrosEntre', () => {
  it('mide un grado de latitud con menos de un 0,1% de error', () => {
    const medido = metrosEntre(0, 0, 1, 0);

    expect(Math.abs(medido - GRADO_LAT) / GRADO_LAT).toBeLessThan(0.001);
  });

  it('devuelve cero para el mismo punto', () => {
    expect(metrosEntre(-16.5, -68.15, -16.5, -68.15)).toBe(0);
  });
});

describe('largoDeLineString', () => {
  it('suma los tramos', () => {
    const largo = largoDeLineString({ type: 'LineString', coordinates: recta(11, 1000) });

    // Diez tramos de mil metros, con el margen del redondeo del grado.
    expect(largo).toBeGreaterThan(9_900);
    expect(largo).toBeLessThan(10_100);
  });
});

describe('resolverRecorrido', () => {
  const valido = { type: 'LineString', coordinates: recta(11, 1000) };

  it('saca distancia y punto de largada de la geometria', () => {
    const salida = resolverRecorrido(valido)!;

    expect(salida).not.toBeNull();
    expect(salida.distanceMeters).toBeGreaterThan(9_900);
    expect(salida.startLat).toBe(0);
    expect(salida.startLng).toBe(0);
  });

  it('no se cree la distancia declarada: la vuelve a medir', () => {
    const mentiroso = { ...valido, distanceMeters: 42_195 };

    expect(resolverRecorrido(mentiroso)!.distanceMeters).toBeLessThan(11_000);
  });

  it.each([
    ['no es un objeto', 'LineString'],
    ['otro tipo de geometria', { type: 'Polygon', coordinates: recta(11, 1000) }],
    ['sin coordenadas', { type: 'LineString' }],
    ['un solo vertice', { type: 'LineString', coordinates: [[0, 0]] }],
    [
      'coordenadas no numericas',
      {
        type: 'LineString',
        coordinates: [
          ['a', 'b'],
          [0, 1],
        ],
      },
    ],
    [
      'latitud fuera de rango',
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0, 91],
        ],
      },
    ],
    [
      'dos puntos pegados',
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0, 0.0001],
        ],
      },
    ],
  ])('rechaza %s', (_caso, entrada) => {
    expect(resolverRecorrido(entrada)).toBeNull();
  });

  it('rechaza un track crudo de mas de MAX_VERTICES puntos', () => {
    expect(
      resolverRecorrido({ type: 'LineString', coordinates: recta(MAX_VERTICES + 1, 1) }),
    ).toBeNull();
  });
});
