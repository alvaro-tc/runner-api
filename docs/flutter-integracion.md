# Integración con la app Flutter

Guía para conectar [`running-app`](../../running-app) a esta API. Es el plan de
las fases 19 a 22 y, mientras tanto, la referencia de qué espera el backend del
cliente.

**La UI ya existe y no se rediseña.** El trabajo es reemplazar los repositorios
falsos (`fake_*_repositories.dart`) por los de verdad, pantalla por pantalla. Si
una pantalla necesita un campo que la API no expone, se habla antes de tocar el
widget.

---

## Lo que la app ya tiene

| Pieza | Estado |
|---|---|
| Arquitectura por feature (`data` / `domain` / `presentation`) | Hecha |
| Riverpod + go_router | Hecho |
| `Failure` sellada en `core/error/failure.dart` | Hecha, sin mapear a la API |
| Persistencia local (`hive_ce`) | Instalada, usada para preferencias |
| `geolocator` | Instalado, `LocationService` en `core/services` |
| Cliente HTTP | **No hay.** Todo sale de `fake_data_seed.dart` |

La estructura por capas es exactamente la que hace falta: el datasource habla
HTTP, el repositorio decide local o red, y la presentación no se entera de nada.
Lo que falta es el datasource.

---

## URL base

| Dónde corre la app | URL base |
|---|---|
| Emulador Android | `http://10.0.2.2:3000/api/v1` |
| Simulador iOS | `http://localhost:3000/api/v1` |
| Dispositivo físico | `http://<IP-de-tu-PC>:3000/api/v1` |
| Producción | `https://<API_DOMAIN>/api/v1` |

El emulador de Android no ve `localhost` como tu máquina: `10.0.2.2` es el alias
del host. Va en una constante de compilación (`--dart-define`), nunca escrita en
un archivo de código que alguien pueda publicar apuntando a `localhost`.

---

## Lo primero que hace la app al arrancar

1. **`GET /config/app`** — sin token. Trae moneda, zona horaria, si el cargo por
   servicio está activo, los límites de tracking y `minAppVersion`. Nada de eso
   se hardcodea: todo puede cambiar sin publicar una versión nueva.
2. **Comparar `minAppVersion`** con la versión del paquete. Si la del teléfono es
   menor, bloquear y mandar a actualizar: por debajo de esa versión la API no
   garantiza el contrato.
3. **Intentar `POST /auth/refresh`** con el refresh guardado. Si funciona, a
   Home; si no, a Welcome.
4. **`onboardingSeenAt`** sale de `GET /users/me/preferences`, no solo de local:
   así el onboarding no reaparece en un teléfono nuevo.

---

## Capa de red

### Cliente

`dio` con un `BaseOptions` común: `baseUrl`, timeouts de conexión y respuesta, y
`Accept: application/json`. Un solo `Dio` para toda la app, inyectado por
Riverpod.

### Interceptores, en este orden

1. **Auth** — adjunta `Authorization: Bearer <access>` salvo en los endpoints
   públicos (`/auth/login`, `/auth/register`, `/marathons/*`, `/config/app`).
2. **Refresh** — ante un `401`, renueva y reintenta la petición original. Ver
   abajo: es el interceptor con trampa.
3. **Reintento** — solo para errores de red y `5xx`, con backoff exponencial y
   **nunca** sobre métodos que no son idempotentes salvo que lleven
   `Idempotency-Key`.
4. **Errores** — traduce la respuesta a un `Failure` por `error.code`.
5. **Log** — solo en debug, y sin volcar cabeceras de autorización.

### El refresh necesita un mutex

Es el detalle que rompe la sesión si se pasa por alto.

**El refresh token rota en cada uso.** Si la app dispara diez peticiones en
paralelo al abrirse y las diez reciben `401`, diez refresh concurrentes usan el
mismo token: uno gana y los otros nueve llegan con un token ya rotado. El
servidor eso lo lee —correctamente— como robo de token, responde
`TOKEN_REUSE_DETECTED` y **revoca la cadena entera de ese dispositivo**. El
usuario aparece en Welcome sin haber hecho nada.

La forma correcta:

- Un `Completer` compartido: la primera petición que recibe `401` arranca el
  refresh; las demás **esperan a ese mismo** `Future`.
- Cuando resuelve, todas reintentan con el token nuevo.
- Si el refresh falla, se limpia el storage seguro y se navega a Welcome, una
  sola vez.
- Un `401` **del propio** `/auth/refresh` nunca dispara otro refresh.

### Errores: mapear por `code`, jamás por texto

`error.message` es texto humano: puede cambiar de redacción o traducirse sin
aviso. El catálogo completo está en [`api.md`](api.md).

