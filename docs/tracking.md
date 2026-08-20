# Tracking GPS

Cómo entran las posiciones al backend, quién las autentica y qué se hace con
ellas. La consolidación de métricas (distancia, splits, ritmo) está en
`docs/api.md`, sección "Entrenamientos".

---

## El flujo

```
App Flutter
  ├─▶ escribe cada punto en la base local          ← SIEMPRE, y primero
  └─▶ envía LOTES cada 15-30 s ──▶ POST /api/v1/tracking/sessions/:id/positions
                                          │
                                          ▼
                                 Postgres (positions)
```

**Lotes, nunca punto por punto.** Una petición por segundo destroza la batería y
no aporta nada: el mapa lo pinta el cliente con sus propios puntos, que ya tiene
en local. Si no hay señal, la cola local se acumula y se drena al reconectar; el
entrenamiento se completa igual porque la fuente de verdad del recorrido es la
base local del teléfono hasta que el lote llega.

La doble escritura —local primero, red después— es lo que hace que perder la
conexión a mitad de una carrera no cueste nada.

---

## El endpoint

```
POST /api/v1/tracking/sessions/:id/positions
Authorization: Bearer <ingestToken>
Content-Type: application/json

{
  "points": [
    { "clientPointId": "3f1c…-0", "recordedAt": "2026-08-19T11:02:00.000Z",
      "lat": -16.4957, "lng": -68.1335,
      "altitude": 3625, "speed": 3.4, "accuracy": 8, "heading": 187, "battery": 74 }
  ]
}
```

Respuesta `202`:

```json
{ "accepted": 28, "duplicated": 2, "rejected": 0,
  "reasons": { "future": 0, "before_session": 0, "invalid_coordinates": 0 } }
```

Máximo **1000 puntos por lote** (a 1 Hz son más de quince minutos: sobra para un
lote atrasado). Comprime con gzip: son puntos muy repetitivos y el ahorro es
grande.

### Se autentica con el `ingestToken`, no con el JWT

El token lo devuelve `POST /workouts/sessions` **en claro una sola vez**; en la
base solo queda su sha256. Sirve para una sola cosa —mandar puntos a **esa**
sesión— y muere cuando la sesión se cierra.

El credencial que viaja desde el teléfono cada veinte segundos, durante toda una
carrera, tiene que ser el de menor alcance posible. Mandar el JWT de usuario en
cada lote sería pasear la llave de toda la cuenta por la red mil veces por
entrenamiento.

Si el token no existe, o no es el de la sesión de la URL, la respuesta es la
misma: **401 `INVALID_INGEST_TOKEN`**. Distinguir los dos casos convertiría el
mensaje en un oráculo para adivinar ids de sesiones ajenas.

### Reenviar un lote es seguro

El dedupe es por `(clientPointId, recordedAt)`, con índice único: los repetidos
se cuentan en `duplicated` y no se insertan. Por eso el cliente puede reintentar
a ciegas cuando se le corta la señal — que es el caso normal, no la excepción.

Es responsabilidad del cliente que `clientPointId` sea estable: si cambia entre
reintentos, el dedupe no puede hacer nada.

### Qué se rechaza y qué no

Solo se rechaza lo **imposible**, y nunca tumba el lote entero:

| `reason` | Cuándo |
|---|---|
| `future` | `recordedAt` más de 2 min por delante del reloj del servidor |
| `before_session` | Más de 1 min antes del arranque de la sesión |
| `invalid_coordinates` | `lat`/`lng` fuera de rango |

La **precisión mala no se filtra aquí**: el punto se guarda y se descarta al
consolidar (umbral de 30 m, en `metrics.ts`). Guardarlo cuesta una fila y permite
recalcular el entrenamiento con otro umbral el día que haga falta; tirarlo en la
ingesta es una decisión irreversible tomada con la peor información.

Un `rejected` alto es un síntoma del cliente —reloj desincronizado, cola sucia— y
por eso viaja en la respuesta en vez de silenciarse.

