# Contrato de la API

Referencia para quien consume la API — hoy la app Flutter, mañana un front web.
La documentación interactiva y siempre actualizada está en `/api/docs`; este
archivo cubre lo que Swagger no explica: las reglas transversales.

---

## Reglas que valen para todos los endpoints

**Prefijo:** `/api/v1`. `/health` y `/ready` quedan fuera a propósito: los
consume la infraestructura y no deben romperse cuando exista `/api/v2`.

### Unidades base

El servidor nunca formatea. Devuelve magnitudes crudas y el cliente decide si
muestra km o millas, `5:30/km` o `8:51/mi`, `Bs 150,00` o `150 BOB`.

| Magnitud | Unidad | Ejemplo |
|---|---|---|
| Distancia | metros, entero | `42195` |
| Duración | segundos, entero | `12600` |
| Ritmo | segundos por kilómetro | `330` → 5:30/km |
| Velocidad | metros por segundo | `3.03` |
| Dinero | centavos, entero + `currency` | `15000` + `"BOB"` → Bs 150,00 |
| Fechas | ISO-8601 en UTC | `2026-08-18T14:03:22.118Z` |

Cada maratón guarda además su `timezone` IANA (`America/La_Paz` por defecto),
para que el cliente pueda mostrar la hora local de la carrera.

### Sobre de respuesta

Todo éxito:

```json
{
  "data": { },
  "meta": { "requestId": "c1f3a0d2-…", "timestamp": "2026-08-18T14:03:22.118Z" }
}
```

Todo error:

```json
{
  "error": { "code": "MARATHON_FULL", "message": "…", "details": [] },
  "meta": { "requestId": "c1f3a0d2-…", "timestamp": "…" }
}
```

Dos reglas que no son negociables del lado cliente:

1. **Mapea por `error.code`, nunca por `error.message`.** El mensaje es texto
   humano: puede cambiar de redacción o traducirse sin previo aviso. El código
   es estable.
2. **`meta.timestamp` es la hora del servidor.** Las cuentas regresivas se
   calculan contra ese valor, no contra el reloj del teléfono, que el usuario
   puede tener mal.

### Trazabilidad

`meta.requestId` viaja también en la cabecera `x-request-id` y aparece en cada
línea de log del servidor. Si un usuario reporta un error y puede dar ese id, se
encuentra su traza completa. Conviene mostrarlo en las pantallas de error.

### Validación

Los DTO corren con `whitelist` y `forbidNonWhitelisted`: un campo que no está
declarado no se ignora, **hace fallar la petición** con `VALIDATION_ERROR`. Es
deliberado — impide, por ejemplo, colar `"role": "admin"` en el registro.

Cuando falla la validación, `error.details` trae un mensaje por campo:

```json
{ "error": {
    "code": "VALIDATION_ERROR",
    "message": "La peticion no paso la validacion",
    "details": ["El email no tiene un formato valido"]
} }
```

---

## Catálogo de códigos de error

La fuente de verdad es `src/common/errors/error-codes.ts`. Todo código nuevo se
agrega allí y se documenta aquí.

### Genéricos

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | El body/query no pasó la validación | Mostrar `details` junto a los campos |
| `UNAUTHORIZED` | 401 | Falta el token, es inválido o expiró | Disparar **un** refresh y reintentar |
| `FORBIDDEN` | 403 | Autenticado, sin permiso sobre el recurso | No reintentar |
| `NOT_FOUND` | 404 | No existe, o existe y no es tuyo | No reintentar |
| `CONFLICT` | 409 | Conflicto de estado o duplicado | Releer el estado y reintentar |
| `RATE_LIMITED` | 429 | Demasiadas peticiones | Esperar y reintentar con backoff |
| `SERVICE_UNAVAILABLE` | 503 | Una dependencia no responde | Reintentar con backoff |
| `INTERNAL_ERROR` | 500 | Fallo no controlado | Mostrar error genérico y reportar el `requestId` |

### Autenticación

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Email o contraseña incorrectos | Mostrar error en el formulario. **No** distingue si el email existe |
| `EMAIL_ALREADY_REGISTERED` | 409 | Ya hay cuenta con ese email | Ofrecer ir a login |
| `INVALID_REFRESH_TOKEN` | 401 | El refresh no existe, caducó o ya se usó | Limpiar storage → Welcome |
| `TOKEN_REUSE_DETECTED` | 401 | Llegó un refresh ya rotado; se cerraron las sesiones del dispositivo | Limpiar storage → Welcome. **Nunca reintentar** |
| `INVALID_RESET_TOKEN` | 400 | El enlace de recuperación no vale o venció | Ofrecer pedir uno nuevo |
| `INSUFFICIENT_ROLE` | 403 | El rol no alcanza | No reintentar |

### Usuarios y archivos

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `FILE_TOO_LARGE` | 413 | El archivo supera el límite del endpoint | Comprimir o elegir otro. El avatar admite 5 MB |
| `INVALID_IMAGE` | 415 | El archivo no se pudo decodificar como imagen | Pedir otra imagen. No sirve renombrar la extensión |

### Maratones y precios

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `INVALID_CATEGORY` | 400 | La categoría no es de esa maratón | Recargar categorías y volver a elegir |
| `INVALID_EXTRA` | 400 | El adicional no es de esa maratón, o la cantidad es absurda | Recargar extras |
| `EXTRA_OUT_OF_STOCK` | 409 | No quedan unidades suficientes | Bajar la cantidad o quitarlo. El mensaje dice cuántas quedan |

### Inscripciones

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `MARATHON_FULL` | 409 | Se agotaron los cupos | Volver al detalle: el estado ya dice `full` |
| `REGISTRATION_CLOSED` | 409 | Las inscripciones están cerradas | No reintentar |
| `ALREADY_REGISTERED` | 409 | Ya hay una inscripción confirmada en esa maratón | Llevar a la inscripción existente |
| `REGISTRATION_NOT_EDITABLE` | 409 | Ya se confirmó o se canceló | Recargar el detalle |
| `CATEGORY_REQUIRED` | 400 | Falta elegir categoría | Volver al paso 2 |
| `CANCELLATION_NOT_ALLOWED` | 409 | La carrera ya ocurrió, o el estado no admite cancelar | No reintentar |
| `REGISTRATION_NOT_CONFIRMED` | 409 | Se intentó largar una maratón con la inscripción sin confirmar. `details[0]` trae `status` | Llevar al paso de pago; no reintentar la largada |

### Planes de entrenamiento

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `PLAN_ALREADY_ACTIVE` | 409 | Ya hay un plan activo. `details[0]` trae `activePlanId` y `activePlanName` | Preguntar al usuario y reintentar con `replaceActive: true` |
| `PLAN_DOES_NOT_FIT` | 409 | No quedan semanas suficientes hasta la carrera ni recortando. `details[0]` trae `weeksAvailable` y `minimumWeeks` | No reintentar: ofrecer otra maratón o un plan sin objetivo |
| `PLAN_NOT_ACTIVE` | 409 | Se intentó abandonar un plan ya cerrado | Recargar `/training-plans/me` |
| `SESSION_NOT_PENDING` | 409 | La sesión ya está completada o saltada | Recargar la semana |

### Entrenamientos y tracking

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `SESSION_ALREADY_ACTIVE` | 409 | Ya hay una sesión de tracking abierta. `details[0]` trae `sessionId` y `startedAt` | Finalizarla o descartarla y reintentar |
| `SESSION_NOT_ACTIVE` | 409 | La sesión no está en el estado que la operación necesita. `details[0]` trae `status` y `expected` | Recargar el estado de la sesión |

### Home

### Un solo endpoint

```
GET /home/summary
```

La pantalla de inicio necesita cinco cosas de cuatro módulos. Con un endpoint por
cosa, arrancar la app son cinco peticiones en serie sobre una red móvil — y cinco
oportunidades de que una falle y la pantalla quede a medias. Aquí se resuelven
juntas.

**El pull-to-refresh es volver a llamar aquí.** Nada se cachea del lado del
servidor; mandar `Cache-Control: no-cache` no hace daño pero tampoco cambia nada.

```json
{
  "featuredMarathon": { "...": "resumen de maratón", "registrationId": null, "bibNumber": null, "isRegistered": false },
  "prediction": { "finishTimeSeconds": 7020, "paceSecPerKm": 333, "confidence": "medium", "basedOn": {}, "reason": null },
  "plan": { "id": "...", "currentWeek": 6, "totalWeeks": 12, "completedSessions": 14 },
  "planWeek": { "week": 6, "sessions": [] },
  "todaySession": { "...": "sesión del plan, o null" },
  "week": { "weekStartsAt": "...", "timezone": "America/La_Paz", "days": [] }
}
```

### La maratón destacada

Manda **la que el usuario ya pagó**: es la que tiene una cuenta regresiva que le
importa. Sin inscripción por delante se cae a la próxima del catálogo, que ahí sí
es una invitación. `isRegistered` distingue los dos casos, y `bibNumber` viene
relleno solo en el primero.

La cuenta regresiva la calcula el cliente contra **`meta.timestamp`**, que es la
hora del servidor: el reloj del teléfono puede ir minutos desviado y una carrera
no empieza cuando él diga.

### La tira Mon–Sun

`week.days` trae **siempre las siete casillas**, ceros incluidos, y cada una cruza
las dos mitades:

| Campo | De dónde sale |
|---|---|
| `distanceMeters`, `movingSeconds`, `workouts` | Lo que se corrió de verdad |
| `plannedDistanceMeters`, `sessionId`, `sessionType`, `sessionStatus` | Lo que el plan pedía |

El cruce se hace **por fecha**, no por día de la semana: un plan que ya terminó
devuelve su última semana, y casar por `weekday` pintaría las sesiones de marzo
sobre la tira de hoy. Sin plan activo, la mitad planificada viene toda en `null`.

`todaySession` es la sesión del plan fechada hoy en `America/La_Paz`, o `null`.

### Tiempo estimado de llegada

`prediction` se calcula para la distancia de la maratón destacada, con la fórmula
de **Riegel**: `T2 = T1 × (D2/D1)^1.06`, aplicada al **mejor esfuerzo** de las
últimas 12 semanas y corregida por el volumen semanal medio.

| Campo | Qué es |
|---|---|
| `finishTimeSeconds` / `paceSecPerKm` | El pronóstico. `null` si no hay datos |
| `confidence` | `high`, `medium` o `low` — baja cuanto más lejos se extrapola |
| `basedOn` | En qué se basó: entrenamientos, mejor esfuerzo, volumen semanal |
| `reason` | `insufficient_data`, o `null` cuando sí hay número |

**No es un error tener `null`.** Con menos de 3 entrenamientos de 2 km o más, la
respuesta es `200` con `reason: "insufficient_data"`: en el home eso no es un
fallo, es un corredor que acaba de empezar, y la pantalla tiene que saber
pintarlo sin un `catch`.

El detalle de por qué se corrige por volumen —y por qué la corrección solo puede
empeorar el pronóstico— está en `docs/decisiones.md`.

---

## Carreras

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `RESULT_NOT_AVAILABLE` | 409 | La carrera todavía no tiene resultado: no se corrió, o los tiempos no están cargados | No es un error del usuario. Ocultar splits y tarjeta hasta que `result` deje de ser `null` |

### Pagos

| Código | HTTP | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta la cabecera `Idempotency-Key`, o es más corta de 8 caracteres | Bug del cliente: generarla y reintentar |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Esa clave ya se usó para cobrar otra cosa | Generar una clave nueva |
| `PAYMENT_DECLINED` | 402 | El proveedor rechazó el cobro. `details[0].reason` dice por qué | Pedir otro medio de pago y reintentar con **clave nueva** |
| `PAYMENT_METHOD_NOT_SUPPORTED` | 400 | El método existe pero el proveedor no lo atiende todavía | Ofrecer solo los métodos que `/config/app` habilite |
| `PAYMENT_ALREADY_SETTLED` | 409 | El pago ya está cerrado: no admite otra confirmación ni otro reembolso | Recargar el detalle |
| `RECEIPT_NOT_AVAILABLE` | 409 | Todavía no hay comprobante: el cobro no llegó a `paid` | Ocultar el botón hasta que esté `paid` |
| `INVALID_WEBHOOK_SIGNATURE` | 401 | Firma del webhook ausente, incorrecta o fuera de la ventana | No aplica al cliente móvil |