| `error.code` | Qué hace la app |
|---|---|
| `INVALID_CREDENTIALS` | Error en el formulario, sin cerrar sesión |
| `TOKEN_REUSE_DETECTED` | Limpiar storage y ir a Welcome |
| `INVALID_REFRESH_TOKEN` | Igual: la sesión no se puede recuperar |
| `MARATHON_FULL` | Volver al catálogo y refrescar cupos |
| `REGISTRATION_CLOSED` | Deshabilitar el botón de inscripción |
| `PAYMENT_DECLINED` | Mostrar `details[0].reason`, permitir otro método |
| `IDEMPOTENCY_KEY_CONFLICT` | Bug del cliente: generar clave nueva |
| `SESSION_ALREADY_ACTIVE` | Ofrecer retomar la sesión de `details[0].sessionId` |
| `PLAN_ALREADY_ACTIVE` | Pedir confirmación y reenviar con `replaceActive` |
| `RATE_LIMITED` | Backoff, sin reintentar en bucle |

Todo lo que no esté en la tabla cae en `UnexpectedFailure` con el
`meta.requestId` a mano: si el usuario reporta el fallo con ese id, la traza
completa está en los logs del servidor.

---

## Modelos

`freezed` + `json_serializable`. Nada de `Map<String, dynamic>` suelto cruzando
capas.

**Las unidades de la API son crudas y el formateo es del cliente.** Distancias en
metros, duraciones y ritmos en segundos, dinero en centavos, fechas ISO-8601 en
UTC. La app ya tiene `core/formatters`: ahí viven `Bs 1.234,56`, `5:30/km` y
`km`/`mi` según las preferencias del usuario. Un modelo que guarde un `double` de
kilómetros ya perdió la partida.

**Las cuentas regresivas se calculan contra `meta.timestamp`**, la hora del
servidor, no contra el reloj del teléfono —que el usuario puede tener mal.

---

## Almacenamiento

| Qué | Dónde | Por qué |
|---|---|---|
| Access y refresh token | `flutter_secure_storage` | Keychain / Keystore. **Nunca** `SharedPreferences`: ahí un backup de Android se lleva la sesión |
| `deviceId` | `flutter_secure_storage` | Identifica la sesión; se genera una vez y no cambia |
| Perfil, catálogo, entrenamientos, inscripciones | Base local | Es lo que hace que la app abra con datos sin red |
| Preferencias de UI | `shared_preferences` | Ya está así y no duele |

### `drift` o `hive_ce`: decisión abierta

El PROMT pide `drift`; el proyecto ya usa `hive_ce`. La diferencia que importa no
es el rendimiento sino la **outbox**: drenar una cola con reintentos, contar
intentos y consultar "lo pendiente ordenado por fecha" es SQL, y en un almacén
clave-valor se acaba escribiendo a mano un índice que la base ya sabría llevar.
Se decide con datos al llegar a la Fase 20, y queda anotado en
[`decisiones.md`](decisiones.md).

---

## Offline-first

La regla, en una línea: **leer de local, refrescar desde red, escribir en la
outbox.**

- **Leer** devuelve lo local de inmediato y dispara el refresco en segundo plano.
  La pantalla nunca se queda en blanco esperando la red.
- **Escribir** guarda en local y encola la operación. La UI ya puede seguir.
- **La outbox** se drena cuando hay conectividad, con backoff exponencial y un
  contador de intentos. Cada entrada lleva su `Idempotency-Key` **persistida
  junto al registro**, no en memoria: su trabajo es sobrevivir exactamente a lo
  que no controlas —la conexión que se corta después de mandar el checkout pero
  antes de recibir la respuesta, o el usuario que cierra la app. Si la clave se
  pierde en ese hueco, el reintento es un segundo cobro.

`POST /workouts/sync` sube entrenamientos en bloque y también acepta
`Idempotency-Key`: reenviar el mismo lote no duplica nada.

---

## Tracking GPS

El detalle completo está en [`tracking.md`](tracking.md). Lo que el cliente tiene
que respetar:

1. **Doble escritura.** Cada punto se guarda en la base local **antes** de
   intentar enviarlo. Sin eso, un entrenamiento se pierde entero por quedarse sin
   señal.
2. **Lotes, no punto por punto.** Se agrupan 15–30 s de puntos y se manda una
   sola petición a
   `POST /tracking/sessions/:id/positions`. Una petición por segundo destroza la
   batería y no aporta nada. `GET /config/app` trae el intervalo sugerido y el
   máximo de lotes por minuto que la API acepta.
3. **El `ingestToken`** lo devuelve `POST /workouts/sessions` y es lo que
   autentica la ingesta — no el JWT del usuario. Token de vida corta y alcance
   mínimo: solo sirve para meter puntos en **esa** sesión.
