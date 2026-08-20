/**
 * Consolidacion de metricas a partir de las posiciones GPS.
 *
 * **La fuente de verdad es el servidor.** El cliente manda sus propios numeros
 * y se guardan en `clientReported` para poder compararlos, pero lo que se
 * publica sale de aqui: dos telefonos con el mismo recorrido dan distancias
 * distintas segun el filtrado de su SDK, y el ranking de una carrera no puede
 * depender del modelo de telefono del corredor.
 *
 * Todo es funcion pura sobre un array de puntos: sin Prisma y sin reloj. Un
 * recorrido de prueba entra por un lado y las metricas salen por el otro.
 */

/** Radio medio de la Tierra, en metros. */
const RADIO_TIERRA = 6_371_008.8;

/**
 * Precision peor que esto y el punto no se usa para medir.
 *
 * 30 m es el umbral que pide el PROMT y coincide con lo razonable: entre
 * edificios altos el GPS de un telefono rebota facil 20-40 m, y esos rebotes
 * suman kilometros fantasma en una hora de carrera.
 */
export const ACCURACY_MAXIMA_METROS = 30;

/**
 * Velocidad por encima de la cual el tramo se considera imposible, en m/s.
 *
 * 12,5 m/s son 45 km/h: mas rapido que el record mundial de 100 m sostenido
 * durante todo un tramo. Lo que produce esos saltos no es un corredor, es el
 * GPS reenganchando tras un tunel o un ascensor.
 */
const VELOCIDAD_MAXIMA_MPS = 12.5;

/**
 * Desnivel minimo, en metros, para contar como subida.
 *
 * La altitud del GPS oscila varios metros estando quieto. Sin umbral, una hora
 * de carrera llana acumula cientos de metros de "desnivel" que son ruido.
 */
const UMBRAL_ELEVACION_METROS = 3;

/**
 * Un tramo con menos de esto se considera parado.
 *
 * Con muestreo de 1 Hz, 0,5 m/s son 30 cm entre puntos: por debajo, el corredor
 * esta esperando un semaforo o atandose un cordon, no moviendose.
 */
const VELOCIDAD_MINIMA_MOVIMIENTO_MPS = 0.5;

/**
 * Hueco a partir del cual el tramo no cuenta ni como movimiento ni como
 * distancia, en segundos.
 *
 * Es lo que deja la app en segundo plano cuando el sistema la congela: al
 * volver, dos puntos separados diez minutos y un kilometro. Unirlos en linea
 * recta inventaria un recorrido que nadie hizo.
 */
const HUECO_MAXIMO_SEGUNDOS = 120;

const METROS_POR_KM = 1000;

export interface Punto {
  recordedAt: Date;
  lat: number;
  lng: number;
  altitude: number | null;
  accuracyMeters: number | null;
}

export interface Split {
  index: number;
  distanceMeters: number;
  durationSeconds: number;
  paceSecPerKm: number;
  elevationGainMeters: number;
}

export interface Metricas {
  distanceMeters: number;
  durationSeconds: number;
  movingSeconds: number;
  avgPaceSecPerKm: number | null;
  avgSpeedMps: number | null;
  elevationGainMeters: number;
  /** Indice (base 0) del kilometro mas rapido. `null` sin ningun km completo. */
  bestKmIndex: number | null;
  splits: Split[];
  /** Cuantos puntos se descartaron. Se registra: un numero alto es un sintoma. */
  discardedPoints: number;
}

/** Distancia sobre la esfera entre dos coordenadas, en metros (haversine). */
export function haversine(a: Punto, b: Punto): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;

  return 2 * RADIO_TIERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Se queda con los puntos utilizables, ordenados por hora.
 *
 * Solo se filtra por precision: los saltos imposibles se descartan mas tarde,
 * tramo a tramo, porque un punto aislado no tiene velocidad — la velocidad es
 * una propiedad del par.
 */
function utilizables(puntos: readonly Punto[]): Punto[] {
  return puntos
    .filter(
      (p) =>
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lng) <= 180 &&
        (p.accuracyMeters === null || p.accuracyMeters <= ACCURACY_MAXIMA_METROS),
    )
    .slice()
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}

/** Ritmo en segundos por km. `null` si no hay distancia que dividir. */
export function ritmo(distanceMeters: number, durationSeconds: number): number | null {
  if (distanceMeters <= 0) return null;
  return Math.round((durationSeconds * METROS_POR_KM) / distanceMeters);
}

/**
 * Un tramo entre dos puntos consecutivos, ya juzgado.
 *
 * Se calcula una sola vez y lo consume todo lo demas: distancia total, splits,
 * elevacion y tiempo en movimiento miran los mismos tramos, asi que no pueden
 * discrepar entre si.
 */
interface Tramo {
  distancia: number;
  segundos: number;
  desnivel: number;
  enMovimiento: boolean;
  desde: Punto;
  hasta: Punto;
}