Motivos de rechazo (`failureReason`, y `details[0].reason` cuando viene en un
error): `card_declined`, `expired_card`, `invalid_card` y `qr_expired`. Son
códigos estables; el texto de `message` no lo es.

---

## Autenticación

### Endpoints

| Método | Ruta | Token | Qué hace |
|---|---|---|---|
| POST | `/auth/register` | — | Crea cuenta y **devuelve la sesión ya iniciada** |
| POST | `/auth/login` | — | Inicia sesión en un dispositivo |
| POST | `/auth/refresh` | — | Rota el refresh token |
| POST | `/auth/logout` | — | Cierra la sesión de este dispositivo (idempotente) |
| GET | `/auth/sessions` | Sí | Lista dispositivos con sesión activa |
| DELETE | `/auth/sessions/:id` | Sí | Cierra la sesión de otro dispositivo |
| POST | `/auth/forgot-password` | — | Pide enlace de recuperación |
| POST | `/auth/reset-password` | — | Cambia la contraseña con el token del correo |
| POST | `/auth/change-password` | Sí | Cambia la contraseña con la sesión abierta |
| GET | `/auth/me` | Sí | Datos del usuario autenticado |

`register`, `login`, `forgot-password`, `reset-password` y `change-password`
están limitados a **10 intentos por minuto y por IP**
(`AUTH_RATE_LIMIT_PER_MINUTE`).

### Email **o** CI

`login` recibe un solo campo, `identifier`. Si lleva `@` se trata como email; si
no, como **CI**. Se decide por el carácter y no consultando la base: un endpoint
que responde distinto según cuál acertó es un comprobador gratuito de quién tiene
cuenta.

En `register` hacen falta **email o CI, al menos uno**. La CI se guarda
normalizada (mayúsculas, sin espacios ni guiones): `1234567 LP`, `1234567-lp` y
`1234567LP` son la misma persona.

`/auth/me` devuelve `mustChangePassword`. Cuando es `true`, la contraseña la puso
otro —alta desde la web: usuario CI, contraseña CI— y la app **tiene que** mandar
al usuario a `/auth/change-password` antes de dejarle usar nada. Ver
[`pago-qr-manual.md`](./pago-qr-manual.md).

### El campo `deviceId`

Todos los endpoints de sesión aceptan `deviceId`, `deviceName` y `platform`. La
app **genera un UUID la primera vez y lo persiste**; no debe cambiar entre
arranques. Es lo que permite listar "Pixel 8", "iPad" como sesiones separadas y,
sobre todo, revocar la cadena de un dispositivo concreto si se detecta un robo.

### Ciclo de vida de los tokens

```
login/register  ──▶  accessToken (15 min)  +  refreshToken (60 días)
                            │
                    caduca a los 15 min
                            ▼
                     401 UNAUTHORIZED
                            │
                            ▼
  POST /auth/refresh { refreshToken }  ──▶  par NUEVO, 60 días desde ahora
                            │
                 el refresh viejo queda muerto
```

**El refresh rota siempre.** El token que mandaste deja de servir en el momento
en que recibes el nuevo. Guarda el nuevo antes de hacer nada más.

### Lo que el interceptor de Dio tiene que hacer bien

1. Adjuntar `Authorization: Bearer <accessToken>` en cada petición.
2. Ante `401`, disparar **un solo** refresh aunque haya diez peticiones en vuelo:
   hace falta un **mutex**. Sin él, diez `401` simultáneos disparan diez refresh
   concurrentes; el primero rota y **los otros nueve llegan con un token ya
   rotado**, lo que el servidor interpreta —correctamente— como reuso y cierra
   la sesión. Es el error más fácil de cometer aquí.
3. Reintentar la petición original con el token nuevo.
4. Si el refresh falla con `INVALID_REFRESH_TOKEN` o `TOKEN_REUSE_DETECTED`,
   limpiar el storage seguro e ir a Welcome.

Los tokens van en `flutter_secure_storage` (Keychain / Keystore), nunca en
`SharedPreferences`.

### `onboardingSeenAt`

`/auth/me` y las respuestas de login/registro traen `user.onboardingSeenAt`.
`null` significa que el usuario todavía no vio los slides. Se persiste en el
backend además de en local, así que **sobrevive a una reinstalación**: quien ya
vio el onboarding no lo vuelve a ver en un teléfono nuevo.

### Login social

Los botones de Google, LinkedIn y Facebook son solo UI por ahora. Ver
`src/modules/auth/social/README.md` para qué falta.

---

## Usuarios y perfil

Todo cuelga de `/users/me` y **todo exige token**. No hay endpoints por `userId`
a propósito: el usuario del token es el único que se puede leer o escribir, así
que no existe la clase de bug donde un id mal armado toca la cuenta de otro.

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/users/me` | Perfil completo (sin salud ni preferencias) |
| PATCH | `/users/me` | Nombre, email, ciudad, país, nacimiento, género, peso, altura, dorsal habitual |
| POST | `/users/me/avatar` | Sube o reemplaza el avatar (multipart, campo `file`) |
| DELETE | `/users/me/avatar` | Quita el avatar (idempotente) |
| GET | `/users/me/preferences` | Unidades, tema, idioma, notificaciones, privacidad, onboarding |
| PATCH | `/users/me/preferences` | Actualiza preferencias |
| GET | `/users/me/health` | Lesiones declaradas, sueño, hidratación |
| PATCH | `/users/me/health` | Actualiza los datos de salud |
| GET | `/users/me/highlights` | Kilometraje de la semana y carrera más larga |
| GET | `/users/me/shoes` | Zapatillas, la principal primero (`?includeRetired=true`) |
| POST | `/users/me/shoes` | Registra un par |
| PATCH | `/users/me/shoes/:id` | Edita, retira o marca como principal |
| DELETE | `/users/me/shoes/:id` | Borra el par |
| DELETE | `/users/me/data` | Borra la cuenta entera. Irreversible |

`GET /users/me` no incluye salud ni preferencias: son dos pantallas distintas de
la app y meterlas en la misma respuesta hace más pesada la llamada que se hace
en cada arranque para ahorrar dos que casi nunca se hacen.

### `null` vs ausente en los PATCH

Los tres PATCH son parciales y distinguen las dos cosas:

| Se envía | Efecto |
|---|---|
| `{ "city": "La Paz" }` | Escribe el valor |
| `{ "city": null }` | **Vacía** el campo |
| No se menciona `city` | Lo deja como está |

Sin esta distinción no habría forma de borrar un campo opcional una vez lleno.
Ojo en Flutter: un modelo que serialice todos los campos siempre, con los vacíos
en `null`, **borra** en cada guardado lo que el usuario no tocó. El repositorio
debe mandar solo lo que cambió.

### Preferencias: `notifications` y `privacy`

Son objetos libres de banderas (`push`, `raceReminders`, `shareWorkouts`,
`liveTrackingOptIn`, …) y el PATCH hace un **merge superficial**, no un
reemplazo. Así una versión vieja de la app que mande `{ "push": false }` no
borra en silencio los toggles que todavía no conoce.

`onboardingSeen` es un booleano de entrada y `onboardingSeenAt` una fecha de
salida: mandar `true` sella la hora del servidor la primera vez y **no la mueve**
si se repite; mandar `false` lo reabre, para poder volver a mostrar los slides
desde ajustes.

`injuryFlags`, en cambio, **sí se reemplaza entera**: es una lista editable en la
pantalla de salud, no una bolsa incremental.

### Avatar

`POST /users/me/avatar`, `multipart/form-data`, campo `file`, máximo **5 MB**
(`AVATAR_MAX_BYTES`).

El tipo real se decide **decodificando la imagen**, no leyendo el `Content-Type`
ni la extensión: los dos los escribe el cliente y los dos se falsifican en dos
segundos. Se acepta JPEG, PNG, WebP, AVIF, GIF, HEIF y TIFF; se rechaza SVG, que
es XML ejecutable y servirlo desde nuestro dominio sería un XSS.

Lo que llega nunca se guarda tal cual: se rota según el EXIF, se recorta a
cuadrado de 512 px y se reencoda a WebP. Ese reencode **elimina los metadatos
EXIF**, que en una foto de teléfono llevan las coordenadas GPS de dónde se tomó.
Un avatar no debería publicar la casa de nadie.

La respuesta trae `avatarUrl` absoluta, con el archivo servido bajo `/uploads/`
(fuera de `/api/v1`: es un binario público, no un endpoint, y una futura
`/api/v2` no debe cambiar la URL de una imagen ya guardada). En la base de datos
se guarda **la clave del archivo**, no la URL: mudar de dominio, de puerto o de
driver de almacenamiento no invalida ni una fila.

Cada subida usa un nombre con UUID nuevo, así que una URL dada nunca cambia de
contenido y se cachea de forma agresiva (`immutable`, 30 días).

### Zapatillas

- El **primer** par en uso queda como principal automáticamente: es a quien se
  le suman los kilómetros al consolidar un entrenamiento (Fase 10), y sin
  principal ese acumulador no tendría destino.
- Solo hay **una** principal a la vez; marcar otra desmarca la anterior en la
  misma transacción.
- **Retirar** un par lo saca de principal y lo oculta del listado
  (`?includeRetired=true` para verlo). Marcar principal un par retirado lo
  vuelve a poner en uso.
- `wearRatio` y `wearAlert` se calculan al leer sobre `alertThresholdMeters`
  (default **800 km**). `wearAlert` se enciende **al alcanzar** el umbral.
- `DELETE` borra de verdad: el kilometraje es un contador y cada entrenamiento
  guarda su propia distancia, así que no se pierde historial. Para conservar el
  registro de uso, retirar en vez de borrar.

### Highlights

`GET /users/me/highlights` devuelve la semana en curso y el récord de distancia:

```json
{
  "weekStartsAt": "2026-08-17T04:00:00.000Z",
  "weekEndsAt": "2026-08-24T04:00:00.000Z",
  "weekDistanceMeters": 15000,
  "weekWorkouts": 2,
  "longestWorkout": { "id": "...", "startedAt": "...", "distanceMeters": 42195,
                      "durationSeconds": 15000, "avgPaceSecPerKm": 355 },
  "totalDistanceMeters": 57195,
  "totalWorkouts": 3
}
```

La semana es **lunes–domingo en `DEFAULT_TIMEZONE`** (`America/La_Paz`), no en
UTC, y `weekEndsAt` es un límite **exclusivo**. En UTC-4, todo lo que se corre un
domingo después de las 20:00 locales ya es lunes en UTC y se sumaría a la semana
equivocada; por eso las fronteras se calculan en la zona de la app y se
devuelven como instantes UTC.

`longestWorkout` es `null` mientras no haya ningún entrenamiento con distancia.
Los borrados (`deletedAt`) no cuentan en ninguna de las cifras.

---

## Recorridos preestablecidos

Los trazados que reutilizan las carreras. Una ciudad tiene cuatro o cinco
circuitos homologados y cada edición vuelve a usar uno, así que el organizador
**elige** en vez de dibujar.

**Público**, por lo mismo que el catálogo: un trazado oficial es información de
difusión. Cargarlos y editarlos vive en `/admin/routes` y exige rol `admin`.

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/routes?city=&includeArchived=` | Los recorridos disponibles, sin geometría |
| GET | `/routes/:idOrSlug?full=` | Uno, con su `LineString`. Simplificado salvo `full=true` |
| GET | `/admin/routes` | Igual, archivados incluidos |
| POST | `/admin/routes` | Carga un recorrido |
| PUT | `/admin/routes/:id` | Edita o archiva |
| DELETE | `/admin/routes/:id` | Solo si ninguna maratón salió de él |