### Estados de la sesión

Se acepta en `active` **y en `paused`**: un lote en vuelo cuando el usuario pulsa
"pausa" trae puntos que ocurrieron de verdad, y rechazarlo los perdería. Con la
sesión `finished` o `discarded` la respuesta es **409 `SESSION_NOT_ACTIVE`**: ahí
ya no hay nada que hacer con esos puntos.

### Rate limit por sesión

`TRACKING_INGEST_BATCHES_PER_MINUTE` (20 por defecto) se cuenta **por sesión, no
por IP**. Media maratón entera sale por la misma red móvil con la misma IP
pública: un límite por IP o deja pasar a un cliente roto o corta a doscientos
corredores legítimos a la vez. El ritmo normal son 2-4 lotes por minuto; el resto
es margen para el que drena su cola al salir de un túnel.

---

## Dónde acaban los puntos

- Se guardan en `positions`, **particionada por mes** sobre `recordedAt`. La
  partición del mes se crea sola al primer punto que la necesita.
- `workoutId` se queda **null** hasta que la sesión se cierra: hasta ese momento
  los puntos podrían acabar en un entrenamiento descartado.
- `trackingSession.lastPositionAt` se actualiza en cada lote — es lo que delata
  una sesión colgada.

Descartar la sesión **borra las posiciones de verdad**. Son datos de ubicación y
el usuario pidió tirarlos.

---

## Fuentes de posiciones

`PositionIngestionSource` (`src/modules/tracking/sources/`) es la puerta abierta:
una fuente traduce su payload a `PuntoNormalizado[]` y ya está. La validación, el
dedupe y el guardado viven una sola vez, en `TrackingService`, y no se tocan al
agregar una fuente.

Hoy existen **`AppBatchSource`** (`source: app_batch`, la app oficial) y
**`OsmAndSource`** (`source: osmand`). El enum de la base ya contempla ademas
`traccar`, que hablaria por el mismo sitio.

---

## Protocolo OsmAnd

```
GET  /api/v1/tracking/osmand?id=<uniqueId>&lat=-16.4957&lon=-68.1335&timestamp=1755600000&speed=3.4&bearing=187&altitude=3625&accuracy=8&batt=74
POST /api/v1/tracking/osmand?...   (mismos parametros, tambien en la URL)
```

Lo hablan Traccar Client, varios relojes y casi cualquier tracker barato.
Soportarlo abre la app a hardware que no vamos a escribir nunca, y cuesta un
adaptador: `OsmAndSource` traduce la query a `PuntoNormalizado[]` y de ahi en
adelante el camino es el mismo que el de la app —misma validacion, mismo dedupe,
mismo guardado.

**Un punto por peticion**, porque el protocolo es asi. Por eso el limite es otro:
`TRACKING_OSMAND_POINTS_PER_MINUTE` (120 por defecto) contra los 20 lotes de la
app, y se cuenta **por dispositivo**.

| Detalle | Qué hace |
|---|---|
| `id` | El `uniqueId` del dispositivo. Es el credencial. |
| `timestamp` | Unix en segundos, en milisegundos o ISO-8601. Si falta, la hora del servidor. |
| `speed` | Se guarda tal cual **asumiendo m/s**. Traccar lo interpreta en nudos y los clientes no se ponen de acuerdo; da igual, porque las metricas se calculan desde las coordenadas y este campo es solo informativo. |
| extras (`hdop`, `charge`, …) | Se ignoran sin fallar: la regla global de rechazar campos de mas convertiria cada version nueva del cliente en un 400. |
| `clientPointId` | No existe en el protocolo. Se fabrica con el segundo exacto (`osmand-<epoch>`), asi que un tracker que reintenta se deduplica igual. |

### El `id` del dispositivo es el credencial, y eso tiene un limite

El protocolo no tiene sitio para nada mejor: el tracker solo sabe decir quien es.
Dos cosas acotan el daño:

- El `uniqueId` es un **UUID que genera la app**, no un numero de serie adivinable.
- Un punto solo entra si ese dispositivo tiene una **sesion abierta**. Sin sesion
  la respuesta es `409 SESSION_NOT_ACTIVE` y no se crea nada — abrir una sesion
  desde un GET suelto llenaria la cuenta de entrenamientos fantasma cada vez que
  alguien deja un tracker encendido en un cajon.

O sea: la ventana de abuso es la duracion de un entrenamiento, no la vida de la
cuenta. Quien quiera mas garantias, que use la app.

---

## Simulacion de GPS

```
POST /api/v1/tracking/simulate
Authorization: Bearer <ingestToken>

{ "coordinates": [[-68.1335, -16.4957], [-68.1336, -16.4958]], "intervalSeconds": 1 }
```

**Solo fuera de produccion**; en produccion responde `404`. Las coordenadas van
en orden GeoJSON (`[lng, lat]`) para poder pegar un `LineString` de geojson.io
sin darle la vuelta a nada.

Existe porque la alternativa para probar el tracking es salir a correr, y eso
convierte cada cambio en `metrics.ts` en una hora de calle. No es un atajo: los
puntos entran **por el mismo `ingerir()`** que los de verdad, con la misma
validacion y el mismo dedupe. Si la simulacion consolida bien, el camino real
tambien.

Los tiempos se cuentan **hacia atras desde ahora** y, si el track no cabe en la
sesion, se retrasa su `startedAt`: un recorrido de veinte minutos en una sesion
recien arrancada tendria todos los puntos en el futuro y se descartaria solo.

Los puntos se guardan como `app_batch` con el `clientPointId` prefijado `sim-`.

---

## Seguimiento en vivo

### Cómo se conecta un espectador

```js
const socket = io('https://api.ejemplo.bo/live', {
  auth: { token: accessToken },        // el mismo JWT de la API
  transports: ['websocket'],
});

await socket.emitWithAck('spectate', { marathonId });  // → { ok: true, room: 'marathon:<id>' }
socket.on('runner:position', ({ bib, lat, lng, distanceMeters, t }) => { /* pintar */ });
await socket.emitWithAck('leave', { marathonId });
```

| Pieza | Valor |
|---|---|
| Namespace | `/live` |
| Sala | `marathon:{id}` |
| Evento del servidor | `runner:position` |
| Eventos del cliente | `spectate`, `leave` (los dos con ack) |
| Payload | `{ bib, lat, lng, distanceMeters, t }` |

El token va en **`auth.token`** del handshake y no en la query: la query acaba
en los logs de acceso del proxy. Se acepta `?token=` igualmente porque hay
clientes que no pueden mandar `auth`, pero el orden dice cuál es el bueno.

Se verifica **al conectar**, no en cada mensaje: un socket vive horas y
verificar el JWT en cada evento sería verificarlo miles de veces por cliente. La
contrapartida —que el token caduque con el socket abierto— es asumible: el peor
caso es un espectador viendo dorsales quince minutos de más.

`spectate` comprueba que la maratón exista y esté publicada. Sin eso, cualquiera
podría suscribirse a `marathon:<lo que sea>` y descubrir por el tráfico que hay
algo detrás.

### Qué se publica, y qué no

Solo las sesiones con `marathonId`, es decir, las que arrancaron atadas a una
inscripción. **Un entrenamiento normal no se publica a nadie**: la posición de
alguien corriendo por su barrio no tiene espectadores ni debe tenerlos.

El payload lleva el **dorsal y nada más**. Ni nombre, ni `userId`, ni id de
sesión: quien mira el mapa ve un número en una carrera pública, que es
exactamente lo que ya vería desde la acera.

`distanceMeters` es una acumulación **aproximada**: suma haversine sobre los
puntos del lote, sin el filtrado por precisión ni el descarte de saltos que sí
hace `consolidar()`. Un mapa en vivo se mira a escala de kilómetros. El número
que vale, y el que acaba en la clasificación, es el de la consolidación.

### Throttling