function tramos(puntos: readonly Punto[]): { lista: Tramo[]; descartados: number } {
  const lista: Tramo[] = [];
  let descartados = 0;

  // La altitud de referencia solo avanza cuando el cambio supera el umbral:
  // comparar contra el punto anterior sumaria el temblor del sensor entero.
  let altitudBase = puntos[0]?.altitude ?? null;

  for (let i = 1; i < puntos.length; i++) {
    const anterior = puntos[i - 1]!;
    const actual = puntos[i]!;

    const segundos = (actual.recordedAt.getTime() - anterior.recordedAt.getTime()) / 1000;
    const distancia = haversine(anterior, actual);

    // Dos puntos con la misma marca de tiempo dan velocidad infinita.
    const imposible = segundos <= 0 || distancia / segundos > VELOCIDAD_MAXIMA_MPS;
    if (imposible || segundos > HUECO_MAXIMO_SEGUNDOS) {
      if (imposible) descartados++;
      continue;
    }

    let desnivel = 0;
    if (actual.altitude !== null) {
      if (altitudBase === null) {
        altitudBase = actual.altitude;
      } else if (Math.abs(actual.altitude - altitudBase) >= UMBRAL_ELEVACION_METROS) {
        desnivel = Math.max(0, actual.altitude - altitudBase);
        altitudBase = actual.altitude;
      }
    }

    lista.push({
      distancia,
      segundos,
      desnivel,
      enMovimiento: distancia / segundos >= VELOCIDAD_MINIMA_MOVIMIENTO_MPS,
      desde: anterior,
      hasta: actual,
    });
  }

  return { lista, descartados };
}

/**
 * Parte el recorrido en kilometros completos.
 *
 * El ultimo tramo parcial **no** se emite: un split de 300 m tendria un ritmo
 * que no se puede comparar con los demas, y es justo el que la app pintaria
 * como "mejor km". El resto acumulado sigue contando en la distancia total.
 *
 * Un tramo que cruza la marca del km se reparte proporcionalmente: con muestreo
 * de 1 Hz el error es de centimetros, pero a 30 s por punto (modo ahorro de
 * bateria) asignar el tramo entero a un lado descuadraria los splits.
 */
function partirEnKilometros(lista: readonly Tramo[]): Split[] {
  const splits: Split[] = [];
  let acumDistancia = 0;
  let acumSegundos = 0;
  let acumDesnivel = 0;

  for (const tramo of lista) {
    let restante = tramo.distancia;
    // Lo que falta del tramo, en la misma proporcion que la distancia.
    let segundosRestantes = tramo.segundos;
    let desnivelRestante = tramo.desnivel;

    while (acumDistancia + restante >= METROS_POR_KM) {
      const necesaria = METROS_POR_KM - acumDistancia;
      const fraccion = restante > 0 ? necesaria / restante : 1;
      const segundos = Math.round(acumSegundos + segundosRestantes * fraccion);

      splits.push({
        index: splits.length,
        distanceMeters: METROS_POR_KM,
        durationSeconds: segundos,
        // El split mide exactamente 1 km, asi que su ritmo es su duracion.
        paceSecPerKm: segundos,
        elevationGainMeters: Math.round(acumDesnivel + desnivelRestante * fraccion),
      });

      segundosRestantes -= segundosRestantes * fraccion;
      desnivelRestante -= desnivelRestante * fraccion;
      restante -= necesaria;
      acumDistancia = 0;
      acumSegundos = 0;
      acumDesnivel = 0;
    }

    acumDistancia += restante;
    acumSegundos += segundosRestantes;
    acumDesnivel += desnivelRestante;
  }

  return splits;
}

/**
 * Todas las metricas de un recorrido.
 *
 * `durationSeconds` es el tiempo de reloj entre el primer y el ultimo punto
 * validos, no la suma de los tramos: lo que se descarta por ruido no le devuelve
 * tiempo al corredor. `movingSeconds` si es una suma, la de los tramos en los
 * que efectivamente se movia — de ahi sale la auto-pausa, sin creerle al
 * cliente.
 */