### La distancia se mide, no se declara

`POST /admin/routes` **no acepta** `distanceMeters`: se calcula sobre la
geometría (haversine sobre cada tramo) y de ahí salen también `startLat` y
`startLng`, desnormalizados desde el primer vértice. Un número escrito a mano
que no cuadre con el trazado deja una carrera cuyo mapa no llega a la meta, y
quien corre sigue el mapa.

Se rechaza con `VALIDATION_ERROR` lo que no sea un `LineString` de al menos dos
vértices, con pares **`[lng, lat]`** válidos, más de 100 m de largo y menos de
10.000 vértices (por encima de eso es un track de GPS crudo subido por error).

### La maratón se lleva una copia

`POST /admin/marathons` con `routeId` **copia** a la carrera el trazado, la
distancia medida y el punto de largada. `Marathon.routeId` queda solo como
procedencia: editar después el recorrido **no** toca las maratones que ya
salieron de él. El trazado de una carrera en pie es lo que se le enseñó a la
gente, no configuración.

Con `routeId`, `distanceMeters` sobra en el alta (y si viene, gana el del
recorrido). Sin `routeId` sigue siendo obligatorio. `routeId: null` en un PUT
desvincula sin borrar la geometría ya copiada.

Un recorrido **archivado** no se puede elegir para una carrera nueva
(`CONFLICT`), pero las que ya lo usaron siguen apuntando a él. Borrarlo con
maratones detrás también responde `CONFLICT`: lo que corresponde es archivar.

## Maratones