**Máximo una posición por corredor cada 5 s** (`LIVE_UPDATE_MIN_INTERVAL_MS`).
Un corredor manda un lote cada 15–30 s con ~30 puntos dentro; reenviarlos todos
multiplicaría por treinta el tráfico hacia cada espectador para dibujar un
movimiento que en el mapa son tres píxeles.

Lo que se emite es el **último punto del lote** con la distancia acumulada, no
una media: al espectador le importa dónde está el corredor ahora.

### Adapter de Redis

Socket.IO corre con `@socket.io/redis-adapter`. Sin él, cada instancia de la API
solo alcanza a los sockets conectados **a ella**: dos procesos detrás de un
balanceador y la mitad de los espectadores no ve nada, sin un solo error en
ningún log.

Hoy corre una instancia y el adapter no hace falta. Está puesto porque es lo que
permite añadir la segunda sin tocar la lógica — y porque el día que haga falta
será durante una carrera, no antes.

Si Redis no responde al arrancar, la API **sigue levantando** con el adapter en
memoria y un `error` en el log: una carrera sin mapa de espectadores sigue
siendo una carrera.

---

## Lo que falta para el live tracking masivo

Lo de arriba es la base: sirve para seguir a los corredores de una maratón en un
mapa. Para abrirlo a un público de verdad faltan cuatro cosas, en este orden.

### 1. Autorización de espectadores

Hoy basta con **cualquier** cuenta válida para entrar en cualquier sala de
maratón publicada. Falta decidir la política: ¿público total, solo inscritos,
solo un enlace compartido por el corredor? Cada opción es un `where` distinto en
`spectate` y ninguna es más difícil que otra; lo difícil es elegir.

### 2. Privacidad opt-in del corredor

**Nadie ha dicho que sí a que lo sigan.** Hoy la publicación es implícita para
quien corre una carrera. Hace falta una preferencia por inscripción
(`shareLiveLocation`) que por defecto sea `false`, un aviso claro al activarla y
la posibilidad de apagarla a mitad de carrera. Es la pieza que no se puede saltar:
retransmitir la ubicación de una persona en tiempo real sin su consentimiento
explícito no es un detalle de producto.

### 3. Clustering en el mapa

Con 5.000 corredores, el cliente recibe 1.000 mensajes por segundo y el mapa
intenta animar 5.000 marcadores. Ninguna de las dos cosas es viable en un
teléfono. Lo que falta del lado del servidor es agregar por celda —«38 corredores
en el km 12»— y mandar los marcadores individuales solo de los dorsales que el
espectador siga explícitamente.

### 4. Publicación fuera del request

Hoy la emisión ocurre dentro de la petición de ingesta, después del `INSERT`. Con
throttling y sin esperar acks cuesta microsegundos, pero es trabajo que no
pertenece al camino caliente. El destino es una cola BullMQ, junto con los splits
parciales (ver *Sin BullMQ todavía* en `docs/decisiones.md`).

### Estimación de carga

Con la ventana de 5 s por corredor, para **N corredores** y **M espectadores**:

| Magnitud | Fórmula | 500 corredores, 200 espectadores | 5.000 corredores, 2.000 espectadores |
|---|---|---|---|
| Mensajes emitidos/s | N / 5 | 100 | 1.000 |
| Mensajes entregados/s | (N / 5) × M | 20.000 | **2.000.000** |
| Ancho de banda (~80 B/mensaje) | | ~1,6 MB/s | ~160 MB/s |

La primera columna la aguanta el VPS de 2 vCPU / 4 GB sin despeinarse. La segunda
**no la aguanta nadie sin clustering**: el problema no es la ingesta ni Redis, es
el abanico hacia los espectadores, y ahí el arreglo no es más hardware sino mandar
menos mensajes. Es la razón por la que el punto 3 no es opcional a partir de unos
pocos cientos de corredores.

Los lotes de ingesta, en cambio, escalan planos: 5.000 corredores mandando un
lote cada 20 s son 250 peticiones/s, que es tráfico web normal.