export function consolidar(puntos: readonly Punto[]): Metricas {
  const validos = utilizables(puntos);
  const { lista, descartados } = tramos(validos);

  const vacio: Metricas = {
    distanceMeters: 0,
    durationSeconds: 0,
    movingSeconds: 0,
    avgPaceSecPerKm: null,
    avgSpeedMps: null,
    elevationGainMeters: 0,
    bestKmIndex: null,
    splits: [],
    discardedPoints: puntos.length - validos.length + descartados,
  };

  if (lista.length === 0) return vacio;

  const primero = validos[0]!;
  const ultimo = lista.at(-1)!.hasta;

  const distancia = lista.reduce((suma, t) => suma + t.distancia, 0);
  const enMovimiento = lista.reduce((suma, t) => suma + (t.enMovimiento ? t.segundos : 0), 0);
  const desnivel = lista.reduce((suma, t) => suma + t.desnivel, 0);
  const duracion = Math.round((ultimo.recordedAt.getTime() - primero.recordedAt.getTime()) / 1000);

  const splits = partirEnKilometros(lista);
  const mejor = splits.reduce<Split | null>(
    (mejor, s) => (mejor === null || s.paceSecPerKm < mejor.paceSecPerKm ? s : mejor),
    null,
  );

  const distanceMeters = Math.round(distancia);
  const movingSeconds = Math.round(enMovimiento);

  return {
    distanceMeters,
    durationSeconds: duracion,
    movingSeconds,
    // El ritmo medio se calcula sobre el tiempo en movimiento, que es el que
    // pinta cualquier reloj deportivo: incluir el semaforo lo empeora sin que
    // el corredor haya corrido peor.
    avgPaceSecPerKm: ritmo(distanceMeters, movingSeconds),
    avgSpeedMps: movingSeconds > 0 ? distanceMeters / movingSeconds : null,
    elevationGainMeters: Math.round(desnivel),
    bestKmIndex: mejor?.index ?? null,
    splits,
    discardedPoints: puntos.length - validos.length + descartados,
  };
}

/**
 * Calorias por el metodo MET.
 *
 * `kcal = MET x peso(kg) x horas`, con el MET de carrera aproximado desde la
 * velocidad: correr a 10 km/h son ~10 MET, y la relacion es casi lineal en el
 * rango en el que corre la gente. Es una estimacion **de gama**, no una medida:
 * sin frecuencia cardiaca no hay forma de hacerlo mejor, y prometer precision
 * con este dato seria mentir.
 *
 * Devuelve `null` sin peso: inventarle 70 kg a alguien da un numero que parece
 * suyo y no lo es.
 */
export function calorias(
  distanceMeters: number,
  movingSeconds: number,
  weightGrams: number | null,
): number | null {
  if (!weightGrams || weightGrams <= 0 || movingSeconds <= 0 || distanceMeters <= 0) return null;

  const kmPorHora = distanceMeters / METROS_POR_KM / (movingSeconds / 3600);
  // Coeficiente clasico del compendio de actividades: ~1 MET por km/h.
  const met = Math.max(1, kmPorHora);

  return Math.round(met * (weightGrams / 1000) * (movingSeconds / 3600));
}

/** Separacion por defecto entre marcadores de paso de una carrera, en metros. */
export const MARCADOR_CADA_METROS = 5000;

/** Un paso por la marca de los 5, 10, 15... km. */
export interface Marcador {
  /** Kilometro de la marca: 5, 10, 15... */
  kmMark: number;
  lat: number;
  lng: number;
  passedAt: Date;
  /** Segundos desde el primer punto valido hasta cruzar la marca. */
  splitSeconds: number;
}

/**
 * Marcadores de paso cada `cadaMetros`, sobre los mismos tramos que las demas
 * metricas.
 *
 * Se calcula aqui y no en el modulo de carreras a proposito: los checkpoints
 * tienen que salir del **mismo** recorrido filtrado que la distancia y los
 * splits. Calculados aparte, con otro filtro, el marcador del km 20 caeria en
 * un sitio donde el corredor —segun el resto de la API— no estuvo.
 *
 * El punto exacto se **interpola** dentro del tramo que cruza la marca: con
 * muestreo de 1 Hz da lo mismo, pero en modo ahorro de bateria hay 30 s entre
 * puntos y clavar el marcador en el punto siguiente regalaria medio minuto.
 */
export function marcadores(
  puntos: readonly Punto[],
  cadaMetros: number = MARCADOR_CADA_METROS,
): Marcador[] {
  const validos = utilizables(puntos);
  const { lista } = tramos(validos);
  if (lista.length === 0 || cadaMetros <= 0) return [];

  const salida = validos[0]!.recordedAt.getTime();
  const marcas: Marcador[] = [];
  let acumulada = 0;

  for (const tramo of lista) {
    const hasta = acumulada + tramo.distancia;

    // Un tramo largo puede cruzar varias marcas: el `while` las emite todas.
    while (Math.floor(hasta / cadaMetros) > marcas.length) {
      const objetivo = (marcas.length + 1) * cadaMetros;
      const fraccion = tramo.distancia > 0 ? (objetivo - acumulada) / tramo.distancia : 1;
      const momento = new Date(tramo.desde.recordedAt.getTime() + tramo.segundos * fraccion * 1000);

      marcas.push({
        kmMark: objetivo / METROS_POR_KM,
        lat: tramo.desde.lat + (tramo.hasta.lat - tramo.desde.lat) * fraccion,
        lng: tramo.desde.lng + (tramo.hasta.lng - tramo.desde.lng) * fraccion,
        passedAt: momento,
        splitSeconds: Math.round((momento.getTime() - salida) / 1000),
      });
    }

    acumulada = hasta;
  }

  return marcas;
}