El catálogo es **público**: no exige token. Una maratón publicada es información
de difusión —se comparte por WhatsApp, se abre desde un deep link antes de
instalar la app y mañana la lee el front-end web—, y pedir registro solo para
mirar no protegería nada que no esté ya en el afiche. Inscribirse sí exige token
(Fase 7).

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/marathons` | Catálogo paginado por cursor |
| GET | `/marathons/upcoming?limit=` | Próximas carreras, para el carrusel del home |
| GET | `/marathons/:slug` | Detalle, con categorías y extras embebidos |
| GET | `/marathons/:id/categories` | Solo las categorías |
| GET | `/marathons/:id/extras` | Solo los extras |

`:slug` y `:id` son intercambiables en los tres últimos: se resuelve por
cualquiera de los dos. El detalle trae categorías y extras dentro porque son lo
que pinta la pantalla de detalle; los endpoints sueltos existen para el paso 2
de la inscripción, que ya no necesita el resto.

Filtros de `/marathons`: `city` (coincidencia parcial, insensible a mayúsculas),
`from` y `to` (fecha de largada, ISO, ambos inclusivos), `status`, `limit`
(1–50, por defecto 20) y `cursor`.

### Qué se ve y qué no

Solo se listan las maratones con `publishedAt` **no nulo y ya pasado**. Un
`publishedAt` futuro es un embargo: el organizador deja la carrera cargada y la
API la empieza a mostrar sola a la hora acordada. Lo no publicado da **404**
también al pedirlo por slug directo, así que adivinar la URL no adelanta nada.

### `registrationStatus` se deriva al leer

La columna del mismo nombre en la base guarda la **intención del admin** y solo
se respeta cuando dice `closed` (el interruptor manual para cerrar antes de
tiempo). Lo que responde la API se calcula en cada lectura, en este orden:

| Orden | Condición | Estado |
|---|---|---|
| 1 | La columna dice `closed` | `closed` |
| 2 | `registrationClosesAt` (o `startsAt` si es null) ya pasó | `closed` |
| 3 | `slotsTaken >= capacity` | `full` |
| 4 | Queda **menos del 10%** del cupo, **o** faltan **menos de 7 días** | `closing_soon` |
| 5 | Resto | `open` |

Se deriva en vez de guardarse porque un job que actualizara la columna dejaría
al dato mintiendo entre corrida y corrida, y ese dato decide si alguien puede
pagar o no. `slotsAvailable` (`capacity - slotsTaken`, nunca negativo) viene
resuelto para que la UI no lo calcule.

### Extras: `stock: null` no es "agotado"

`stock: null` significa **sin límite**. Para no obligar a la UI a aprenderse esa
distinción, cada extra trae además `available: boolean`, que ya la resuelve.

### Carreras

Todo se direcciona por **`registrationId`**, no por el id del resultado: la
inscripción existe desde que el corredor paga y el `RaceResult` no nace hasta que
cruza la meta. Colgar las rutas del resultado dejaría sin URL a la mitad de la
pantalla — la mitad de las carreras próximas.

### Endpoints

```
GET  /races/me/summary
GET  /races/me?status=upcoming|completed
GET  /races/:registrationId
GET  /races/:registrationId/splits
GET  /races/:registrationId/receipt
POST /races/:registrationId/share-card
```

Solo aparecen las inscripciones **confirmadas**. Un borrador a medias o una
cancelada no son una carrera y viven en `/registrations`.

### Próximas y pasadas

El corte lo pone `marathon.startsAt`, **no** la existencia del resultado: una
carrera de ayer cuyos tiempos todavía no se cargaron sigue siendo pasada.
Esconderla hasta que el organizador los suba dejaría al usuario mirando una lista
vacía el lunes por la mañana.

Las próximas se devuelven de la más cercana a la más lejana; las pasadas, de la
más reciente hacia atrás.

### El resultado

`result` es `null` mientras no haya resultado, y el resto del objeto viene igual:
dorsal, categoría, logística de `kitPickup` y hora de largada. La cuenta
regresiva la calcula el cliente contra `meta.timestamp`.

| Campo | Qué es |
|---|---|
| `finishTimeSeconds` | Tiempo oficial, desde `marathon.startsAt` hasta cruzar la meta |
| `chipTimeSeconds` | Reloj del propio corredor: de su salida a su llegada |
| `overallRank` / `categoryRank` | Puesto general y dentro de la categoría |
| `finishers` | Cuántos terminaron, para poder leer el puesto. Solo en el detalle |
| `bestKmIndex` | Índice **base 0** del kilómetro más rápido |
| `shareCardUrl` | PNG para compartir, si ya se generó |

La meta se cruza en el **último punto del recorrido**, no cuando el corredor
pulsa "finalizar" ni cuando el teléfono consigue subir el entrenamiento. Si el
tiempo desde la largada saliera negativo — un reloj desfasado, una prueba — el
oficial cae al del corredor: un número negativo en una clasificación es peor que
uno impreciso.

### Recorrido y marcadores

El detalle trae `routeGeoJson`: un `LineString` en orden **`[lng, lat]`**,
simplificado con **Douglas-Peucker** y con un tope duro de **2.000 vértices**.
Una maratón a 1 Hz son ~15.000 puntos y medio mega de JSON que el mapa no puede
dibujar; a 400 px de alto, dos posiciones separadas tres metros caen en el mismo
píxel. La tolerancia arranca en 5 m y sube sola hasta caber en el tope.

`checkpoints` son los pasos por los **5, 10, 15… km**, con `splitSeconds` desde la
largada. Salen del mismo recorrido filtrado que la distancia y los splits, e
interpolados dentro del tramo que cruza la marca: en modo ahorro de batería hay
30 s entre puntos y clavar el marcador en el siguiente regalaría medio minuto.

### Puestos

Se recalculan solos al cargarse cada resultado, ordenando por tiempo oficial con
la llegada como desempate. **Los empates comparten puesto**: dos corredores con el
mismo tiempo son ambos terceros y el siguiente es quinto.

### Comprobante y tarjeta

`GET /races/:registrationId/receipt` es un atajo sobre `/payments/:id/receipt`:
resuelve cuál fue el cobro y devuelve **el mismo** documento. Sin ningún pago en
`paid`, responde `RECEIPT_NOT_AVAILABLE`.

`POST /races/:registrationId/share-card` genera el PNG y devuelve su URL. Se
regenera en cada llamada sobre la misma URL, porque el puesto cambia cuando el
organizador carga los resultados que faltaban y una imagen cacheada seguiría
mostrando el viejo.

---

## Administración

Todo bajo `/api/v1/admin/*` y todo con rol `admin`, salvo el puñado de rutas
marcadas más abajo, que acepta también `organizer`. **Aquí vive la lógica del
panel**, no en el panel: la página de `/admin` es un cliente más de estos
endpoints, y el front-end web que venga después no tendrá que reimplementar ni
una acción.

Límite propio de 60 peticiones/minuto: estos endpoints escriben configuración de
precios, confirman cobros y exportan datos personales. Los usa una persona
haciendo clic, no una app.

### Roles

| Rol | Qué puede |
|---|---|
| `runner` | Nada de `/admin/*`. Es el rol del registro público |
| `organizer` | Administrar **cuentas de corredor** y validar **comprobantes de pago QR** |
| `admin` | Todo |

`organizer` es un admin recortado, pensado para quien atiende ventanilla el día
de la carrera: resetea contraseñas y da por buenos los comprobantes, pero **no
toca el producto**. En concreto, un organizador **no puede**:

- crear, editar, publicar, despublicar ni borrar maratones;
- subir el QR de cobro ni el afiche de una maratón;
- abrir ni cerrar inscripciones, dar la largada ni cortar la carrera;
- tocar categorías, extras, recorridos, el cargo por servicio ni los resultados;
- confirmar transferencias bancarias (eso es cuadrar un extracto, no revisar
  una captura);
- **administrar cuentas que no sean `runner`**, ni asignar un rol distinto de
  `runner`.

Esa última línea es la que sostiene todo lo anterior: sin ella un organizador se
daría `admin` a sí mismo, o resetearía la contraseña del admin y entraría como
él —un reset de contraseña es una toma de cuenta con otro nombre—. Se comprueba
en el servicio y no en el guard, porque lo que decide no es *qué* endpoint es
sino **sobre quién** se ejecuta, y eso solo se sabe leyendo la cuenta objetivo.
Al intentarlo salta `INSUFFICIENT_ROLE` (`403`).

Un organizador lo crea un admin desde `POST /admin/users` o `PUT /admin/users/:id`.

En el panel web, quien entra con `organizer` solo ve las pestañas **Comprobantes
QR** y **Usuarios**, y en el desplegable de rol solo le aparece `runner`.
Esconder el resto no es la protección —esa la ponen los guards—: es no ofrecer
botones que van a devolver `403`.

### Endpoints

```
GET    /admin/service-fee                          ← config global + overrides
PUT    /admin/service-fee                          ← activar / desactivar / reconfigurar
GET    /admin/service-fee/preview?subtotalCents=&marathonId=
PUT    /admin/marathons/:id/service-fee            ← override por maratón
DELETE /admin/marathons/:id/service-fee            ← volver a la global

GET    /admin/marathons                            ← admin | organizer · incluye las no publicadas
POST   /admin/marathons                            ← crear (nace como borrador)
GET    /admin/marathons/:id                        ← admin | organizer · detalle con categorías y extras
PUT    /admin/marathons/:id                        ← editar (parcial)
DELETE /admin/marathons/:id                        ← solo si no tiene inscritos
POST   /admin/marathons/:id/publish | /unpublish
POST   /admin/marathons/:id/close-registrations | /reopen-registrations
GET    /admin/marathons/:id/registrants.csv        ← admin | organizer

POST   /admin/marathons/:id/categories             ← categorías
PUT    /admin/categories/:categoryId
DELETE /admin/categories/:categoryId
POST   /admin/marathons/:id/extras                 ← adicionales
PUT    /admin/extras/:extraId
DELETE /admin/extras/:extraId

GET    /admin/registrations?marathonId=&status=
GET    /admin/payments?marathonId=&status=&page=&pageSize=  ← admin | organizer · los tickets, con `validatedBy`
GET    /admin/payments/pending-transfers
POST   /admin/payments/:id/confirm-transfer
POST   /admin/payments/:id/refund                   ← admin | organizer · devuelve y anula la inscripción

POST   /admin/marathons/:id/results                ← cargar tiempos por dorsal
POST   /admin/marathons/:id/recalculate-ranks

GET    /admin/users?q=&role=&page=&pageSize=       ← admin | organizer · `meta.total`; `q` busca email, CI, nombre y celular
POST   /admin/users                                ← admin | organizer · única forma de crear un admin
PUT    /admin/users/:id                            ← admin | organizer
POST   /admin/users/:id/password                   ← admin | organizer · cierra todas sus sesiones
DELETE /admin/users/:id                            ← admin | organizer

GET    /admin/payment-proofs                       ← admin | organizer · ver docs/pago-qr-manual.md
POST   /admin/payment-proofs/:id/approve           ← admin | organizer
POST   /admin/payment-proofs/:id/reject            ← admin | organizer
```

Las marcadas `admin | organizer` son **todo** lo que alcanza un organizador; el
resto de la lista le devuelve `403`. Sobre las de usuarios pesa además el techo
de la sección anterior: solo cuentas `runner`, también al **listar**.

Las lecturas de maratón (lista, detalle, mapa en vivo y CSV) están abiertas al
organizador porque sin ellas no puede saber a qué carrera pertenece el cobro que
está validando. Las escrituras que mueven la carrera —crear, editar, publicar,
preparar, largar, cortar— siguen siendo solo de `admin`.

`POST /admin/payments/:id/refund` **anula la inscripción**, no solo mueve
dinero: quien recupera su plata no corre, así que el cupo vuelve al pozo y el
stock de los adicionales también, por el mismo camino que un reembolso del
proveedor (`liberarPorReembolso`). Solo sobre un cobro `paid`, idempotente, y
con `reason` obligatorio. Fuera de tarjeta no hay proveedor a quien pedírselo:
el dinero lo devuelve una persona por el mismo canal por el que entró, y lo que
queda aquí es el asiento de **quién lo ordenó y por qué** — que sale luego en
`refundedBy` / `refundReason`, sin pisar el `validatedBy` de quien lo había
aprobado.

`GET /admin/payments` es la cola de trabajo del organizador: una sola lista para
los dos métodos que se validan a mano. Cada fila trae `validatedBy` —**el nombre
de quien dio el cobro por pagado**, que es el dato de auditoría— y el `proofId`
que hay que aprobar o rechazar; sin `proofId`, lo que aplica es
`POST /admin/payments/:id/confirm-transfer`.

### El cargo por servicio y su vista previa

`PUT /admin/service-fee` con `enabled: false` apaga el cargo: el total deja de
llevarlo **y la línea desaparece** de la cotización. Un "Bs 0,00" le promete al
usuario un cargo que hoy no se cobra.

La vista previa se calcula con la **misma función** que cobra de verdad, así que
no puede desviarse de la realidad. Es la mitad útil de la acción: un
`percentBps: 1000` con `minCents: 500` no le dice a nadie cuánto va a pagar la
gente.

El override de una maratón manda **aunque venga apagado**: una carrera con una
config `enabled: false` no cobra cargo, en vez de caer de vuelta a la global. Sin
eso no habría forma de eximir a una sola carrera.

### Alta, edición y baja de maratones

```json
POST /admin/marathons
{ "name": "Maratón La Paz 3600", "startsAt": "2026-09-13T11:00:00.000Z", "city": "La Paz",
  "distanceMeters": 42195, "capacity": 2000, "priceCents": 25000 }
```

Obligatorios los seis de arriba: sin fecha, cupo o precio no se puede ni listar
ni cobrar. Lo demás —cronograma, portada, qué incluye— se completa después, que
es como se trabaja: la carrera se carga en cuanto se confirma y el cronograma
llega semanas más tarde.

Nace **como borrador** salvo que se mande `published: true`. Publicarla sola la
metería en el catálogo antes de que nadie la revise, y despublicar después de que
la vio medio país no deshace nada.

Sin `slug` se deriva del nombre (sin acentos, en minúsculas, con guiones) y se
desambigua con `-2`, `-3`… en vez de fallar: quien carga la tercera edición de una
carrera escribe el mismo nombre a propósito.

`PUT /admin/marathons/:id` es **parcial**: lo que no venga no se toca, y `null`
sí vacía el campo. Son cosas distintas y por eso no se puede mandar el objeto
entero con huecos.

`DELETE /admin/marathons/:id` **se niega con inscritos** (`CONFLICT`): el borrado
en cascada se llevaría pagos, dorsales y resultados. Para una carrera vendida lo
que corresponde es despublicarla.

`capacity` puede bajarse por debajo de los cupos ya vendidos y no se impide: a
veces el municipio recorta el cupo después de vender. Lo que no pasa es que eso
cancele inscripciones — la carrera queda sobrevendida y a la vista en
`slotsTaken / capacity`.

### Categorías y adicionales

```
POST   /admin/marathons/:id/categories
PUT    /admin/categories/:categoryId
DELETE /admin/categories/:categoryId

POST   /admin/marathons/:id/extras
PUT    /admin/extras/:extraId
DELETE /admin/extras/:extraId
```

Borrar una categoría **no borra inscripciones**: la relación es
`onDelete: SetNull`, así que se quedan sin categoría pero con su dorsal y su pago
intactos. La respuesta dice cuántas quedaron así, porque es algo que el
organizador va a querer arreglar antes de imprimir resultados.

Borrar un adicional tampoco pierde lo vendido: los extras de una inscripción
viven copiados en su `quoteSnapshot`, no como referencia a la fila. Borrarlo solo
significa que deja de poder comprarse. `stock: null` es sin límite, no agotado.

### Alta, edición y baja de usuarios

```
POST   /admin/users            ← { email, name, password, role?, verified? }
PUT    /admin/users/:id        ← email, name, role, verified (parcial)
POST   /admin/users/:id/password
DELETE /admin/users/:id
```

`POST /admin/users` es la **única** forma de crear un administrador: el registro
público crea `runner` y punto, porque un endpoint abierto que acepte `role` es un
escalado de privilegios esperando a que alguien lo pruebe. La contraseña pasa por
la misma política y el mismo hash (argon2id, 64 MiB) que el registro normal: dos
juegos de parámetros darían cuentas con seguridad distinta según por dónde
entraron.

El email queda **verificado** salvo que se mande `verified: false`: una cuenta
creada a mano ya pasó por una persona, y dejarla sin verificar la deja a medio
camino sin que nadie le haya mandado el correo.

Un organizador puede usar estos cinco endpoints, pero **solo contra cuentas
`runner`** y sin repartir otro rol que `runner`: contra un admin u otro
organizador responden `INSUFFICIENT_ROLE` (`403`).

Un admin no puede quitarse a sí mismo el rol ni borrarse desde el panel
(`CONFLICT` en ambos): lo primero dejaría el panel sin nadie que pueda entrar y
solo se arregla tocando la base a mano.

`POST /admin/users/:id/password` **cierra todas sus sesiones**. Un reset que deja
vivos los refresh tokens no sirve para lo único que se usa de verdad —sacar a
quien no debería estar dentro—, porque el intruso sigue renovando su token sin
saber la contraseña nueva. Devuelve `sessionsRevoked`.

`DELETE /admin/users/:id` es el **mismo camino** que el borrado que pide el propio
usuario: suelta los cupos de sus carreras futuras y borra sus archivos. Un
`DELETE` directo dejaría plazas ocupadas por alguien que ya no existe.

### Publicar y cerrar

Despublicar **no cancela nada**: las inscripciones vendidas siguen existiendo y
sus dueños siguen viendo su carrera. Solo desaparece del catálogo.

`registrationStatus` guarda la **intención** del admin y solo manda cuando dice
`closed`; el resto (llena, por cerrar, abierta) se deriva de cupos y fechas al
leer. Por eso la respuesta trae los dos: `intent` y `resolved`. Una maratón
reabierta pero llena sigue saliendo `full`, y eso no es un fallo.

### Confirmar una transferencia

`POST /admin/payments/:id/confirm-transfer` es la única vía de cobro que no pasa
por el proveedor, y no puede pasar: quien confirma es una persona que ha visto el
dinero en el banco. Solo aplica a `bank_transfer` (`PAYMENT_METHOD_NOT_SUPPORTED`
en otro caso) y solo si sigue `pending` (`PAYMENT_ALREADY_SETTLED` si no).

**Toma el cupo y emite el dorsal en la misma transacción que un cobro normal**,
porque llama al mismo servicio. No hay una segunda forma de acreditar un pago:
eso es como se acaba con dos personas con el mismo dorsal.

### Cargar resultados

```json
POST /admin/marathons/:id/results
{ "results": [{ "bibNumber": "MLP-0001", "finishTimeSeconds": 10850, "chipTimeSeconds": 10800 }] }
→ { "imported": 128, "skipped": 2, "unknownBibs": ["MLP-9999"] }
```

Llegan **por dorsal**, que es como los entrega cualquier cronometraje. Un dorsal
desconocido no tumba la carga: una lista de 3.000 líneas con dos erratas tiene
que poder subirse igual. Es idempotente —reimportar reescribe lo mismo— y los
puestos se recalculan **una sola vez al final**, no por fila.

`distanceMeters` y `finishedAt` son opcionales: por defecto, la distancia de la
maratón y la hora de largada más el tiempo oficial.

### Exportar inscritos

`GET /admin/marathons/:id/registrants.csv` devuelve un **archivo**, fuera del
sobre `{ data, meta }`: envolver un CSV en JSON obligaría al navegador a
desenvolverlo con JavaScript para descargarlo.

Lleva BOM UTF-8 (sin él, Excel en Windows rompe los acentos) y las celdas que
empiezan por `=`, `+`, `-` o `@` van neutralizadas con una comilla: un CSV no
debe ejecutar nada al abrirse, y el vector es un campo que rellena el usuario.

### La página

`GET /admin` sirve el panel. Es HTML **sin un solo dato dentro**: pide
credenciales, saca un token por `/auth/login` y a partir de ahí todo pasa por los
endpoints de arriba. Vive fuera del prefijo versionado porque es una página, no
un endpoint.

Tiene el CRUD completo: crear y editar maratones con sus categorías y sus
adicionales, y dar de alta, editar, resetear la contraseña o borrar usuarios.
Todo eso son llamadas a los endpoints de esta sección — la página no sabe una
sola regla que la API no sepa, que es lo que permite cambiarla por un front-end
web sin reimplementar nada.

---

## Paginación del catálogo

Estándar de la casa: `?limit=&cursor=`, respuesta con `meta.nextCursor`, y se
pagina **hasta que `nextCursor` sea `null`** — nunca hasta que una página venga
vacía.

Esa distinción importa aquí de verdad: cuando se filtra por `status`, el filtro
se aplica sobre el estado ya derivado, así que **una página puede venir corta o
incluso vacía y traer `nextCursor` igual**. Es el precio de que la regla del
estado viva en un solo lugar en vez de estar copiada en SQL. Sin filtro de
estado —el caso normal— cada página es una sola consulta y viene completa.

Un cursor inválido o vencido no da error: se empieza desde el principio.

---

## Precios y cargo por servicio

**El precio nunca se calcula en el móvil.** `QuoteService` es la única fuente
del total: cuota base + recargo de categoría + extras + cargo por servicio. El
cliente pinta lo que responde `/quote` y al confirmar el backend vuelve a
cotizar, así que si el organizador cambió un precio mientras el usuario dudaba,
se cobra el real y no el que quedó en pantalla.

### `POST /pricing/quote`

Cotización de vista previa, **antes** de que exista una inscripción. Público,
como el catálogo: se calcula solo sobre datos públicos y no crea ni reserva
nada. Es `POST` porque los extras son un array de objetos y meterlos en la query
string obligaría a inventar una serialización propia.

```json
POST /api/v1/pricing/quote
{ "marathonId": "maraton-la-paz-3600",
  "categoryId": "cat_...",
  "extras": [{ "extraId": "ext_...", "quantity": 2 }] }
```

```json
{ "data": {
    "marathonId": "cm...", "currency": "BOB",
    "items": [
      { "type": "base",     "refId": null,     "label": "Inscripcion", "quantity": 1, "unitPriceCents": 25000, "amountCents": 25000 },
      { "type": "category", "refId": "cat_...", "label": "Elite masculino", "quantity": 1, "unitPriceCents": 0, "amountCents": 0 },
      { "type": "extra",    "refId": "ext_...", "label": "Remera tecnica", "quantity": 2, "unitPriceCents": 12000, "amountCents": 24000 }
    ],
    "subtotalCents": 49000,
    "serviceFee": null,
    "totalCents": 49000 } }
```

Notas del contrato:

- Cotizar **no reserva** cupo ni stock, y se permite cotizar una carrera cerrada
  o llena: es información. Quien decide si se puede comprar es el checkout
  (Fase 7).
- La línea de categoría aparece aunque su recargo sea `0`, para que la UI pueda
  mostrar qué eligió el usuario.
- El mismo `extraId` repetido se agrupa: mandarlo dos veces con `quantity: 1`
  vale y limita igual que una vez con `quantity: 2`. Máximo 10 unidades por
  extra.
- Durante el flujo de 3 pasos manda `GET /registrations/:id/quote` (Fase 7), que
  cotiza lo guardado en la inscripción.

### `serviceFee: null` no es `0`

Cuando no hay cargo, el campo viaja como **`null`** y la UI **no debe pintar la
línea**. Un "Cargo por servicio — Bs 0,00" le anuncia al usuario que existe un
cargo que hoy no se le cobra, y esa es una promesa que nadie quiso hacer. Por eso
el estado "apagado" se expresa como ausencia y no como cero.

Hoy el cargo está **desactivado por defecto** (`enabled = false` en el seed), así
que en desarrollo el camino normal es `serviceFee: null`.

### Cómo se resuelve el cargo

| Orden | Situación | Resultado |
|---|---|---|
| 1 | La maratón tiene `serviceFeeConfigId` | Manda esa config, **encendida o apagada** |
| 2 | No tiene override | Manda la config global |
| 3 | No hay ninguna config | Sin cargo |

Que el override apagado **no caiga de vuelta a la global** es deliberado: una
maratón apuntando a una config con `enabled = false` significa "esta carrera no
cobra cargo". Si cayera a la global no habría forma de eximir a una sola carrera
sin apagar el cargo para todas.

Tipos de cargo: `percent` (puntos básicos: 1000 = 10%), `fixed` (monto fijo) y
`mixed` (los dos sumados). Sobre el resultado se aplican `minCents` y `maxCents`
si están cargados; con los dos cruzados, **manda el máximo**. Un subtotal de `0`
—carrera gratuita— no genera cargo **ni siquiera el mínimo**.

Todo el dinero es en centavos enteros y el porcentaje en puntos básicos: nunca
hay un `float` en el cálculo. El redondeo es al centavo más cercano, con los
medios hacia arriba.

### El snapshot

Al confirmar una inscripción se guarda en `Registration.serviceFeeSnapshot` una
copia exacta de la config aplicada, más el subtotal sobre el que se calculó y el
monto resultante. Cambiar el cargo después **no altera comprobantes históricos**,
y el snapshot alcanza por sí solo para reauditar el número sin la config viva.

El snapshot **no viaja al cliente**: lleva configuración interna y no le sirve de
nada a la app.

---

## Inscripciones

Tres pasos, todos con token, y **todo es del usuario del token**: ninguna ruta
recibe un `userId`. El campo `step` (1..3) de la respuesta dice dónde quedó el
flujo, para retomarlo después de cerrar la app.

| Método | Ruta | Paso | Qué hace |
|---|---|---|---|
| GET | `/registrations` | — | Mis inscripciones. `?status=`, `?marathonId=` |
| POST | `/registrations` | 1 | Crea el borrador con los datos personales |
| GET | `/registrations/:id` | — | Detalle |
| PATCH | `/registrations/:id/category-extras` | 2 | Categoría y adicionales |
| GET | `/registrations/:id/quote` | 2 | Total en vivo, en cada cambio |
| POST | `/registrations/:id/checkout` | 3 | Términos, **cobro**, cupo y dorsal. Ver Pagos |
| DELETE | `/registrations/:id` | — | Cancela y libera el cupo |

### Retomar un borrador

`POST /registrations` es **idempotente por maratón**: si ya hay un borrador para
esa carrera lo devuelve actualizado en vez de crear otro. Quien cierra la app en
el paso 2 y vuelve mañana entra por el mismo sitio y encuentra lo suyo, no un
duplicado. Si perdiste el id, `GET /registrations?marathonId=<slug>` lo
recupera. Si ya hay una inscripción **confirmada**, responde
`ALREADY_REGISTERED`.

### Paso 2: la lista de extras reemplaza

`extras` es la selección completa de una pantalla de checkboxes, no un
incremento: mandar `[]` deja la inscripción sin adicionales, y `categoryId:
null` quita la categoría. Sumar obligaría a inventar un endpoint para quitar.

Cada llamada recotiza y guarda los totales, así que `GET /registrations/:id/quote`
y el detalle siempre coinciden. Los extras se guardan **resueltos**, con nombre y
precio del día.

### Paso 3: qué pasa exactamente en el checkout

El paso 3 es un cobro, así que vive en la sección **Pagos** de este documento:
el cuerpo lleva el método de pago, la petición lleva `Idempotency-Key`, y la
respuesta trae el pago y la inscripción juntos.

Lo que hay que retener aquí es el orden, porque es lo que evita que alguien
quede cobrado y sin carrera:

1. Se revalida que las inscripciones sigan abiertas, que quede cupo y que estén
   la categoría y los datos personales. **Nadie paga por una carrera cerrada.**
2. **Se recalcula el precio.** No se confía en el total que vio el cliente: si
   el organizador cambió un precio mientras el usuario dudaba, se cobra el real.
   El desglose queda congelado antes de cobrar.
3. Se cobra contra el proveedor.
4. Con el cobro aprobado, y dentro de **una transacción con la fila de la
   maratón bloqueada** (`SELECT ... FOR UPDATE`), se descuenta el stock de los
   adicionales, se asigna el dorsal y se incrementa `slotsTaken`.
5. Si ese último paso falla —el último cupo se fue mientras se procesaba la
   tarjeta— **se reembolsa automáticamente** y se devuelve `MARATHON_FULL`.

Sin el bloqueo del punto 4, dos personas comprando el último cupo a la vez leen
ambas `slotsTaken = 999`, ambas concluyen que hay lugar y ambas entran. Con él,
la segunda recibe `MARATHON_FULL`. Hay un test e2e que lanza los dos checkout en
paralelo y verifica que entra una sola, y que la que pierde no queda cobrada.

### Dorsales

Formato `MLP-0042`: tres letras derivadas del nombre de la carrera + correlativo
de cuatro dígitos, único por maratón. El correlativo cuenta los dorsales **ya
emitidos, incluidos los de inscripciones canceladas** — esas conservan el suyo
como registro histórico —, así que un número nunca se reutiliza. Pasados los
9999 el dorsal simplemente crece a cinco dígitos: mejor un dorsal feo que una
carrera que no deja inscribir a nadie más.

### Precios: vivos mientras es borrador, congelados después

| Estado | `items`, `subtotalCents`, `serviceFee`, `totalCents` |
|---|---|
| `draft`, `pending_payment` | Se **recalculan** en cada lectura, con los precios de hoy |
| `confirmed`, `cancelled` | Vienen del **desglose congelado** al confirmar |

Mostrarle a alguien que ya pagó un total distinto del que pagó, porque el
organizador subió un precio, no es una opción. El listado (`GET /registrations`)
no recotiza: devuelve los totales guardados, porque recotizar sería una consulta
por inscripción.

### Cancelación

Solo si la carrera **todavía no ocurrió**. Libera el cupo y devuelve el stock de
los adicionales, dentro del mismo bloqueo. Es **idempotente**: cancelar dos veces
responde ok igual. Después de cancelar se puede volver a empezar el flujo.

Los cobros ya pagados se **reembolsan** al cancelar: ver «Cancelar devuelve el
dinero» en la sección de Pagos.

---

## Pagos

Proveedor **simulado** detrás de una interfaz (`PaymentProvider`). El día que
entre un proveedor real —QR Simple del BCB vía banco adquirente, una pasarela
local— cambia el driver y nada más: ni los endpoints, ni los estados, ni la
tabla `payments`.

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/registrations/:id/checkout` | Paso 3: cobra y confirma. Requiere `Idempotency-Key` |
| GET | `/registrations/:id/payments` | Intentos de cobro de esa inscripción, del más nuevo al más viejo |
| GET | `/payments/:id` | Detalle de un pago propio. Es el **polling** del QR |
| POST | `/payments/:id/mock-confirm` | Fuerza el cierre de un cobro pendiente. **Solo desarrollo** |
| GET | `/payments/:id/receipt` | Comprobante en PDF (URL estable) |
| POST | `/payments/webhook` | Eventos del proveedor. **Público**, firmado con HMAC |
| POST | `/payments/:id/proof` | **Temporal** — sube el comprobante de un cobro `qr_manual` |
| GET | `/payments/:id/proof` | **Temporal** — el último comprobante subido, o `null` |

### Cobro por QR con verificación manual (temporal)

Mientras no haya pasarela contratada existe un cuarto método, `qr_manual`: se
muestra el QR bancario del organizador, el corredor sube una captura del pago y
**un organizador verifica antes de confirmar nada**. Subir el comprobante deja
`proof.status = in_review` y el cobro **sigue `pending`**: no hay dorsal ni cupo
tomado hasta que alguien aprueba.

Va con su propia web pública de inscripción (`/public/registrations`), su cola de
revisión (`/admin/payment-proofs`) y su propio documento, que explica el flujo
entero y cómo se desmonta: **[`pago-qr-manual.md`](./pago-qr-manual.md)**.

### El cuerpo del checkout

```json
{
  "termsAccepted": true,
  "method": "card",
  "card": {
    "number": "4242424242424242",
    "holder": "ALVARO QUISPE",
    "expMonth": 12,
    "expYear": 2030,
    "cvv": "123"
  }
}
```

`termsAccepted` tiene que ser exactamente `true`. El objeto `card` solo va
cuando `method` es `card`; `qr` y `bank_transfer` no llevan cuerpo adicional.

La respuesta trae el cobro y la inscripción **juntos**:

```json
{
  "data": {
    "payment": { "id": "...", "status": "paid", "amountCents": 20000, "currency": "BOB",
                 "methodDetails": { "brand": "visa", "last4": "4242" } },
    "registration": { "status": "confirmed", "bibNumber": "MLP-0001", "..." : "..." }
  }
}
```

Van en la misma respuesta a propósito: después de pagar hay que pintar el dorsal
y el estado nuevo, y una segunda llamada solo para eso deja una ventana en la
que el usuario ve "pagado" y "sin dorsal" a la vez.

### Tarjetas de prueba

| Número | Resultado |
|---|---|
| `4242 4242 4242 4242` | Aprueba |
| `4000 0000 0000 0002` | Rechaza (`card_declined`) |
| `4000 0000 0000 0069` | Tarjeta vencida (`expired_card`) |

Cualquier otra tarjeta estructuralmente válida (pasa Luhn, CVV de 3 o 4 dígitos,
fecha futura) se aprueba, para que los seeds y las pruebas manuales no tengan
que memorizar números. Lo que no pasa esa validación se rechaza con
`invalid_card`.

### Del número de tarjeta no se guarda nada

Solo `brand` y `last4`, ni siquiera en desarrollo. El PAN completo lo ve
únicamente el driver del proveedor, en memoria, durante la petición: no entra a
la base y no entra a los logs —lo que entra a un log termina en disco, rotado y
copiado a un backup—.

### Los tres métodos de pago

En Bolivia la tarjeta no es el medio dominante, así que la UI tiene que
contemplar los tres desde ahora. Cambia **cuándo** se resuelve el cobro, no el
resto del flujo:

| `method` | Qué devuelve el checkout | Cómo se cierra |
|---|---|---|
| `card` | `payment.status: "paid"` y la inscripción ya `confirmed` | En el mismo request |
| `qr` | `payment.status: "pending"` + PNG en `methodDetails.qr` y `expiresAt` | Sondeando `GET /payments/:id` |
| `bank_transfer` | `payment.status: "pending"` + datos bancarios en `methodDetails.bank` | Confirmación manual desde el panel |

En los dos métodos asíncronos la inscripción se queda en `pending_payment`, sin
dorsal y **sin cupo tomado**. El cupo se toma en el mismo instante en que el
cobro pasa a `paid`, sea cuando sea.

### QR

```json
{
  "payment": {
    "status": "pending",
    "method": "qr",
    "expiresAt": "2026-08-19T15:40:00.000Z",
    "methodDetails": {
      "qr": {
        "imageUrl": "https://api.example/uploads/payments/qr/mock_pi_ab12.png",
        "payload": "PACEUP-QR|mock_pi_ab12|20000|BOB|reg_xyz"
      }
    }
  },
  "registration": { "status": "pending_payment", "bibNumber": null }
}
```

`imageUrl` es un PNG real, no un placeholder: se puede enfocar con la cámara y
sirve para comprobar que el tamaño elegido es escaneable. `payload` es lo que
codifica, para el botón de "copiar código".

**Polling:** sondea `GET /payments/:id` cada 2–3 s y mira `status`. Deja de
sondear en cuanto salga de `pending`. Cada lectura resuelve el cobro si ya toca
—se pagó, o caducó—, así que no hace falta ningún otro endpoint.

| `status` | Qué mostrar |
|---|---|
| `pending` | El QR, con la cuenta atrás hasta `expiresAt` |
| `paid` | Éxito. La inscripción ya tiene dorsal: recárgala o usa la de `mock-confirm` |
| `failed` con `qr_expired` | El QR venció. Ofrecer generar uno nuevo (otro checkout con **clave nueva**) |
| `refunded` | El cobro pasó pero el último cupo se fue: se devolvió el dinero |

En el mock el QR se paga solo a los `PAYMENT_QR_AUTO_CONFIRM_SECONDS` (8 s por
defecto) para que el polling tenga algo real que observar, y caduca a los
`PAYMENT_QR_TTL_MINUTES`.

### Transferencia bancaria

```json
{
  "methodDetails": {
    "bank": {
      "bankName": "Banco Nacional de Bolivia",
      "accountNumber": "1000-0000-0000",
      "accountType": "Caja de ahorro",
      "holder": "PaceUp SRL",
      "nit": "0000000000",
      "reference": "PACEUP-A1B2C3D4"
    }
  }
}
```

`reference` es la glosa que el usuario tiene que poner en la transferencia: es
lo que permite a quien confirma a mano saber a qué inscripción corresponde.
Muéstrala destacada y con botón de copiar.

**No caduca y no se paga sola.** Una transferencia entre bancos puede tardar un
día hábil, y caducarla dejaría al usuario con el dinero enviado y la inscripción
muerta. Queda `pending` hasta que alguien la confirme desde el panel de admin.
Sondear no la resuelve.

### `POST /payments/:id/mock-confirm` — solo desarrollo

Fuerza el cierre de un cobro pendiente, para no esperar los segundos del QR ni
montar un banco falso mientras pruebas la pantalla a mano. Devuelve lo mismo que
el checkout (`{ payment, registration }`).

**En producción responde 404.** Un endpoint que da por pagado lo que nadie pagó
no puede existir donde hay dinero de verdad, aunque esté autenticado.

### Un rechazo no consume nada

La inscripción se queda en `pending_payment`, sin dorsal y sin cupo tomado, y se
puede reintentar con otra tarjeta usando una **clave de idempotencia nueva**.
Los rechazos quedan en el historial: `GET /registrations/:id/payments` los
devuelve junto al cobro que sí pasó, que es lo que se pinta en Races.


### Comprobante en PDF

`GET /payments/:id/receipt` devuelve `{ "url": "…/uploads/payments/receipts/<id>.pdf" }`.
El PDF está en español, con los montos en `Bs 1.234,56` y los datos fiscales
(`INVOICE_LEGAL_NAME`, `INVOICE_NIT`, `INVOICE_ADDRESS`) que después editará el
panel. Lleva el corredor, la carrera, el dorsal, el desglose congelado, el
cargo por servicio si lo hubo, y la forma de pago (marca y últimos cuatro, o la
referencia de la transferencia).

Se genera la primera vez y se cachea en `Payment.receiptUrl`: sale de los datos
**congelados** de la inscripción, así que regenerarlo daría siempre lo mismo.
La URL es estable — puedes guardarla y compartirla.

**No es una factura.** El propio documento lo dice en el pie: no está dosificado
ante Impuestos Nacionales y no da derecho a crédito fiscal. Si el cobro no llegó
a `paid`, responde `RECEIPT_NOT_AVAILABLE`.

### Webhook del proveedor

`POST /payments/webhook` es **público** —quien llama es un servidor, no un
usuario— y se autentica con **firma HMAC** sobre el cuerpo crudo, con el mismo
formato que usa un PSP real:

```
X-Paceup-Signature: t=1755600000,v1=<hmac-sha256 hex de "t.cuerpo">
```

El cuerpo del evento:

```json
{
  "id": "evt_a1b2c3",
  "type": "payment.paid",
  "createdAt": "2026-08-19T15:04:00.000Z",
  "data": { "externalId": "mock_pi_a1b2c3", "failureReason": null }
}
```

| `type` | Qué hace |
|---|---|
| `payment.paid` | Da el cobro por cobrado y confirma la inscripción: cupo y dorsal |
| `payment.failed` | Cierra el cobro con `failureReason`. No toca la inscripción |
| `payment.refunded` | Marca el cobro `refunded`, suelta el cupo y deja la inscripción en `refunded` |

**Respuestas.** Si la firma es válida siempre responde `200`, aunque el evento no
se pueda aplicar:

```json
{ "received": true, "handled": false, "reason": "unknown_payment" }
```

Es deliberado: un proveedor que recibe un error reintenta, y reintentar un
evento que nunca vamos a poder procesar es un bucle infinito con nuestro nombre
encima. Los `reason` posibles son `unknown_payment`, `already_settled`,
`not_paid` y `unsupported_event`.

Solo la firma inválida corta, con `401 INVALID_WEBHOOK_SIGNATURE`. Los tres
motivos —falta la cabecera, no cuadra, llegó fuera de la ventana de
`PAYMENT_WEBHOOK_TOLERANCE_SECONDS`— responden lo mismo a propósito:
distinguirlos le diría a quien está probando cuál de las tres cosas acertó.

**No hay tabla de eventos procesados** y no hace falta: las tres operaciones son
idempotentes por estado, así que reenviar un evento no emite un segundo dorsal
ni reembolsa dos veces. Hay tests e2e que lo comprueban.

### `cancelled` vs `refunded`

Dos formas de perder la plaza, y la API las distingue porque la diferencia
importa cuando alguien mire por qué se quedó sin ella:

| Estado de la inscripción | Cuándo |
|---|---|
| `cancelled` | **El usuario** canceló (`DELETE /registrations/:id`). Se le devuelve el dinero |
| `refunded` | El **proveedor** devolvió el cobro: una devolución, un contracargo |

En los dos casos el cupo y el stock vuelven al pozo, y el dorsal se conserva
como registro histórico.

### Cancelar devuelve el dinero

`DELETE /registrations/:id` reembolsa todos los cobros en `paid` de esa
inscripción y los deja en `refunded` con `failureReason: "cancelled_by_user"`.

El reembolso va **después** de liberar el cupo y no puede tumbar la cancelación:
si el proveedor está caído, el cupo ya volvió al pozo y lo que queda pendiente es
devolver dinero, resoluble a mano desde el panel. Al revés, un fallo dejaría la
plaza bloqueada para siempre. Sigue siendo idempotente: cancelar dos veces no
reembolsa dos veces.

---

## Planes de entrenamiento

Un plan es una **proyección** de una plantilla sobre el calendario del corredor.
La plantilla dice "semana 3, martes, rodaje suave, `paceFactor` 1.15"; el plan
dice "martes 22 de septiembre, 8 km entre 4:56 y 5:21". Todo lo que convierte lo
primero en lo segundo pasa en el backend.

### Endpoints

| Método | Ruta | Token | Qué hace |
|---|---|---|---|
| `GET` | `/training-plans/templates?goalDistance=&level=&weeks=` | no | Catálogo de plantillas |
| `GET` | `/training-plans/templates/:slug` | no | Detalle con todas las sesiones. Acepta slug o id |
| `GET` | `/training-plans/suggestions?marathonId=` | no | Plantillas que sirven para esa maratón |
| `GET` | `/training-plans/me` | sí | Plan activo + historial |
| `GET` | `/training-plans/me/current?week=` | sí | Una semana del plan activo |
| `POST` | `/training-plans` | sí | Instanciar un plan |
| `PATCH` | `/training-plans/sessions/:id/complete` | sí | Marcar hecha (o saltada) |
| `PATCH` | `/training-plans/sessions/:id/reschedule` | sí | Mover de día |
| `PATCH` | `/training-plans/:id/abandon` | sí | Abandonar el plan activo |
| `POST` | `/training-plans/:id/restart` | sí | Volver a empezar desde otra fecha |
| `DELETE` | `/training-plans/:id` | sí | Borrar el plan |

El catálogo es público por lo mismo que el de maratones: es material de difusión.
Todo lo que cuelga de `me`, de `sessions` o de un id de plan exige token y solo
devuelve lo del usuario del token. Un plan ajeno responde **404, no 403**, igual
que en inscripciones.

**El catálogo no pagina.** Son ocho plantillas de arranque y crecerán a decenas,
no a miles: la respuesta viene entera. El día que haga falta se agrega
`meta.nextCursor` sin romper a los clientes que ya lo ignoran.

### Los dos caminos para empezar un plan

**A. El usuario elige del catálogo.** `GET /training-plans/templates`, y luego
`POST /training-plans { templateId, startDate? }`. Sin `startDate` el plan
arranca el lunes siguiente. Cualquier fecha que se mande se **redondea hacia
adelante** al lunes: los planes se viven en semanas Lunes–Domingo, y arrancar un
miércoles dejaría una primera semana coja.

**B. El usuario elige una maratón objetivo.** `GET /training-plans/suggestions?marathonId=`
y luego `POST /training-plans { templateId, marathonId }`. Aquí `startDate` se
ignora: la fecha sale de la carrera.

### Sugerencias: `fits: false` no es "descartada"

```json
{
  "template": { "slug": "21k-intermedio-12s", "totalWeeks": 12, "level": "intermediate" },
  "weeksAvailable": 9,
  "fits": false,
  "effectiveWeeks": 9
}
```

- `weeksAvailable` — semanas completas desde el lunes que viene hasta la semana
  de la carrera, **inclusive**. Si la largada es un domingo, esa semana cuenta
  entera.
- `fits` — el plan entra sin recortar nada.
- `effectiveWeeks` — las semanas que quedarían tras el recorte.

Una plantilla con `fits: false` **sí se puede instanciar**: entra recortada. Solo
desaparecen de la lista las que no entran ni recortando (`effectiveWeeks: 0`).
Píntalas con la advertencia, no las escondas: quien tiene 9 semanas para una
media prefiere un plan recortado a una lista vacía.

El orden es: primero las que entran enteras, y dentro de cada grupo la más larga.
La coincidencia de distancia con la maratón tiene un margen del 3%, porque medio
catálogo publica el maratón como 42000 o 42200 en vez de 42195.

### Anclaje y recorte

Con maratón objetivo el plan se ancla **por el final**: la última semana del plan
es la semana de la carrera, y de ahí hacia atrás salen `startDate` y `endDate`.
Anclarlo por el principio dejaría el tapering a mitad de camino y el pico de
carga tres días antes de largar.

Cuando no hay semanas suficientes se recorta **desde el medio**: se conservan la
primera semana y las **dos últimas** (el tapering), y se van las semanas de base
más tempranas. Quien tiene 8 semanas para un plan de 16 no necesita empezar por
el principio: necesita entrar donde el plan ya está en carga.

Las semanas conservadas se **renumeran desde 1**. Si se recortó de la 2 a la 5,
la semana 6 de la plantilla es la semana 2 del plan: el usuario ve "semana 2 de
8", no un salto sin explicación. `plan.totalWeeks` es siempre el número real de
semanas del plan, no el de la plantilla.

Por debajo de **3 semanas** (primera + tapering) no queda plan que instanciar y
la respuesta es `PLAN_DOES_NOT_FIT`, con `weeksAvailable` y `minimumWeeks` en
`details[0]`.

### Ritmos: `paceFactor` en la plantilla, rango en el plan

Las plantillas no guardan ritmos, guardan **multiplicadores** sobre el ritmo de
referencia del corredor (`paceFactor: 1.15` = 15% más lento). Así la misma
plantilla de 10K sirve al que corre a 4:30 y al que corre a 7:00.

Al instanciar se fija `plan.paceBasisSecPerKm` y cada sesión recibe su rango,
`paceFactor ± 4%`:

```json
{ "type": "easy", "targetDistanceMeters": 8000, "paceMinSecPerKm": 296, "paceMaxSecPerKm": 321 }
```

`paceMinSecPerKm` es el extremo **más rápido** (menos segundos por km). Se llama
así porque el cliente lo pinta como "4:56 – 5:21" y ahí el orden es numérico.

Las sesiones de tipo `rest` traen los dos en `null`: un día de descanso no tiene
ritmo objetivo, y pintarle uno confunde.

De dónde sale el ritmo base lo dice `paceBasisSource`, en la respuesta de
`POST /training-plans`:

| Valor | Significa |
|---|---|
| `recent_efforts` | Del mejor esfuerzo de las últimas 12 semanas, proyectado con Riegel |
| `declared_level` | No había historial suficiente (mínimo 3 entrenamientos): se usó el nivel de la plantilla |

Con `declared_level` conviene avisar en pantalla que los ritmos se afinarán solos
cuando haya entrenamientos registrados.

### Un solo plan activo

Solo puede haber un `isActive: true` por usuario. Crear un segundo plan (o
reiniciar uno viejo) con otro en curso responde `PLAN_ALREADY_ACTIVE` y devuelve
en `details[0]` el `activePlanId` y su nombre, para que el diálogo de
confirmación pueda decir **cuál** se va a abandonar.

Confirmado por el usuario, se repite la llamada con `replaceActive: true` y el
plan anterior queda `abandoned` en la misma transacción que crea el nuevo.

El plan pasa a `completed` **solo**, en cuanto no queda ninguna sesión abierta:
nadie entra a la app a pulsar "terminar plan", y un plan que se queda `active`
para siempre bloquea el siguiente.

### Sesiones

`complete` acepta un `workoutId` opcional (el entrenamiento que la cumplió, y
tiene que ser del mismo usuario) y `skipped: true` para marcarla como saltada en
vez de hecha. Una sesión ya cerrada no admite otro cambio: `SESSION_NOT_PENDING`.

`reschedule` mueve la sesión de día **dentro del plan** — fuera del rango
`startDate`–`endDate` es `VALIDATION_ERROR`, con las dos fechas en `details[0]`.
La semana **no cambia**: mover una sesión no la saca de su bloque. Se guarda de
dónde venía en `rescheduledFromDate`, y solo la primera vez: reprogramar dos
veces no borra el origen.

`GET /training-plans/me/current` sin `week` devuelve la semana que corresponde a
hoy, y **acota a 1..N** antes de que empiece el plan o después de que termine: el
selector de semana del cliente no tiene que saber de bordes. Sin plan activo es
`404 NOT_FOUND`, mientras que `/training-plans/me` devuelve `active: null`.

### Reiniciar y borrar

`restart` rehace las sesiones **desde cero**: se pierde el progreso anterior. Se
conserva la duración que el plan ya tenía —si en su día se recortó a 9 semanas,
reiniciarlo no le devuelve las 16 de la plantilla— y también su
`paceBasisSecPerKm`.

`DELETE` borra el plan **de verdad**, sin `deletedAt`. Un plan es una proyección
regenerable desde su plantilla; lo que duele perder son los entrenamientos, y
esos son `Workout`: al borrar el plan solo pierden el vínculo con la sesión.

---

## Entrenamientos: sesiones y consolidación

Un entrenamiento tiene dos filas: el **`Workout`** (lo que el usuario ve en su
historial) y la **`TrackingSession`** (el canal por el que entran las posiciones
mientras corre). Se crean juntas y se cierran juntas.

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/workouts/sessions` | Arranca el entrenamiento. Devuelve el `ingestToken` |
| `PATCH` | `/workouts/sessions/:id/pause` | Pausa |
| `PATCH` | `/workouts/sessions/:id/resume` | Reanuda |
| `POST` | `/workouts/sessions/:id/finish` | Cierra y consolida las métricas |
| `DELETE` | `/workouts/sessions/:id` | Descarta |

Todos exigen token, y solo operan sobre lo del usuario del token: una sesión
ajena responde **404, no 403**.

La **ingesta de posiciones no está aquí**. Vive en
`POST /tracking/sessions/:id/positions`, se autentica con el `ingestToken` en vez
del JWT, y está documentada entera en `docs/tracking.md` — junto con el endpoint
compatible con OsmAnd y el modo simulación.

### El `ingestToken`

`POST /workouts/sessions` devuelve el token **en claro una sola vez**; en la base
solo queda su sha256. Autentica los lotes de posiciones en lugar del JWT del
usuario, porque es un credencial que sale del teléfono cada 20 segundos: si se
filtra, lo único que permite es mandar puntos a **esa** sesión, y muere al
cerrarla.

Guárdalo junto a la sesión en el almacenamiento local, no en memoria.

### Arrancar es idempotente por `clientUuid`

El cliente genera un uuid v4 **antes de tener red** y lo manda en `clientUuid`.
Repetir la llamada con el mismo valor devuelve la sesión existente en vez de
crear un segundo entrenamiento: es exactamente el caso de la conexión que se
corta después de mandar el arranque pero antes de recibir la respuesta.

En ese reintento el **`ingestToken` se rota** y el anterior deja de servir. El
token viejo solo existía como hash y es irrecuperable; sin rotarlo, un cliente
que perdió la respuesta original se quedaría sin poder subir a su propia sesión.

**Una sola sesión abierta por usuario.** Arrancar otra con un uuid distinto
responde `SESSION_ALREADY_ACTIVE` con el `sessionId` de la que está viva en
`details[0]`. Casi siempre es una sesión vieja que quedó colgada porque la app
murió: el cliente la finaliza o la descarta y reintenta.

### Pausa

`pause` y `resume` solo mueven el estado de la sesión. **La ingesta sigue
abierta en pausa**: un lote en vuelo cuando el usuario pulsa "pausa" trae puntos
que ocurrieron de verdad, y rechazarlo los perdería; la puerta se cierra al
finalizar o descartar. **El tiempo parado no se descuenta con esos eventos**: sale de
las posiciones al consolidar. Llevar la cuenta con los eventos obligaría a
confiar en que todos llegan y en orden, y una pausa cuyo `resume` se perdió en un
túnel dejaría el entrenamiento con horas de parada inventadas.

Los estados válidos son `active` → `paused` → `active` → `finished` /
`discarded`. Cualquier otra transición es `SESSION_NOT_ACTIVE`, con el estado
real en `details[0]`.

### Correr una maratón: `registrationId`

Arrancar con `registrationId` es lo que convierte la sesión en **carrera**: la
sesión queda atada a esa maratón, sus puntos entran en el mapa en vivo de los
espectadores y al cerrarla sale el resultado oficial con su puesto.

La inscripción tiene que estar **`confirmed`**. Un borrador a medias o un QR sin
pagar responden `REGISTRATION_NOT_CONFIRMED` (409, con el estado real en
`details[0]`); una inscripción de otra persona responde `404`, sin revelar que
existe. El cupo y el dorsal se toman al confirmar el pago, y esta comprobación
es la otra mitad de esa misma regla: sin ella se podría correr —y clasificar—
sin haber pagado.

El cliente no debería llegar a ver ese error: `GET /races/me` solo devuelve
inscripciones confirmadas, así que el botón de largar solo aparece donde el
servidor va a decir que sí.

### Consolidación: los números los pone el servidor

`POST /workouts/sessions/:id/finish` recalcula **todo** desde las posiciones:

| Métrica | Cómo sale |
|---|---|
| `distanceMeters` | Haversine acumulado entre puntos consecutivos |
| `durationSeconds` | Reloj de pared del primer al último punto válido |
| `movingSeconds` | Suma de los tramos con velocidad ≥ 0,5 m/s |
| `avgPaceSecPerKm` | Sobre `movingSeconds`, como cualquier reloj deportivo |
| `avgSpeedMps` | Distancia / tiempo en movimiento |
| `elevationGainMeters` | Solo subidas, con umbral de 3 m para filtrar el ruido del sensor |
| `calories` | MET × peso × horas. **`null` sin peso en el perfil** |
| `splits` | Un split por km completo |
| `bestKmIndex` | El split de menor `paceSecPerKm` |

Lo que se descarta antes de medir:

- Puntos con `accuracyMeters > 30`.
- Tramos con velocidad > 12,5 m/s (45 km/h): eso no es un corredor, es el GPS
  reenganchando tras un túnel.
- Tramos con más de 120 s de hueco: es la app congelada en segundo plano, y
  unir los dos lados en línea recta inventaría un recorrido que nadie hizo.

`discardedPoints` en la respuesta dice cuántos se fueron. Un número alto es un
síntoma que vale la pena mirar, no un error.

El body acepta `clientReported` con los números que calculó el cliente. **Se
guardan y no se publican**: quedan en el campo `clientReported` del workout para
poder comparar y detectar deriva. Dos teléfonos con el mismo recorrido dan
distancias distintas según el filtrado de su SDK, y el puesto en una carrera no
puede depender del modelo de teléfono. También acepta `feeling` (1..5) y `notes`.

Una sesión **sin posiciones se cierra igual**, con las métricas a cero: el
entrenamiento existió aunque el GPS no funcionara, y borrarlo por eso sería
decidir por el usuario.

### Efectos del cierre

- Las posiciones se cuelgan del workout (`workoutId`). Antes del cierre no lo
  están: podrían haber acabado en una sesión descartada.
- La distancia se suma a la **zapatilla principal**, si hay una. La respuesta
  trae la zapatilla actualizada en `shoe`, con su `wearAlert` — píntalo en la
  pantalla de fin de carrera. Sin zapatilla principal, `shoe: null` y no pasa
  nada.
- Si el workout venía de una sesión de plan (`planSessionId`), esa sesión se
  marca completada. Si eso falla, el entrenamiento **se guarda igual** y el
  usuario puede marcarla a mano: cerrar la sesión del plan es una consecuencia
  agradable, no parte del entrenamiento.

### Descartar

`DELETE /workouts/sessions/:id` marca el workout con `deletedAt` (recuperable
desde el panel) y **borra las posiciones de verdad**. Son datos de ubicación y el
usuario pidió tirarlos: guardar el rastro de un recorrido descartado es
exactamente lo que no hay que hacer con un dato sensible.

---

## Entrenamientos: historial, estadísticas y sincronización

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/workouts/sync` | Sube en bloque lo grabado sin red. Exige `Idempotency-Key` |
| `GET` | `/workouts?type=&from=&to=&limit=&cursor=` | Historial, del más reciente al más viejo |
| `GET` | `/workouts/grouped?by=week\|month&limit=` | Totales por semana o por mes |
| `GET` | `/workouts/stats/weekly?weeks=` | Resumen semanal con la barra de cada día |
| `GET` | `/workouts/:id` | Detalle con splits por kilómetro |
| `DELETE` | `/workouts/:id` | Borrado lógico |

Todos filtran por el usuario del token **dentro del `where`**: un id ajeno
responde **404, no 403**, para no confirmar que existe.

El listado no trae splits — son diez o cuarenta filas por entrenamiento y el
historial no las pinta. Para eso está el detalle.

### `POST /workouts/sync`

```jsonc
{
  "workouts": [
    {
      "clientUuid": "3f1c1b6e-9a1e-4b3a-9f5d-2c7e8a0b1d42",
      "type": "free_run",
      "startedAt": "2026-08-18T11:02:00.000Z",
      "endedAt": "2026-08-18T11:52:31.000Z",
      "clientReported": { "distanceMeters": 10120 },
      "points": [
        { "clientPointId": "3f1c...-0", "recordedAt": "2026-08-18T11:02:00.000Z",
          "lat": -16.4957, "lng": -68.1335, "altitude": 3625, "accuracy": 8 }
      ]
    }
  ]
}
```

Respuesta:

```jsonc
{
  "created": 1, "duplicated": 0, "rejected": 0,
  "results": [
    { "clientUuid": "3f1c...", "status": "created",
      "workoutId": "ckv...", "reason": null, "discardedPoints": 3 }
  ]
}
```

**Un fallo no tumba el lote.** El móvil puede llevar dos semanas de cola y traer
un entrenamiento con un `planSessionId` que ya no existe; rechazar los veinte por
culpa de ese sería condenar al cliente a reintentar para siempre. Cada
entrenamiento se resuelve por separado y la respuesta dice, uno a uno, qué pasó:

- `created` — se guardó. Bórralo de la cola local.
- `duplicated` — ya estaba (mismo `clientUuid`). **No es un error**: bórralo
  igual de la cola y márcalo como sincronizado.
- `rejected` — `reason` dice por qué. No lo reintentes: no va a cambiar.

Topes: **50 entrenamientos** por lote y **20.000 puntos** por entrenamiento.

### Idempotencia del sync

La cabecera `Idempotency-Key` es obligatoria, pero la protección real la da
`clientUuid`, que es **único en la base**: reenviar el mismo lote no duplica
nada, venga con la clave que venga. La cabecera se exige porque es el contrato
del endpoint y porque deja explícito, del lado del cliente, que el reintento es
seguro.

### Con puntos manda el servidor; sin puntos, el usuario

Si el item trae `points`, se recalcula todo desde el recorrido —distancia,
splits, ritmo, elevación, calorías— con las mismas reglas que `finish` (ver
"Consolidación"), y lo que venga en `clientReported` se guarda solo para
comparar. Los puntos se archivan como posiciones colgadas de una `TrackingSession`
ya cerrada, para que el mapa de un entrenamiento sincronizado y el de uno seguido
en vivo se lean igual.

Si no trae `points`, el entrenamiento se guarda como **`source: manual`** con el
`distanceMeters` y el `durationSeconds` que declaró el usuario. Es la única
excepción a "la fuente de verdad es el servidor", y no es una concesión: sin
puntos no hay nada que recalcular.

Un punto con fecha **fuera de la ventana del entrenamiento** (± 5 min) se
descarta y se cuenta en `discardedPoints`. Es el que quedó en la cola de la
carrera de ayer, o el que el GPS emitió con la fecha a cero al arrancar en frío:
uno solo convierte una hora de carrera en una duración de tres días.

### Semanas y meses se cortan en hora local

`grouped` y `stats/weekly` agrupan en la zona del proyecto
(`DEFAULT_TIMEZONE`, `America/La_Paz`), no en UTC. En La Paz (UTC−4) toda carrera
de domingo después de las 20:00 locales cae en lunes UTC: contarla en la semana
siguiente sería mentirle al usuario. La zona usada viaja en la respuesta.

`stats/weekly` devuelve **siempre las siete casillas** de cada semana pedida,
incluidas las vacías y las semanas en las que no se corrió nada: la tira Mon–Sun
necesita los ceros tanto como los kilómetros. `weekday` va de 1 (lunes) a 7
(domingo) y `weekEndsAt` es **exclusivo**.

### Borrar un entrenamiento

`DELETE /workouts/:id` marca `deletedAt`: deja de aparecer en el historial y en
las estadísticas, y se puede recuperar desde el panel. Las **posiciones se
quedan** —al revés que al descartar una sesión en curso—: el entrenamiento ya
existió y puede estar colgado de una carrera. La política de retención de
ubicaciones está en `docs/decisiones.md`.

Los kilómetros ya sumados a la zapatilla **no se restan**: el desgaste del
material ocurrió de verdad aunque el usuario esconda el entrenamiento.

---

## Paginación

Los listados largos usan cursor, no offset:

```
GET /marathons?limit=20&cursor=<opaco>
```

La respuesta trae `meta.nextCursor`; cuando llega `null`, no hay más páginas. Se
usa cursor y no `page`/`offset` porque con offset, insertar una fila mientras el
usuario scrollea le hace ver un elemento repetido o saltarse otro.

---

## Idempotencia

Los endpoints que cobran o que suben datos en bloque llevan la cabecera
`Idempotency-Key`. Reintentar con la misma clave devuelve el mismo resultado sin
volver a ejecutar la operación. Aplica a `POST /registrations/:id/checkout`
—donde es **obligatoria**— y a `POST /workouts/sync`.

La clave la genera **el cliente**, no el servidor: una clave que inventa el
servidor cambia en cada request y no protege de nada. Un uuid v4 sirve. Tiene
entre 8 y 128 caracteres.

**Guárdala junto al borrador, no en memoria.** Su trabajo es sobrevivir
exactamente a lo que no controlas: la conexión que se corta después de mandar el
checkout pero antes de recibir la respuesta, o el usuario que cierra la app y
vuelve a abrirla. Si la clave se pierde en ese hueco, el reintento es un segundo
cobro.

Una clave se **quema con su resultado**, aprobado o rechazado: reintentar un
rechazo con la misma clave devuelve el mismo rechazo aunque cambies de tarjeta.
Para probar con otro medio de pago hay que generar una clave nueva — es el
comportamiento correcto, porque "reintentar" y "pagar de otra forma" son dos
operaciones distintas.

---

## Transversales

Tres cosas que no pertenecen a ninguna pantalla: la configuración que el cliente
lee al arrancar, los enlaces que se comparten por WhatsApp y el botón de borrar
la cuenta.

### `GET /config/app`

Público, sin token. Se pide **una vez al arrancar**, antes de pintar nada.

```json
{
  "currency": "BOB",
  "timezone": "America/La_Paz",
  "defaultLocale": "es-BO",
  "minAppVersion": "1.0.0",
  "deepLinkScheme": "paceup",
  "serviceFee": { "label": "Cargo por servicio" },
  "tracking": { "maxAccuracyMeters": 30, "maxBatchesPerMinute": 20, "suggestedBatchSeconds": 30 },
  "limits": { "avatarMaxBytes": 5242880, "requestsPerMinute": 120, "shoeAlertThresholdMeters": 800000 },
  "features": { "gpsSimulation": true, "liveTracking": true, "socialLogin": false }
}
```

**Nada de esto se hardcodea en la app.** Todo puede cambiar sin publicar una
versión nueva: el cargo por servicio se apaga desde el panel, `minAppVersion`
sube por entorno y los límites de tracking se calibran en el VPS. Un valor
copiado dentro del APK es una mentira el día que alguien lo cambie.

`serviceFee` es `null` cuando el cargo está apagado — **ausencia, no
`{ enabled: false }`**, igual que en las cotizaciones. Y trae solo la etiqueta:
cuánto se cobra depende del subtotal y de la maratón, y esa cuenta la hace
`POST /pricing/quote`, que sigue siendo la única fuente del total. Publicar aquí
el porcentaje invitaría al cliente a calcularlo por su cuenta, que es
exactamente lo que el módulo de precios existe para evitar.

`minAppVersion` es un contrato: por debajo de esa versión la API no garantiza
nada. Si la del teléfono es menor, la app bloquea y manda a actualizar.

### Enlaces profundos

```
GET /api/v1/links/marathon/:slug
GET /api/v1/links/workout/:id
GET /api/v1/links/race/:registrationId
```

Devuelven **HTML, no JSON**: no llevan el sobre `{ data, meta }` y no aparecen en
Swagger. Son las páginas que se abren cuando alguien pega un enlace de PaceUp en
un chat.

Cada página hace dos trabajos:

1. **Metadatos Open Graph** para el bot que rasca el enlace (WhatsApp, Telegram,
   Facebook, iMessage) y arma la previsualización del mensaje.
2. **Salto a la app** con el esquema propio: `paceup://marathon/la-paz-21k`.

El salto va en un `<script>`, **nunca en un `302` del servidor**: un redirect
dejaría al bot sin metadatos que leer, y la previsualización saldría en blanco.
Los bots no ejecutan JavaScript, así que cada uno se lleva lo suyo. Por lo mismo
tampoco se usa `<meta http-equiv="refresh">`.

El esquema no está quemado en la página: sale de `APP_LINK_SCHEME` y el cliente
lo ve en `/config/app`.

**Qué publica cada tipo:**

| Enlace | Título | Descripción | Imagen |
|---|---|---|---|
| `marathon/:slug` | Nombre de la carrera | Distancia, ciudad y fecha local | `coverUrl` |
| `workout/:id` | Genérico | Distancia y duración | Ninguna |
| `race/:registrationId` | Nombre de la carrera | Tiempo de llegada | La tarjeta, si el corredor la generó |

Una maratón publicada es información de difusión y sale entera. Un entrenamiento
y un resultado son de una persona: de esos sale lo mínimo y **nunca el nombre del
corredor, su recorrido ni sus coordenadas**. La previsualización de WhatsApp la
ve el grupo entero, no solo a quien iba dirigida.

Sólo se ven las maratones **publicadas**, la misma condición que el catálogo: un
enlace filtrado no adelanta una carrera bajo embargo.

**Respuestas:** `200` con la página, o `404` con una página de "este enlace ya no
existe" que no salta a ningún lado. `Cache-Control: public, max-age=300` (60 s en
el 404) para absorber la ráfaga de bots cuando el enlace se pega en un grupo.

### `DELETE /users/me/data`

Borra la cuenta. **Irreversible y sin papelera**: no es soft delete. `deletedAt`
está para lo que duele perder por un descuido —un entrenamiento, una
inscripción—, no para una cuenta que su dueño pidió borrar; eso sería conservar
sus datos diciendo que no.

El orden importa:

1. **Cancela las inscripciones a carreras que todavía no ocurrieron**, por el
   mismo camino que `DELETE /registrations/:id`. Borrar la fila sin más dejaría
   el `slotsTaken` de la maratón contando una plaza de alguien que ya no existe.
   Vuelve también el stock de los extras y el cobro queda reembolsado.
2. **Borra el usuario.** El resto lo hace Postgres con `ON DELETE CASCADE`:
   perfil, preferencias, zapatillas, sesiones, dispositivos, entrenamientos,
   splits, posiciones GPS, planes y resultados.
3. **Borra los archivos**: avatar, comprobantes en PDF y tarjetas de resultado.
   El disco no entiende de cascadas.

Responde `{ "ok": true }`. Las sesiones se van con el usuario, así que no hay
refresh posible; el access token que ya estuviera en la calle caduca solo en 15
minutos y mientras tanto no resuelve a nadie. El cliente limpia el storage y va
a Welcome.

### Notificaciones

No hay endpoints todavía. El backend emite eventos a través de
`NotificationsService` y el driver actual (`ConsolePushSender`) los deja en los
logs con los tokens a los que habría entregado. Hoy hay uno:
`shoe.wear_alert`, cuando un entrenamiento hace que la zapatilla principal cruce
su umbral de desgaste — **al cruzarlo, no en cada salida posterior**.

El interruptor es `preferences.notifications.push`: sólo un `false` explícito
calla. Ausente es "sí", porque quien nunca tocó el ajuste espera recibirlas.

Lo que falta para FCM está en `docs/decisiones.md`.
