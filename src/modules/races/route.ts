/**
 * Simplificacion del recorrido para mandarlo al movil.
 *
 * Una maraton grabada a 1 Hz son ~15.000 puntos: medio mega de JSON, varios
 * segundos de parseo y un `Polyline` que Flutter no puede dibujar a 60 fps. Y
 * no hace falta ninguno de esos puntos: en un mapa de 400 px de alto, dos
 * posiciones separadas tres metros caen en el mismo pixel.
 *
 * Se usa **Douglas-Peucker**, que es el algoritmo correcto para esto porque
 * conserva la *forma*: tira los puntos de las rectas y respeta las curvas. Un
 * muestreo "uno de cada diez" —mas corto de escribir— redondearia las esquinas
 * y cortaria las horquillas de un cerro.
 *
 * Funciones puras: entra un array de coordenadas y sale otro. Sin Prisma.
 */

/** Coordenada tal como sale de la base. */
export interface Coordenada {
  lat: number;
  lng: number;
}

/** Metros por grado de latitud. Constante suficiente fuera de los polos. */
const METROS_POR_GRADO = 111_320;

/**
 * Tolerancia inicial, en metros.
 *
 * Por debajo de esto el error ni se ve: 5 m es el propio error del GPS de un
 * telefono en buen dia, asi que "corregirlo" con mas precision seria dibujar
 * el ruido con mas detalle.
 */
export const TOLERANCIA_INICIAL_METROS = 5;

/**
 * Tope de puntos que sale hacia el cliente.
 *
 * 2.000 vertices dibujan una maraton entera sin que se note un solo corte, y
 * pesan ~60 KB. Es un tope **duro**: la tolerancia sube sola hasta cumplirlo,
 * porque un recorrido con GPS ruidoso puede resistirse a la simplificacion y
 * nadie quiere descubrirlo el dia de la carrera con 40.000 puntos en vuelo.
 */
export const MAX_PUNTOS_RECORRIDO = 2000;

/**
 * Distancia perpendicular del punto `p` al segmento `a`-`b`, en metros.
 *
 * Se proyecta a un plano local (equirectangular) antes de medir: a escala de
 * una carrera el error de la proyeccion es de centimetros, y hacer trigonometria
 * esferica dentro del bucle recursivo costaria mucho mas de lo que aporta.
 */
function distanciaAlSegmento(p: Coordenada, a: Coordenada, b: Coordenada): number {
  const cos = Math.cos((a.lat * Math.PI) / 180);
  const x = (c: Coordenada) => c.lng * cos * METROS_POR_GRADO;
  const y = (c: Coordenada) => c.lat * METROS_POR_GRADO;

  const dx = x(b) - x(a);
  const dy = y(b) - y(a);
  const largo = dx * dx + dy * dy;

  // Segmento degenerado (a === b): la distancia al segmento es la distancia al punto.
  if (largo === 0) return Math.hypot(x(p) - x(a), y(p) - y(a));

  // `t` recortado a [0,1] para medir contra el segmento y no contra su recta.
  const t = Math.max(0, Math.min(1, ((x(p) - x(a)) * dx + (y(p) - y(a)) * dy) / largo));

  return Math.hypot(x(p) - (x(a) + t * dx), y(p) - (y(a) + t * dy));
}

/**
 * Douglas-Peucker, iterativo.
 *
 * La version recursiva es mas corta pero se come la pila con recorridos
 * grandes: el peor caso es una rama por punto, y aqui los puntos son decenas de
 * miles. Una pila propia cuesta cuatro lineas mas y no revienta.
 */
export function simplificar(puntos: readonly Coordenada[], toleranciaMetros: number): Coordenada[] {
  if (puntos.length <= 2) return [...puntos];

  const conservar = new Uint8Array(puntos.length);
  conservar[0] = 1;
  conservar[puntos.length - 1] = 1;

  const pendientes: [number, number][] = [[0, puntos.length - 1]];

  while (pendientes.length > 0) {
    const [inicio, fin] = pendientes.pop()!;
    let peorIndice = -1;
    let peorDistancia = toleranciaMetros;

    for (let i = inicio + 1; i < fin; i++) {
      const d = distanciaAlSegmento(puntos[i]!, puntos[inicio]!, puntos[fin]!);
      if (d > peorDistancia) {
        peorDistancia = d;
        peorIndice = i;
      }
    }

    // Si nadie se aleja mas que la tolerancia, todo el tramo es esa recta.
    if (peorIndice === -1) continue;

    conservar[peorIndice] = 1;
    pendientes.push([inicio, peorIndice], [peorIndice, fin]);
  }

  return puntos.filter((_, i) => conservar[i] === 1);
}

/**
 * Simplifica subiendo la tolerancia hasta caber en `maximo` puntos.
 *
 * Duplicar la tolerancia converge rapido —cada vuelta borra aproximadamente la
 * mitad— y el limite de vueltas evita el bucle infinito teorico de un recorrido
 * de dos puntos que ya no se puede reducir mas.
 */
export function simplificarHasta(
  puntos: readonly Coordenada[],
  maximo: number = MAX_PUNTOS_RECORRIDO,
  toleranciaInicial: number = TOLERANCIA_INICIAL_METROS,
): { puntos: Coordenada[]; toleranciaMetros: number } {
  let tolerancia = toleranciaInicial;
  let salida = simplificar(puntos, tolerancia);

  for (let vuelta = 0; salida.length > maximo && vuelta < 12; vuelta++) {
    tolerancia *= 2;
    salida = simplificar(puntos, tolerancia);
  }

  return { puntos: salida, toleranciaMetros: tolerancia };
}

/** `LineString` GeoJSON. Ojo al orden: **`[lng, lat]`**, longitud primero. */
export interface LineStringGeoJson {
  type: 'LineString';
  coordinates: [number, number][];
}

/** Redondeo a 5 decimales: ~1 m. Mas decimales solo engordan el JSON. */
function redondear(valor: number): number {
  return Math.round(valor * 1e5) / 1e5;
}

export function aLineString(puntos: readonly Coordenada[]): LineStringGeoJson | null {
  // Un LineString de un solo punto es GeoJSON invalido; sin recorrido, `null`.
  if (puntos.length < 2) return null;

  return {
    type: 'LineString',
    coordinates: puntos.map((p) => [redondear(p.lng), redondear(p.lat)]),
  };
}