4. **Deduplicación por `clientPointId`.** Reenviar un lote es seguro; los
   repetidos se ignoran. Así el drenado de la cola no necesita saber qué llegó.
5. **Filtro de precisión.** Se descartan los puntos con más de 30 m de error
   antes de encolarlos. El servidor los vuelve a filtrar al consolidar, pero
   mandarlos gasta batería y datos para nada.
6. **Los números los pone el servidor.** El cliente muestra su propio cálculo
   mientras corre —tiene que hacerlo, va sin red— pero al cerrar la sesión
   **adopta las métricas de la respuesta**. Lo que el cliente calculó viaja en
   `clientReported` para poder comparar.

### Permisos

`whileInUse` **no alcanza** para seguir grabando con la pantalla apagada: hace
falta `always` en Android y iOS. El flujo educativo previo no es un adorno, es lo
que decide si el permiso se concede: explicar para qué → pedirlo → si lo niegan,
ofrecer abrir Ajustes → detectar el GPS apagado.

Antes de instalar un paquete de geolocalización en segundo plano hay que
**verificar en pub.dev** las opciones y sus licencias y reportarlas —
`flutter_background_geolocation`, por ejemplo, es comercial para release en
Android. No se asume nada.

---

## Enlaces profundos

La API sirve páginas en `/links/marathon/:slug`, `/links/workout/:id` y
`/links/race/:registrationId` que dan la previsualización de WhatsApp y saltan al
esquema propio de la app. El esquema sale de `GET /config/app`
(`deepLinkScheme`, `paceup` por defecto), así que la app tiene que registrar:

```
paceup://marathon/<slug>
paceup://workout/<id>
paceup://race/<registrationId>
```

y `go_router` enrutarlos a las mismas pantallas que la navegación normal.

---

## Orden de trabajo

| Fase | Qué |
|---|---|
| 19 | Dio, interceptores, `Failure` mapeada por `code`, modelos con freezed, secure storage |
| 20 | Base local y outbox; repositorios offline-first |
| 21 | `TrackingService`: permisos, segundo plano, doble escritura, envío por lotes |
| 22 | Reemplazar los repositorios falsos pantalla por pantalla |

Las tres primeras no tocan un solo widget. La cuarta los toca todos, y por eso va
al final: cuando llega, la capa de datos ya está probada.

---

## Sesión: un solo campo, y una puerta

`POST /auth/login` recibe **`identifier`**, no `email`: puede ser un correo o una
CI, y quien decide es el servidor por el `@`. Dos campos obligarían al usuario a
recordar con cuál se dio de alta, que es lo que no recuerda.

`GET /auth/me` trae `mustChangePassword`. Cuando es `true`, la contraseña la puso
otro —alta desde la web: usuario CI, contraseña CI— y **el guard del router tiene
que atrapar al usuario** en la pantalla de cambio hasta que llame a
`POST /auth/change-password`. No es un aviso que se pueda descartar: esa
contraseña la sabe cualquiera que le haya visto el carnet.

Ojo con el arranque: el flag no vive en el dispositivo, así que una sesión
restaurada tiene que releer `/auth/me` antes de dar por buena la navegación.

## Cobro por QR verificado a mano (temporal)

Cuarto método de pago, `qr_manual`. La app pinta el QR del organizador
(`payment.methodDetails.manualQr`), el corredor sube una captura con
`POST /payments/:id/proof` y **el cobro sigue `pending`** hasta que un
organizador la aprueba.

Dos cosas que la app tiene que hacer distinto aquí:

- **No sondear.** Al otro lado no hay un banco que responda en segundos, hay una
  persona que va a mirar una imagen cuando pueda. El sondeo de dos segundos que
  sirve para el QR simulado aquí sólo gasta batería.
- **No ofrecer el método si la maratón no trae `paymentQrUrl`.** Sin QR cargado
  el checkout responde `QR_NOT_CONFIGURED`, y enseñarlo sería prometer un pago
  que va a fallar en el último paso.

Todo el flujo, en [`pago-qr-manual.md`](./pago-qr-manual.md).

---

## Credenciales de prueba

`runner@test.com` · `runner2@test.com` · `admin@test.com`, contraseña
`Test1234!`. Sus CI son `6789012LP`, `5544332CB` y `1000001LP`: sirven para
entrar por el mismo campo que el correo.

`runner@test.com` es el único con actividad sembrada: cuatro meses de
entrenamientos con GPS, un plan de 21K a mitad de camino, cuatro inscripciones
—una pagada, una esperando el QR, una corrida con resultado y una reembolsada— y
tres pares de zapatillas. `runner2@test.com` está vacío a propósito: es la cuenta
con la que se comprueba que los datos de uno no se ven desde la sesión de otro.
