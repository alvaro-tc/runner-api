# Decisiones técnicas

Registro de decisiones con su justificación. Una entrada por decisión, la más
reciente arriba dentro de cada sección. Las decisiones difíciles de revertir
(esquema de BD, contrato de API, protocolo de tracking) se consultan antes de
tomarse; las fáciles se toman y se anotan aquí.

---

## Fase 0 — Preguntas resueltas

| Tema | Decisión | Razón |
|---|---|---|
| Ubicación del backend | `running-api/`, hermana de `running-app/` | Repos separados, sin monorepo. El backend no vive dentro del proyecto Flutter. |
| Dominio de la API | Placeholder `api.paceup.example` vía `API_DOMAIN` | Todavía no hay dominio. Al comprarlo se cambia la variable, sin tocar código. |
| Datos fiscales del comprobante | Placeholders en env (`INVOICE_LEGAL_NAME`, `INVOICE_NIT`, `INVOICE_ADDRESS`) | Se editarán desde el panel admin cuando existan los reales. |
| Service fee por defecto | `enabled = false`, con 10% / mínimo Bs 5 precargado pero apagado | El fee arranca invisible. `QuoteService` y el panel soportan encenderlo sin migración. |
| Catálogo de planes | Las 8 plantillas propuestas (5K/10K/21K/42K × principiante/intermedio) | No hay plantillas propias que cargar. |
| Envío de correo | Interfaz `MailService` + driver `console` | Sin proveedor contratado. Enchufar SMTP o Resend después es cambiar un driver. |

**Consecuencia del service fee apagado:** con `enabled = false`, `/quote` devuelve
`serviceFee: null` y la UI **no debe pintar la línea del fee**. Es el camino por
defecto en desarrollo, así que los tests de `QuoteService` cubren los dos estados.

---

## Fase 1 — Andamiaje

### Sin Docker

**Decisión:** el proyecto no usa Docker en ningún entorno. Postgres y Redis se
instalan nativamente (paquete del sistema o servicio gestionado) y la API correrá
en producción como servicio systemd detrás de Caddy.

**Razón:** petición explícita. No cambia nada del código: la app solo conoce
`DATABASE_URL` y `REDIS_URL`.

**Qué falta:** los compose de desarrollo y producción, más el `Caddyfile`, se
crean en la Fase 18 (Despliegue).

### Validación de entorno con zod, no con `class-validator`

**Decisión:** `src/config/env.schema.ts` define un único esquema zod que se
ejecuta al arrancar mediante la opción `validate` de `@nestjs/config`.

**Razón:** el entorno es un objeto plano que se valida una vez, no un DTO por
petición. zod da inferencia de tipos directa (`type Env = z.infer<...>`) y
mensajes que nombran la variable exacta que falta. Los DTO de HTTP siguen usando
`class-validator`, según el stack acordado.

**Consecuencia:** si falta una variable o tiene un valor imposible, el proceso
**muere al arrancar** con la lista de problemas. Nunca se levanta a medias.

### `process.env` vs archivo `.env`

Verificado en la Fase 1: `@nestjs/config` carga el `.env` **sin pisar** las
variables ya presentes en `process.env`. Es la precedencia correcta para el VPS
(las variables del contenedor mandan) y no hace falta código extra.

Ojo al escribir tests: `ConfigModule.forRoot()` resuelve el entorno **en tiempo
de importación del módulo**, así que ajustar `process.env` dentro de un
`beforeAll` llega tarde. Por eso existe `test/setup-env.ts`, referenciado desde
`setupFiles` en la config de Jest e2e.

### `/health` y `/ready` fuera del prefijo `/api/v1`

**Decisión:** los dos healthchecks se sirven en la raíz, excluidos del prefijo
versionado.

**Razón:** los consume la infraestructura (systemd, Caddy, el monitor del VPS),
no el cliente. No deben romperse cuando llegue `/api/v2`.

**Diferencia entre ambos:** `/health` es *liveness* y no toca dependencias a
propósito — si tocara Postgres, una caída de la base haría que systemd reiniciara
la API en bucle sin arreglar nada. `/ready` es *readiness* y sí verifica
Postgres y Redis; devuelve `503` con el detalle de qué está caído.

### Chequeo de dependencias sin `@nestjs/terminus`

**Decisión:** `HealthService` consulta Postgres con `pg` (`SELECT 1`) y Redis con
`ping()`, sin la dependencia de terminus.

**Razón:** terminus aporta sobre todo el formato de respuesta, y aquí la
respuesta ya la da el sobre `{ data, meta }` propio. Son ~40 líneas contra una
dependencia más.

**Saldado en la Fase 2:** el chequeo de Postgres ya reusa el pool de
`PrismaService` en vez de abrir una conexión propia por petición, y la
dependencia `pg` directa se eliminó.

### Sobre de respuesta y códigos de error

- `ResponseEnvelopeInterceptor` envuelve todo éxito en `{ data, meta }`.
- `AllExceptionsFilter` convierte cualquier excepción en
  `{ error: { code, message, details }, meta }`.
- `ErrorCode` (`src/common/errors/error-codes.ts`) es el **catálogo único**. Todo
  código nuevo se agrega ahí y se documenta en `docs/api.md`.
- `AppException` es la excepción de dominio: siempre lleva un `code` del catálogo.

**`meta.timestamp` es la hora del servidor.** El cliente calcula las cuentas
regresivas contra ese valor en vez de confiar en el reloj del teléfono.

**`meta.requestId`** viaja también en la cabecera `x-request-id` y en cada línea
de log, para poder cruzar un error reportado por el usuario con su traza.

### Redacción de secretos en los logs

`pino` redacta `authorization`, `cookie`, `x-ingest-token`, y los campos de body
`password`, `newPassword`, `currentPassword`, `refreshToken`, `token`, `card`,
`cardNumber`. Al agregar un endpoint con un campo sensible nuevo, **se agrega a
esa lista** en `src/config/logger.config.ts`.

Los healthchecks están excluidos del log automático: pegan cada pocos segundos y
solo ensucian.

### `forceExit` en los tests e2e

**Decisión:** `test/jest-e2e.json` lleva `"forceExit": true`.

**Razón:** tras cerrar la app, Jest tarda en salir. `--detectOpenHandles` no
reporta ningún handle abierto, así que es un artefacto del runner (sockets
efímeros de supertest / reintentos de conexión), no una fuga del código de
producción.

**ponytail:** si en alguna fase futura aparece una fuga real de conexiones,
quitar este flag es lo primero que la delata. No se usa para tapar un cierre mal
hecho: `HealthService` implementa `OnModuleDestroy` y la app llama a
`enableShutdownHooks()`.


## Fase 2 — Esquema de datos

### Particionado mensual de `positions`

**Decisión:** `positions` es una tabla particionada por rango sobre `recordedAt`,
con una partición por mes más una de respaldo. La conversión vive en SQL crudo
dentro de la migración inicial, y `prisma/sql/positions-partitioning.sql` guarda
una copia legible de ese bloque.

**Razón:** es la única tabla que crece sin techo. Un corredor genera ~1 punto por
segundo, así que una maratón de 4 horas son ~14.400 filas **por persona**. Con
particiones, archivar o borrar un mes entero es un `DROP TABLE` instantáneo en
vez de un `DELETE` que bloquea la tabla durante minutos.

**Por qué en SQL crudo:** Prisma no sabe expresar particionado de forma
declarativa. La migración se generó con `--create-only` y se editó a mano.
**Consecuencia operativa:** si en el futuro `migrate dev` regenera esta tabla,
hay que volver a inyectar el bloque. Está aislado y comentado justo por eso.

**Lo que el particionado obliga a cambiar en el modelo:** Postgres exige que
toda clave primaria y todo índice único de una tabla particionada **contenga la
clave de partición**. Por eso:

- La PK de `Position` es compuesta: `(id, recordedAt)`, no `id` solo.
- El dedupe es `@@unique([clientPointId, recordedAt])` y no `clientPointId` solo.

Esto **no** debilita el dedupe: un punto concreto siempre llega con el mismo
`recordedAt`, así que reenviar un lote sigue cayendo en `ON CONFLICT DO NOTHING`.
Verificado con un test que reenvía el mismo punto y comprueba que no se duplica.

**Rango inicial:** 6 meses hacia atrás (para los seeds históricos de la Fase 17) y
18 hacia adelante. La función `create_positions_partition(date)` es idempotente y
está expuesta como `PrismaService.ensurePositionsPartition()`, para que el job
mensual de la Fase 11 no tenga que conocer el SQL.

**Partición de respaldo (`positions_default`):** sin ella, un punto con fecha
fuera de todo rango haría fallar el `INSERT` y se perdería un dato de GPS que el
usuario no puede volver a generar. Prefiero un punto en la partición equivocada a
un punto perdido. **Cuidado al operar:** si `positions_default` llega a contener
filas de un mes, crear después la partición de ese mes falla, porque Postgres
tiene que validar que los rangos no se solapan. Se arregla moviendo esas filas
antes de crear la partición.

### `citext` para el email

**Decisión:** `User.email` es `CITEXT`, con `CREATE EXTENSION IF NOT EXISTS citext`
al inicio de la migración.

**Razón:** hace la comparación insensible a mayúsculas **en la base de datos**, no
a base de recordar un `lower()` en cada consulta. `Ana@Mail.com` y `ana@mail.com`
son el mismo usuario, y el índice único lo impone. `citext` es una extensión
*trusted*, así que el dueño de la base puede crearla sin ser superusuario.

### Prisma 7 exige un driver adapter

**Hallazgo:** en Prisma 7 el cliente ya **no** acepta una URL suelta
(`datasourceUrl`). Hay que pasarle un driver adapter. `PrismaService` usa
`PrismaPg` de `@prisma/adapter-pg`, que gestiona el pool de `pg` por debajo.

**Consecuencia en la configuración:** la URL de la base ya no vive en
`schema.prisma`, sino en `prisma.config.ts` (para el CLI) y en `AppConfigService`
(para la app). Sigue siendo la misma variable `DATABASE_URL`.

### El cliente generado vive fuera de `src/`

`generated/prisma/` está en `.gitignore`: es artefacto de build, se regenera con
`npm run db:generate`. Como queda fuera de `src/`, la salida del build ganó un
nivel y el binario final es `dist/src/main.js`. El script `start` lo refleja.

### Base de datos espejo (shadow database)

`prisma migrate dev` necesita una base efímera para detectar drift. Sin
declararla, Prisma intenta crearla en la misma instancia y eso exige permisos de
superusuario. Se declara explícitamente en `SHADOW_DATABASE_URL`, apuntando a
`paceup_shadow`. En producción no hace falta: allí se usa `migrate deploy`, que
no crea migraciones.

### Tres bases en desarrollo

| Base | Para qué |
|---|---|
| `paceup` | Desarrollo. La que usa `npm run dev`. |
| `paceup_shadow` | Solo `prisma migrate dev`. Se puede borrar y recrear sin perder nada. |
| `paceup_test` | Tests e2e. `test/setup-env.ts` la fija antes de que se cargue el `.env`. |

Las migraciones se aplican a `paceup_test` a mano; queda documentado en el README
porque un script que dijera `db:test:setup` y en realidad leyera `DATABASE_URL`
sería una mentira cómoda.

### Unidades y tipos: nada de coma flotante para dinero

Se cumple en todo el esquema, sin excepción:

| Magnitud | Tipo | Ejemplo |
|---|---|---|
| Distancia | `Int` metros | `42195` |
| Duración | `Int` segundos | `12600` |
| Ritmo | `Int` seg/km | `330` (5:30/km) |
| Dinero | `Int` centavos + `currency` | `15000` = Bs 150,00 |
| Porcentaje de fee | `Int` puntos básicos | `1000` = 10% |

Coordenadas y velocidades sí son `Float` (`double precision`): ahí la precisión
decimal es la representación correcta, no una fuente de error acumulado.

### Sin PostGIS por ahora

`lat`/`lng` como `double precision` con índices sobre `(userId, recordedAt)` y
`(trackingSessionId, recordedAt)`. Las consultas reales son "dame los puntos de
esta sesión ordenados por tiempo", que es un recorrido temporal, no espacial.
PostGIS entra si algún día hace falta "corredores dentro de este polígono" o
snapping a rutas; sería una migración aditiva, no una reescritura.

### `serviceFeeSnapshot` en la inscripción

`Registration` guarda `serviceFeeCents` **y** `serviceFeeSnapshot` (jsonb con la
configuración exacta aplicada). Cambiar el fee después no altera comprobantes
históricos: el comprobante se reconstruye desde el snapshot, nunca releyendo la
config actual.

### Seed mínimo

`prisma/seed.ts` siembra por ahora **una sola fila**: la `ServiceFeeConfig`
global, creada con `enabled = false` según lo decidido, y con el 10% / mínimo
Bs 5 precargados para que encenderlo desde el panel sea un click. Es idempotente.
El catálogo de prueba completo (maratones, plantillas, entrenamientos
históricos) llega en la Fase 17.


---

## Fase 3 — Autenticación

### La sesión de 60 días: cómo se consigue sin dejar un token eterno

El requisito era que el usuario no vuelva a loguearse en al menos 60 días de uso
normal. La tentación obvia — un token de larga duración — es exactamente lo que
no hay que hacer: un token que vive dos meses en un teléfono es un token que,
robado, vale dos meses.

La solución tiene dos piezas con vidas opuestas:

| | Access token | Refresh token |
|---|---|---|
| Formato | JWT HS256 | Cadena opaca de 256 bits |
| Vive | 15 minutos | 60 días, **recalculados en cada uso** |
| Se guarda en el servidor | No | Solo su hash SHA-256 |
| Se puede revocar | No (caduca solo) | Sí, de verdad |

**La rotación deslizante es lo que hace que funcione.** Cada `POST /auth/refresh`
invalida el token usado y emite uno nuevo con `expiresAt` recalculado a 60 días
*desde ahora*. Mientras el usuario abra la app cada tanto, la ventana se
desplaza y la sesión no muere nunca. Si deja de abrirla dos meses, caduca sola.

**El refresh es opaco y no un JWT** a propósito: no transporta información, se
revoca de verdad (un JWT solo se puede esperar a que caduque), y como el
servidor guarda únicamente el hash, robar la base de datos no entrega tokens
usables.

### Detección de reuso: por qué revocar de más

Si llega un refresh token cuya sesión ya está revocada, alguien conserva una
copia vieja. Lo normal es que sea un robo: el usuario legítimo ya rotó, así que
el que presenta el token antiguo es el otro.

Rechazar esa petición no alcanza. Si el atacante tiene el token viejo, es porque
interceptó la cadena en algún punto, y probablemente tiene también el vigente.
Por eso se revoca **toda la cadena de sesiones de ese dispositivo** y se responde
`TOKEN_REUSE_DETECTED`.

El coste es que el usuario legítimo tiene que volver a loguearse en ese
dispositivo. Es el precio correcto: molestar a una persona una vez frente a
dejar una sesión tomada.

**Para el cliente Flutter:** `TOKEN_REUSE_DETECTED` no se reintenta nunca. Limpia
el storage y va a Welcome. `INVALID_REFRESH_TOKEN` se trata igual.

### Dos algoritmos de hash distintos, a propósito

| Qué | Algoritmo | Por qué |
|---|---|---|
| Contraseñas | **argon2id**, 64 MiB, 3 pasadas | La elige un humano, es atacable por diccionario. El coste (~100 ms) es lo que encarece el ataque. Parámetros de OWASP. |
| Refresh y reset tokens | **SHA-256** | Ya son 256 bits aleatorios: no hay diccionario que atacar. argon2 no compraría nada y costaría 100 ms en **cada** refresh. |

Usar argon2 para todo suena más seguro y es simplemente más lento sin ganar nada.

### Fugas de información que se cerraron

Tres endpoints podían usarse para averiguar quién tiene cuenta. Los tres
responden ahora de forma indistinguible:

1. **`/login`** — mismo código y mismo mensaje para "no existe" y "clave mala".
   Además verifica **siempre** un hash, exista el usuario o no (hay un hash
   ficticio para eso). Sin ese detalle, un email inexistente respondería en 1 ms
   y uno real en 100 ms, y esa diferencia de tiempo delata la cuenta aunque el
   mensaje sea idéntico. Hay un test que compara ambas respuestas.
2. **`/forgot-password`** — responde `{ ok: true }` siempre. Si dijera "ese email
   no está registrado", sería un comprobador gratuito de cuentas.
3. **`DELETE /auth/sessions/:id`** de otro usuario — responde `404`, no `403`.
   Un `403` confirmaría que ese id existe.

### El guard de JWT es global, y eso es la decisión

`JwtAuthGuard` se registra con `APP_GUARD`: **todo endpoint exige token salvo
que se marque `@Public()`**.

Al revés — proteger ruta por ruta — cada endpoint nuevo nace desprotegido por
olvido, y el olvido no da error: da acceso. Con el guard global, olvidarse
produce un `401` que se ve en el primer test. El fallo se vuelve ruidoso en vez
de silencioso.

Los healthchecks llevan `@Public()` y `@SkipThrottle()`: los consume la
infraestructura, sin token y varias veces por minuto.

### Sin passport

`ponytail:` extraer un `Authorization: Bearer` y verificar un JWT son ~20 líneas
contra tres dependencias (`passport`, `passport-jwt`, `@nestjs/passport`).
Passport gana cuando hay varias estrategias — OAuth real, por ejemplo — y ese es
justamente el momento de incorporarlo, no antes. El punto de cambio está
aislado en `guards/jwt-auth.guard.ts`.

### Rate limiting: adelantado desde la Fase 16

El plan lo situaba en la Fase 16, pero `/login` sin límite es un oráculo de
fuerza bruta: argon2 encarece cada intento y no impide diez mil. Se adelantó
solo la parte de credenciales; el resto del rate limiting sigue en su fase.

`AUTH_RATE_LIMIT_PER_MINUTE` (10 por defecto) es una **perilla de calibración**,
no un número sagrado: detrás de un NAT compartido — una oficina, una red móvil —
diez intentos por minuto para *toda* la red puede quedarse corto. Si aparecen
`429` legítimos, ese es el valor a subir.

Verificado en vivo: el intento 11 devuelve `429`.

Detalle de implementación: el valor se lee de `process.env` y no de
`AppConfigService`, porque `@Throttle` es un decorador y se evalúa al cargar la
clase, cuando el contenedor de inyección todavía no existe. `env.schema.ts`
sigue siendo quien lo valida.

### `JWT_SECRET` no tiene valor por defecto

Un secreto por defecto es un secreto público: acaba en producción porque nadie
lo cambió. Se exige explícito y de 32 caracteres mínimo, y sin él el proceso no
arranca. Hay un test que lo comprueba.

### Cambiar la contraseña cierra todas las sesiones

`reset-password` revoca **todas** las sesiones del usuario, en todos sus
dispositivos. Es lo que se espera de "recuperé mi cuenta": si alguien había
entrado, queda fuera. Obliga a volver a loguearse en los propios dispositivos, y
también aquí ese es el precio correcto.

### Login social: no implementado, y documentado

Ver `src/modules/auth/social/README.md`. El resumen: el flujo real es sobre todo
papeleo (registrar la app en cada proveedor, revisión de Facebook y LinkedIn
para pedir el email), y sin esas credenciales el código no se puede ni ejecutar
ni probar.

La parte difícil ya está resuelta: el resultado de un login social es el mismo
par de tokens, así que `TokenService.issueForNewSession()` es el único punto de
entrada que hay que llamar una vez resuelto qué usuario es.

**La decisión con filo**, anotada allí para cuando toque: si alguien se registró
con email y contraseña y después entra con Google usando ese mismo email,
vincular automáticamente es cómodo y es el agujero por el que se toma una cuenta
ajena si el proveedor no verificó el email.


---

## Fase 4 — Usuarios y perfil

### Todo cuelga de `/users/me`, no de `/users/:id`

**Decisión:** no existe ningún endpoint de usuario direccionado por id. El
sujeto es siempre el del token.

**Razón:** elimina de raíz la clase de bug más común de esta capa — el
`/users/:id` que se olvida de comparar el id con el del token y deja leer o
escribir la cuenta de otro. Cuando la Fase 15 necesite que un admin vea a
terceros, será `/admin/users/:id`, protegido por rol y con esa intención
explícita en la ruta.

### En la base se guarda la clave del archivo, no la URL

**Decisión:** `StorageService` (clase abstracta con driver local en
`src/modules/storage/`) es la única puerta de escritura de binarios. Persiste
`avatars/<userId>/<uuid>.webp`; la URL absoluta se arma al leer con
`PUBLIC_BASE_URL`.

**Razón:** guardar `http://localhost:3000/uploads/...` en una columna es una
bomba de relojería que estalla el día del despliegue. Con la clave, cambiar de
dominio, de puerto o de driver (local → S3) no invalida ni una fila.

**Consecuencia:** el día que haga falta un CDN o una segunda réplica de la API,
se escribe `S3StorageService` con sus tres métodos y no se toca nada más.

### El tipo de imagen se decide decodificando, no leyendo el `Content-Type`

**Decisión:** el avatar se valida abriéndolo con `sharp`. Si no se puede
decodificar, o el formato no está en la lista, es `INVALID_IMAGE` (415). SVG
queda fuera de la lista.

**Razón:** el `Content-Type` y la extensión los escribe el cliente; los dos se
falsifican en dos segundos. Lo único que no se falsifica es que el archivo se
decodifique. SVG se excluye aparte porque es XML ejecutable: servirlo desde
nuestro dominio sería un XSS almacenado.

### El avatar se reencoda siempre a WebP

**Decisión:** nada se guarda tal como llegó. Se rota según el EXIF, se recorta a
cuadrado de `AVATAR_SIZE_PX` (512) y se reencoda a WebP con calidad 82.

**Razón:** además de acotar el tamaño, el reencode **tira los metadatos EXIF**,
que en una foto de teléfono llevan las coordenadas GPS de dónde se tomó. Un
avatar no debería publicar la casa de nadie. El nombre lleva un UUID nuevo en
cada subida, así que la URL es inmutable y se cachea 30 días sin riesgo.

### `null` borra, ausente no toca

**Decisión:** los PATCH parciales distinguen las dos cosas mediante el helper
`camposPresentes()` (`src/common/utils/patch.ts`), que filtra por presencia real
de la propiedad y no por `!== undefined`.

**Razón:** sin la distinción no hay forma de vaciar un campo opcional una vez
lleno. Es fácil de revertir y está documentado en `docs/api.md` porque tiene una
trampa del lado Flutter: un modelo que serialice todos los campos siempre, con
los vacíos en `null`, borra en cada guardado lo que el usuario no tocó.

### `notifications` y `privacy` se mezclan; `injuryFlags` se reemplaza

**Decisión:** las dos bolsas de banderas de preferencias hacen merge superficial
con lo guardado. La lista de lesiones se reemplaza entera.

**Razón:** las banderas crecen con cada versión de la app, y un cliente viejo que
mande `{ push: false }` no debería borrar los toggles que no conoce. Las lesiones
son una lista que el usuario edita como un todo en su pantalla: ahí el merge
haría imposible eliminar una entrada.

### Cambiar el email desverifica la cuenta

**Decisión:** `PATCH /users/me` con un email distinto pone `emailVerifiedAt` en
`null`.

**Razón:** la verificación es del buzón, no del usuario. Si el sello sobreviviera
al cambio, cualquiera con una sesión abierta podría mudar la cuenta a un buzón
ajeno conservando el "verificado".

### La semana de los highlights es lunes–domingo en la zona de la app

**Decisión:** `rangoSemanal()` (`src/common/time/week.ts`) calcula las fronteras
en `DEFAULT_TIMEZONE` y las devuelve como instantes UTC. `weekEndsAt` es
exclusivo.

**Razón:** en La Paz (UTC-4) todo lo que se corre un domingo después de las 20:00
locales ya es lunes en UTC, y con fronteras en UTC se sumaría a la semana
siguiente. El usuario vería su carrera larga del domingo desaparecer de la tira
Mon–Sun. El helper recalcula el desfase en la propia frontera, así que también
es correcto en zonas con horario de verano.

**Consecuencia:** el mismo helper lo van a usar `/home/summary` (Fase 13) y las
estadísticas semanales de workouts (Fase 10). No se duplica el cálculo.

### La primera zapatilla queda como principal sola

**Decisión:** si no hay ninguna en uso, la que se crea nace `isPrimary`. Solo hay
una principal a la vez, y retirar un par lo saca de ese puesto.

**Razón:** el acumulador de kilómetros de la Fase 10 suma la distancia del
entrenamiento a la zapatilla principal del momento. Sin principal no tendría
destino y el usuario vería sus zapatillas siempre en 0 km sin entender por qué.
Decidir por él es mejor que ese silencio.

### `DELETE` de una zapatilla borra de verdad

**Decisión:** sin `deletedAt`, a diferencia de entrenamientos e inscripciones.

**Razón:** el kilometraje de una zapatilla es un contador, no historial: cada
`Workout` guarda su propia distancia y no depende de esa fila. No se pierde nada.
Para conservar el registro de uso ya existe **retirar**, que es lo que la app
debería ofrecer primero.

---

## Fase 5 — Maratones

### El estado de inscripción se deriva al leer, no se guarda

**Decisión:** `registrationStatus` en la base guarda solo la intención del admin
y se respeta únicamente cuando dice `closed`. Lo que responde la API lo calcula
`resolverEstado()` (`src/modules/marathons/registration-status.ts`) en cada
lectura, a partir de cupos, fecha de largada y cierre de inscripciones.

**Razón:** la alternativa era un job periódico que actualizara la columna. Entre
dos corridas del job la columna miente, y este dato decide si alguien puede
pagar o no: "estuvo mal durante cinco minutos" es exactamente el bug que después
nadie reproduce. Derivar no cuesta ninguna consulta extra y no puede quedar
desincronizado.

**Consecuencia:** la función es una sola, pura y con test unitario, y la va a
usar el checkout de la Fase 7 (`admiteInscripcion()`) para no reimplementar la
regla. La contrapartida está en el filtro del catálogo, abajo.

### El filtro `?status=` se aplica en memoria, no en SQL

**Decisión:** `MarathonsService.listar()` pide lotes y descarta los que no
coinciden, en vez de traducir el estado a un `WHERE`.

**Razón:** una de las reglas —"queda menos del 10% del cupo"— es aritmética
entre dos columnas, y Prisma no la sabe expresar en un `where`. Escribirla otra
vez en SQL crudo dejaría **dos copias de la regla** que se desincronizan en el
primer cambio, que es justo lo que la decisión anterior evita.

**Consecuencia, documentada en `docs/api.md`:** con filtro de estado una página
puede venir corta o vacía y traer `nextCursor` igual. El cliente pagina hasta
`nextCursor === null`. Sin filtro (el caso normal) es una sola consulta.

**Cuándo revisarlo:** si el catálogo pasa de unos cientos de maratones vivas, o
si el filtro por estado se vuelve la consulta caliente. La salida sería una
columna generada en Postgres con el estado, indexada — y ahí sí la regla estaría
en la base, con una migración que la documente.

### Paginación por cursor, con el cursor opaco

**Decisión:** `src/common/pagination/cursor.ts`. El cursor es base64url de
`{ v, id }`: el valor de la clave de orden más el id como desempate. Se pide
`limit + 1` filas para saber si hay página siguiente.

**Razón:** con `?page=`, una fila insertada mientras el usuario scrollea le hace
ver un elemento repetido o saltarse otro, y `OFFSET` grande obliga a Postgres a
contar y tirar filas. El desempate por id no es decorativo: sin él, dos
maratones el mismo día se pierden o se repiten entre páginas.

Que sea opaco permite cambiar el criterio de orden sin romper clientes viejos:
solo invalida cursores en vuelo. Y un cursor inválido **no da error**, empieza
desde el principio: casi siempre es uno viejo, y devolver 400 solo convierte una
molestia en una pantalla rota.

### `Paginated` en vez de que cada controlador arme el sobre

**Decisión:** un servicio que pagina devuelve `new Paginated(items, nextCursor)`
y el interceptor del sobre lo desarma en `data` + `meta.nextCursor`.

**Razón:** si cada controlador arma su respuesta a mano, en tres fases hay tres
formas distintas de decir "hay más". Fácil de revertir.

### El catálogo es público

**Decisión:** `/marathons/*` lleva `@Public()`.

**Razón:** una maratón publicada es información de difusión. Se comparte por
WhatsApp, se abre desde un deep link **antes** de instalar la app (Fase 16) y
mañana la lee el front-end web. Exigir token obligaría a registrarse solo para
mirar, y no protege nada que no esté ya en el afiche de la carrera.

**Lo que sigue protegido:** inscribirse (Fase 7) y todo lo no publicado, que da
404 aquí y solo se ve desde `/admin` (Fase 15).

### `publishedAt` en el futuro es un embargo

**Decisión:** la visibilidad es `publishedAt != null AND publishedAt <= now()`,
no solo `!= null`.

**Razón:** sale gratis y resuelve un caso real: el organizador deja la carrera
cargada y la API la publica sola a la hora acordada, sin que nadie tenga que
estar despierto para apretar un botón.

### El seed usa fechas relativas

**Decisión:** las maratones de ejemplo se siembran con `enDias(n)` desde el
momento de correr el seed, no con fechas fijas.

**Razón:** con fechas absolutas el catálogo de ejemplo se vence solo y a las
pocas semanas todo aparece `closed`, que es el único estado en el que no se
puede probar nada. Las cuatro carreras sembradas cubren a propósito `open`,
`closing_soon` por fecha, `closing_soon` por cupo y `full`.

El seed es idempotente por `slug` y **no pisa** lo que ya existe: correrlo dos
veces no deshace lo editado desde el panel.

---

## Fase 6 — Pricing

### El cargo apagado se expresa como `null`, no como `0`

**Decisión:** `calcularServiceFee()` devuelve `null` cuando no hay cargo, y la
API responde `serviceFee: null`. Nunca `{ amountCents: 0 }`.

**Razón:** es la diferencia entre "no hay cargo" y "hay un cargo que vale cero".
Una línea "Cargo por servicio — Bs 0,00" en el desglose le anuncia al usuario un
cargo que hoy no se le cobra; es una promesa que nadie quiso hacer, y la primera
pregunta del primer usuario que la vea. Ya estaba anticipado en la Fase 0 y aquí
se implementa: con `enabled = false`, la UI no pinta la línea.

### Un override apagado exime a esa carrera; no cae a la global

**Decisión:** el orden es override de la maratón → global → nada, y el override
manda **aunque venga con `enabled = false`**.

**Razón:** si un override apagado cayera de vuelta a la config global, no habría
manera de eximir del cargo a una sola carrera sin apagarlo para todas. Apuntar a
una config apagada es exactamente cómo se dice "esta carrera no cobra cargo".

### Un subtotal de 0 no paga cargo, ni siquiera el mínimo

**Decisión:** con `subtotalCents <= 0` no hay cargo, antes de mirar `minCents`.

**Razón:** sin esta guarda, un mínimo de Bs 5 convertiría una inscripción
gratuita o de cortesía en una de Bs 5 — lo contrario de lo que quiso el
organizador. El caso va a existir en cuanto alguien cargue una carrera libre.

### Con mínimo y máximo cruzados, manda el máximo

**Decisión:** se aplica primero el mínimo y después el máximo, así que un
`minCents` mayor que `maxCents` termina en el máximo.

**Razón:** es un dato mal cargado y hay que elegir un lado. Se elige el que
**cobra de menos**: equivocarse cobrando de más es un reclamo y una devolución;
equivocarse cobrando de menos es una diferencia contable que se corrige sin que
nadie se sienta estafado. Fácil de revertir si el panel valida el par al guardar
(Fase 15).

### Nada de coma flotante, y el porcentaje en puntos básicos

**Decisión:** todo el dinero en centavos enteros y el porcentaje en bps
(1000 = 10%). El redondeo es al centavo más cercano, con los medios hacia
arriba.

**Razón:** `0.1 + 0.2` no da `0.3` en coma flotante, y un centavo perdido por
redondeo en cada inscripción es una diferencia que después nadie sabe explicar.
Los bps evitan además el `10 / 100` que reintroduce el float por la ventana.

### El snapshot guarda también el subtotal

**Decisión:** `serviceFeeSnapshot` no guarda solo la config aplicada sino
también `subtotalCents` y `amountCents`.

**Razón:** con la config sola, el snapshot dice *cómo* se calculó pero no
permite verificar el número sin reconstruir el subtotal de esa inscripción a
partir de precios que ya cambiaron. Con la base incluida, el snapshot se
reaudita solo. Hay un test que lo comprueba recalculando desde el snapshot.

### `POST /pricing/quote` público y por POST

**Decisión:** cotización de vista previa sin token, con método POST.

**Razón (público):** se calcula solo sobre datos públicos —el precio de la
carrera, el recargo de categoría, los extras— y no crea ni reserva nada. Que el
precio que ve alguien sin cuenta sea el mismo que verá después de registrarse es
lo mínimo, y el catálogo ya es público.

**Razón (POST):** los extras son un array de objetos. Meterlos en la query
string obliga a inventar una serialización propia que después hay que mantener
también en Dart. No modifica nada.

**Qué no hace:** no reserva cupo ni stock, y deja cotizar una carrera cerrada o
llena. Mezclar cotizar con poder-comprar obligaría a la pantalla de detalle a
manejar errores de compra solo para mostrar un precio; el checkout de la Fase 7
es quien decide.

### La config global se lee en cada cotización, sin caché

**Decisión:** `ServiceFeeConfigService.global()` consulta Postgres cada vez.

**Razón:** es una fila única que Postgres sirve desde su caché de páginas. Un
caché en memoria de la API haría que apagar el cargo desde el panel tardara en
verse en cada instancia, y ese retardo —en el número que decide cuánto paga la
gente— no vale el ahorro. Fácil de revertir con Redis si alguna vez aparece en
un perfilado.

---

## Fase 7 — Inscripciones

### `SELECT ... FOR UPDATE` sobre la fila de la maratón

**Decisión:** el checkout entero corre dentro de una transacción que empieza
bloqueando la fila de la maratón con `$queryRaw` + `FOR UPDATE`. Cupo, stock y
correlativo del dorsal se leen y escriben con ese lock tomado.

**Razón:** sin él, dos personas comprando el último cupo a la vez leen ambas
`slotsTaken = 999`, ambas concluyen que hay lugar y ambas entran. La carrera
termina con un corredor de más y dos dorsales iguales, y se descubre el día de
la largada. Un `UPDATE ... WHERE slotsTaken < capacity` resolvería el cupo pero
no el correlativo del dorsal, que también hay que serializar.

**Cómo se verifica:** hay un test e2e que dispara los dos checkout en paralelo
contra una maratón de capacidad 1 y exige exactamente un 200 y un 409.

### El precio se recalcula dentro de la transacción

**Decisión:** el checkout no confía en el total que vio el cliente ni en el
guardado en el borrador: vuelve a llamar a `QuoteService`.

**Razón:** entre que el usuario abre el paso 3 y confirma pueden pasar horas. Si
el organizador subió el precio, cobrar el viejo es regalar plata; si lo bajó,
cobrar el viejo es un reclamo. Además cierra la puerta a que un cliente
manipulado mande su propio total.

### El desglose se congela al confirmar (`quoteSnapshot`)

**Decisión:** columna nueva `Registration.quoteSnapshot` (Json, nullable) con el
detalle exacto de líneas cobradas. Mientras la inscripción es borrador los
precios se recalculan en cada lectura; una vez confirmada se sirven congelados.

**Razón:** el esquema ya guardaba `subtotalCents`, `serviceFeeCents` y
`totalCents`, pero no el desglose línea por línea, así que un comprobante
emitido hoy mostraría los precios de mañana. El comprobante PDF de la Fase 8
necesita exactamente esto.

**Migración:** `20260819010606_registration_quote_snapshot`, aditiva y anulable.

### `POST /registrations` es idempotente por maratón

**Decisión:** si ya existe un borrador para esa maratón, se devuelve actualizado
en vez de crear otro.

**Razón:** el usuario que cierra la app en el paso 2 y vuelve al día siguiente
entra por la misma puerta y espera encontrar lo suyo. Sin esto se acumulan
borradores fantasma que después ensucian el listado y las métricas. Una
inscripción ya **confirmada** sí corta con `ALREADY_REGISTERED`.

### El dorsal se conserva al cancelar, y el correlativo nunca se reutiliza

**Decisión:** cancelar libera el cupo y el stock pero **no borra el
`bibNumber`**. El correlativo se calcula contando los dorsales ya emitidos,
canceladas incluidas.

**Razón:** si el contador se derivara de `slotsTaken`, una cancelación lo haría
retroceder y el siguiente inscripto recibiría un número ya usado — que el
constraint `(marathonId, bibNumber)` rechazaría, convirtiendo una cancelación
ajena en un error de inscripción propio. Conservar el dorsal además deja
trazabilidad de quién tuvo qué número.

**Consecuencia:** en una carrera con muchas cancelaciones los dorsales tienen
huecos. Es correcto: el dorsal identifica una inscripción, no una posición.

### El stock se descuenta con un update condicional, no leyendo antes

**Decisión:** `updateMany({ where: { id, stock: { gte: cantidad } } })` y se mira
cuántas filas se tocaron. Cero filas = alguien se llevó las últimas.

**Razón:** leer el stock, comprobar y después escribir deja una ventana entre la
lectura y la escritura por la que entran dos compradores. La condición dentro
del `UPDATE` la cierra sin depender del nivel de aislamiento. Los extras con
`stock: null` son ilimitados y no se tocan.

**Simetría:** cancelar devuelve el stock. Sin eso, un adicional se "agota" con
inscripciones que ya no existen.

### El checkout confirma directamente; el pago se intercala en la Fase 8

**Decisión:** hoy `POST /checkout` deja la inscripción en `confirmed`. La lógica
de reservar cupo, descontar stock y asignar dorsal vive en un bloque propio
dentro de la transacción.

**Razón:** el estado `pending_payment` sin un proveedor que lo resuelva sería una
inscripción que nunca avanza. Cuando la Fase 8 exista, el checkout dejará
`pending_payment` y este mismo bloque correrá cuando el proveedor confirme; el
contrato del endpoint no cambia para el cliente.

> **Superada por el checkpoint 8a.** Salió tal como se había previsto: el bloque
> se convirtió en `confirmarPago()` sin tocarse por dentro, y `prepararParaPago()`
> quedó delante. Se deja escrita porque la predicción se cumplió y eso vale más
> que borrarla.

### El listado no recotiza

**Decisión:** `GET /registrations` devuelve los totales guardados; solo el
detalle y `/quote` recalculan.

**Razón:** recotizar en el listado sería una consulta de precios por inscripción.
Los totales se guardan en cada paso, así que la lista siempre muestra números
correctos aunque no sean de este segundo.

---

## Checkpoint 8a — Pagos: núcleo y tarjeta

### El checkout vive en `payments`, no en `registrations`

**Decisión:** `POST /registrations/:id/checkout` lo sirve `PaymentsController`.
`RegistrationsController` conserva los pasos 1 y 2 y la cancelación.

**Razón:** el paso 3 es un cobro —cabecera de idempotencia, proveedor detrás,
compensación si falla—. Dejarlo en inscripciones obligaría a que inscripciones
dependa de pagos y pagos de inscripciones, es decir, a un ciclo entre módulos de
Nest. Así la dependencia va en un solo sentido: pagos conoce inscripciones, y
no al revés. La ruta que ve el cliente no cambia.

### Se cobra primero y se toma el cupo después

**Decisión:** el orden es validar → congelar precio → cobrar → confirmar dentro
de la transacción con la maratón bloqueada. Si la confirmación falla después de
un cobro aprobado, se **reembolsa automáticamente** y se devuelve el error de
dominio.

**Razón:** los otros dos órdenes posibles son peores. Tomar el cupo antes de
cobrar deja cupos retenidos por cobros que nunca se completan, y obliga a un job
de expiración. No compensar deja al usuario cobrado y sin carrera, que es el
único desenlace verdaderamente inaceptable. La comprobación de cupo previa al
cobro es optimista y puede quedar obsoleta —esa es justamente la ventana que
cubre el reembolso—, pero evita cobrarle a alguien una carrera que ya estaba
llena, que es el caso frecuente.

Si el reembolso automático también falla, se registra en `error` y queda para
resolver a mano desde el panel. Se prefiere un caso raro que exige intervención
a un caso frecuente que cobra de más.

### La clave de idempotencia se exige, no se genera

**Decisión:** `Idempotency-Key` es obligatoria en el checkout, la manda el
cliente, y una clave se quema con su resultado: reintentar un rechazo con la
misma clave devuelve el mismo rechazo.

**Razón:** una clave generada en el servidor cambia en cada request y no protege
de nada; solo una que viva del lado del cliente sobrevive a la conexión que se
corta después de enviar y antes de recibir. Y quemarla con el rechazo mantiene
la separación entre "reintentar lo mismo" y "pagar de otra forma": lo segundo es
una operación nueva y merece clave nueva.

### El libro mayor del mock es la propia tabla `payments`

**Decisión:** `MockPaymentProvider` lee el estado de los cobros de la tabla
`payments` en vez de tener un almacén propio.

**Razón:** un PSP real tiene su base del otro lado del cable; el mock no tiene
dónde. Un almacén en memoria perdería el estado en cada reinicio, que es
exactamente lo que rompería el polling del QR del checkpoint 8b. Es la única
licencia que se toma respecto de un proveedor de verdad y está acotada a esa
clase: nada fuera de ella lo asume.

### Cualquier tarjeta válida que no esté en la tabla se aprueba

**Decisión:** además de las tres deterministas del enunciado, cualquier número
que pase Luhn con CVV y fecha correctos se aprueba. Lo que no pasa esa
validación se rechaza con `invalid_card`.

**Razón:** si solo funcionaran tres números, los seeds y cualquier prueba manual
tendrían que memorizarlos. Rechazar por estructura antes de mirar la tabla
también separa bien los casos: un número mal tecleado es un error del formulario,
no un rechazo del emisor, y la UI los trata distinto.


---

## Checkpoint 8b — Pagos: QR y transferencia bancaria

### El QR es un PNG de verdad, aunque codifique algo inventado

**Decisión:** se genera con `qrcode` (v1.5.4, MIT, JS puro) un PNG escaneable de
512 px, guardado por `StorageService` como cualquier otro binario. El payload
imita la forma de un cobro por QR boliviano: `PACEUP-QR|id|monto|moneda|glosa`.

**Razón:** un placeholder gris no sirve para probar la pantalla. No se puede
enfocar con la cámara, no tiene el contraste real y no revela si el tamaño
elegido es escaneable, que es justamente lo que hay que descubrir antes de la
demo y no durante. Enchufar el formato real del banco adquirente será cambiar
esa cadena; el resto del flujo no se entera.

Se verificó en npm antes de instalar: `qrcode@1.5.4` y `@types/qrcode@1.5.6`,
licencia MIT, sin dependencias nativas (usa `pngjs`, no `canvas`).

### Los cobros pendientes se resuelven al leerlos, no con un cron

**Decisión:** `GET /payments/:id` es el endpoint de polling y **cada lectura
resuelve el cobro si ya toca**: lo da por pagado si venció el temporizador del
QR, o lo marca `failed` con `qr_expired` si pasó `expiresAt`.

**Razón:** el estado tiene que ser correcto **cuando alguien lo mira**, y quien
lo mira es siempre el polling del cliente. Un job periódico añadiría una pieza
móvil —y una ventana en la que la base dice una cosa y la respuesta otra— para
resolver un problema que nadie tiene. Hará falta un barrido el día que haya que
liberar recursos sin que nadie pregunte, no antes.

El `updateMany` condicionado a `status: pending` es lo que hace seguro que dos
sondeos simultáneos entren a la vez: solo uno cambia la fila y solo ese sigue
hasta la confirmación. Sin esa condición, dos polls podrían pedir dos dorsales.
Hay un test e2e que lanza tres sondeos en paralelo y verifica que sale un solo
dorsal.

### La transferencia bancaria no caduca

**Decisión:** `bank_transfer` queda `pending` sin `expiresAt` y solo la cierra
una persona desde el panel (o `mock-confirm` en desarrollo).

**Razón:** una transferencia entre bancos puede tardar un día hábil. Caducarla
sola dejaría al usuario con el dinero enviado y la inscripción muerta, que es
peor que un pendiente que dura. La glosa `PACEUP-XXXXXXXX` que se le devuelve es
lo que permite a quien confirma a mano saber a qué inscripción corresponde.

### `mock-confirm` existe, pero no en producción

**Decisión:** `POST /payments/:id/mock-confirm` responde 404 cuando
`NODE_ENV=production`, no 403.

**Razón:** un endpoint que da por pagado lo que nadie pagó no puede existir donde
hay dinero de verdad, ni siquiera detrás de autenticación. Y responde 404 y no
403 porque 403 confirmaría que la ruta existe: en producción, sencillamente no
está.

### La latencia artificial es configurable, no un número fijo

**Decisión:** `PAYMENT_MOCK_LATENCY_MIN_MS` / `MAX_MS` (300–1500 por defecto),
que los tests ponen en 0.

**Razón:** un cobro que responde en dos milisegundos deja la UI sin loaders y
esconde exactamente los bugs que aparecen cuando la red tarda —el doble tap en
"pagar", la pantalla que se cierra a mitad de camino—. En los tests esa espera
solo sería tiempo muerto: lo que se prueba es el estado del cobro, no cuánto
tarda.


---

## Checkpoint 8c — Pagos: webhook, comprobante y reembolsos

### La firma se calcula sobre el cuerpo crudo

**Decisión:** `NestFactory.create(AppModule, { rawBody: true })`, y la firma
HMAC se verifica sobre `${timestamp}.${cuerpo sin parsear}`.

**Razón:** `JSON.stringify(JSON.parse(x))` no devuelve `x`. Cambia el orden de
las claves, los espacios y los escapes de los no-ASCII, y la firma deja de
cuadrar. Es el error clásico de las integraciones de webhooks y solo aparece
cuando llega un payload con un acento, es decir, en producción.

La marca de tiempo entra en la firma porque, sin ella, quien capture un webhook
válido puede reenviarlo indefinidamente: el cuerpo no cambió, así que la firma
sigue siendo correcta. Con ella, fuera de `PAYMENT_WEBHOOK_TOLERANCE_SECONDS`
(300 s) se rechaza.

La comparación de digests es `timingSafeEqual`. Un `===` filtra, por lo que
tarda en fallar, cuántos bytes iniciales acertó quien prueba; con suficientes
intentos la firma se reconstruye byte a byte.

### Los tres motivos de rechazo responden lo mismo

**Decisión:** cabecera ausente, firma incorrecta y firma caducada devuelven las
tres `401 INVALID_WEBHOOK_SIGNATURE`. Y se verifica **primero** la firma y
después la frescura.

**Razón:** distinguirlas le diría a quien está probando cuál de las tres cosas
acertó, que es justo el mapa que necesita para seguir. Con el orden invertido,
alguien sin el secreto podría distinguir "firma válida pero vieja" de "firma
inválida" y confirmar que dio con el secreto.

### El webhook responde 200 aunque no aplique el evento

**Decisión:** con firma válida siempre `200`, con `handled: false` y un `reason`
cuando no se pudo aplicar. Solo la firma inválida corta.

**Razón:** un PSP que recibe un error reintenta con backoff durante horas o
días. Devolver 404 por un cobro que no conocemos convierte un evento
irrelevante en un bucle de reintentos indefinido. El `reason` deja el rastro en
la respuesta y en el log sin provocar ese bucle.

### No hay tabla de eventos procesados

**Decisión:** la idempotencia del webhook se apoya en el estado, no en un
registro de `event.id` vistos.

**Razón:** las tres operaciones ya son idempotentes: `acreditar()` condiciona su
`update` a `status: pending`, `confirmarPago()` devuelve la inscripción tal cual
si ya estaba confirmada, y reembolsar dos veces deja el mismo `refunded`. Una
tabla de deduplicación sería una segunda línea de defensa para algo que ya es
correcto, con su propio índice, su propia limpieza y su propia migración. Hay
tests e2e que reenvían el mismo evento y comprueban que no sale un segundo
dorsal.

### `forwardRef` entre inscripciones y pagos

**Decisión:** los dos módulos se importan mutuamente con `forwardRef`, y
`RegistrationsService` inyecta `PaymentsService` con `@Inject(forwardRef(...))`.

**Razón:** el ciclo es real y está en el dominio, no solo en el código: pagos
confirma inscripciones y la cancelación de una inscripción devuelve el dinero.
Las alternativas —mover el endpoint de cancelación a pagos, o meter un emisor de
eventos— esconderían la dependencia detrás de una capa más, y con eventos el
reembolso pasaría a ser asíncrono y sin confirmación, que para dinero es peor.
`forwardRef` es la herramienta que da Nest exactamente para esto: deja el ciclo
declarado y visible.

### El reembolso va después de liberar el cupo, y no puede tumbar la cancelación

**Decisión:** `cancelar()` libera cupo y stock en su transacción, y **después**
llama a `reembolsarDeInscripcion()`, que captura sus propios errores y no los
propaga.

**Razón:** si el proveedor está caído, con este orden el cupo ya volvió al pozo
y lo que queda pendiente es devolver dinero — visible en el log y resoluble a
mano desde el panel. Al revés, un fallo del proveedor dejaría una plaza
bloqueada para siempre y un usuario que no puede cancelar.

### `cancelled` y `refunded` son estados distintos

**Decisión:** cancelar deja la inscripción en `cancelled`; un reembolso llegado
por webhook la deja en `refunded`. En ambos casos vuelven el cupo y el stock.

**Razón:** son dos historias distintas —el usuario se echó atrás, o el proveedor
devolvió el cobro— y la diferencia es lo primero que alguien va a querer saber
cuando pregunte por qué se quedó sin plaza. El enum del esquema ya tenía los dos
valores; era el momento de usarlos.

### El comprobante es un comprobante, no una factura

**Decisión:** PDF generado con `pdfkit` (v0.19.1, MIT), en español, montos en
`Bs 1.234,56`, con una nota en el pie que dice explícitamente que no está
dosificado ante Impuestos Nacionales y no da derecho a crédito fiscal.

**Razón:** un documento con logo, NIT y totales que no aclara qué es se acaba
presentando como si fuera una factura. Decirlo en el propio papel cuesta dos
líneas y evita el malentendido. El día que haya facturación electrónica de
verdad, `ReceiptService` pasa a emitirla y el flujo de pagos no se entera.

Se cachea en `Payment.receiptUrl` porque sale de los datos congelados de la
inscripción: regenerarlo daría siempre lo mismo y solo gastaría CPU y disco.

### El formato de moneda se escribe a mano

**Decisión:** `formatearBs()` propio en vez de `Intl.NumberFormat`.

**Razón:** el resultado de `Intl` depende de los datos ICU que traiga el binario
de Node. Un VPS con `small-icu` devolvería `Bs 1,234.56` en lugar de
`Bs 1.234,56`. Un comprobante que cambia de formato según dónde corra el proceso
no es un comprobante. Las fechas sí usan `Intl` porque ahí lo que se necesita es
la conversión de zona horaria, pero el separador entre fecha y hora lo ponemos
nosotros, que es la parte que varía entre versiones de ICU.

### Candidatos reales de pago para Bolivia

Lo que haría falta para sustituir el mock por un cobro de verdad, en orden de
viabilidad:

1. **QR Simple (BCB) a través de un banco adquirente.** Es el medio dominante
   hoy. No se contrata con el BCB: se contrata con un banco (BNB, Mercantil
   Santa Cruz, BCP, Unión…) que expone su propia API para generar el QR y
   notificar el cobro. Hace falta cuenta empresarial, NIT y un contrato de
   comercio; cada banco tiene su formato de payload y su esquema de
   notificación, así que sería una implementación de `PaymentProvider` por
   banco. El endpoint de webhook y el ciclo `pending → paid` ya encajan tal cual.
2. **Pasarelas locales agregadoras** (Tigo Money, Yape/Soli, PSP regionales que
   revenden QR + tarjeta). Menos integración por nuestra parte a cambio de
   comisión más alta.
3. **Tarjeta internacional** (Stripe no opera en Bolivia; habría que ir por un
   adquirente regional o dLocal). Es el camino más caro y el medio menos usado
   por el público objetivo: se deja para el final a propósito.

Lo que **no** cambia al enchufar cualquiera de los tres: la interfaz
`PaymentProvider`, la tabla `payments`, los estados, la idempotencia del
checkout y el orden cobrar → confirmar → compensar. Lo que sí: el driver, el
formato del payload del QR, y el mapeo de los nombres de evento del webhook.

---

## Fase 9 — Planes de entrenamiento

### El calendario es una función pura, aparte del servicio

Ubicar cada sesión en su fecha, decidir qué semanas sobreviven a un recorte y
calcular rangos de ritmo vive en `plan-schedule.ts`: sin Prisma, sin Nest y sin
`Date.now()`. El servicio le pasa datos y recibe fechas.

**Por qué:** es la parte del módulo con más casos límite por línea (lunes que
caen en el mes anterior, carreras de domingo por la noche, planes que no entran)
y la que menos tiene que ver con la base de datos. Separada se prueba con una
tabla de casos en milisegundos; dentro del servicio haría falta levantar
Postgres para comprobar que un domingo cuenta en la semana correcta.

### La fecha de la carrera se lee en la zona de la maratón, no en UTC

`fechaLocal(startsAt, marathon.timezone)` antes de cualquier cálculo de semanas.

**Por qué:** una largada a las 06:00 de La Paz son las 10:00 UTC del mismo día,
pero cualquier evento de domingo después de las 20:00 locales ya es lunes en UTC.
Anclar por la fecha UTC correría el plan **entero** una semana en ese caso — y
justo la semana del tapering.

Para "hoy" se usa `DEFAULT_TIMEZONE` (`America/La_Paz`) y no la zona del usuario:
todavía no se guarda una zona por usuario, y para un producto boliviano la de la
app es una aproximación honesta. Cuando `UserPreferences` tenga zona, es cambiar
el argumento de `hoy()`.

### El recorte saca las semanas de base, no el tapering

Con menos semanas de las que pide la plantilla se conservan la primera y las dos
últimas, y se van las semanas de base **más tempranas**.

**Por qué:** el tapering es lo que hace llegar entero a la largada; sacrificarlo
para conservar volumen es exactamente al revés de lo que hay que hacer. Y dentro
del medio, quitar las semanas tempranas equivale a "entrar al plan donde ya está
en carga", que es el consejo estándar para quien empieza tarde. La alternativa
—repartir el recorte uniformemente— da un plan con saltos de carga entre semanas
consecutivas y no aporta nada a cambio.

El mínimo son 3 semanas (primera + tapering). Por debajo se responde
`PLAN_DOES_NOT_FIT` en vez de inventar un plan de dos semanas que no prepara
nada.

### Las semanas conservadas se renumeran

Un plan recortado de 16 a 8 semanas se numera 1..8, no 1, 9, 10, ...

**Por qué:** el usuario ve "semana 2 de 8". Conservar la numeración de la
plantilla obligaría al cliente a explicar por qué después de la semana 1 viene la
9, y a `PATCH /sessions/:id` le da igual. `templateSessionId` se guarda igual, así
que la trazabilidad hacia la plantilla no se pierde.

### Riegel vive en `pace-basis.ts` desde la Fase 9, no desde la 13

El PROMT pone `PredictionService` en la Fase 13 (tiempo estimado de llegada),
pero la instanciación de planes ya necesita el ritmo de referencia del corredor.

**Por qué:** la fórmula es de cinco líneas y duplicarla en la Fase 13 sería tener
dos versiones del mismo número. `riegel()` y `ritmoBase()` quedan exportadas y la
Fase 13 las envuelve en su servicio.

`T2 = T1 × (D2/D1)^1.06`. Se toma el **mejor** esfuerzo de las últimas 12 semanas
—el que mejor ritmo proyecta a la distancia objetivo— y no el promedio, porque el
plan se calibra sobre lo que el corredor puede sostener cuando le sale bien, no
sobre sus días malos. Se descartan los tramos de menos de 2 km (proyectar un
maratón desde 800 m da un número con la forma correcta y ninguna relación con la
realidad) y el resultado se acota entre 2:30/km y 15:00/km: por fuera de eso el
dato es basura, no un corredor.

Con menos de 3 entrenamientos se cae al nivel autodeclarado de la plantilla
(7:00 / 5:30 / 4:30 por km). Impreciso, pero no aleatorio — y la respuesta lo
dice en `paceBasisSource` para que la UI pueda avisar.

### Las plantillas guardan factores, los planes guardan ritmos

`paceFactor: 1.15` en la plantilla; `paceMinSecPerKm` / `paceMaxSecPerKm` en la
sesión del plan, con `± 4%`.

**Por qué:** una plantilla con ritmos absolutos sería una plantilla por nivel de
corredor. Con factores, las ocho plantillas del catálogo sirven a todo el mundo y
el único número que hay que estimar bien es el ritmo base. El rango se materializa
al instanciar y no se recalcula al leer: si el corredor mejora, el plan que ya
empezó no le cambia los objetivos a mitad de camino.

### Un solo plan activo, y abandonar el anterior se confirma explícitamente

`PLAN_ALREADY_ACTIVE` con el id y el nombre del plan en curso; el cliente
reintenta con `replaceActive: true`.

**Por qué:** abandonar seis semanas de entrenamiento no puede ser un efecto
secundario de pulsar "empezar plan" en otra pantalla. El servidor no decide por
el usuario, y devuelve el nombre para que el diálogo pueda decir cuál se pierde.

### El plan se cierra solo

Al completar la última sesión abierta, el plan pasa a `completed` e `isActive:
false`.

**Por qué:** nadie entra a la app a pulsar "terminar plan". Un plan que se queda
`active` para siempre le pide confirmación al usuario cada vez que quiera empezar
otro, por algo que ya terminó hace meses.

### Los planes se borran de verdad; los entrenamientos no

`DELETE /training-plans/:id` borra la fila. No hay `deletedAt`.

**Por qué:** el soft delete está para lo que duele perder, y un plan es una
proyección regenerable desde su plantilla en cualquier momento. Lo que sí duele
es el historial de carreras, y eso son `Workout`: la relación es `onDelete:
SetNull`, así que borrar el plan les quita el vínculo con la sesión y nada más.

### Reprogramar no cambia la semana

Mover una sesión al martes siguiente la deja en la misma `week`.

**Por qué:** la semana es el bloque de entrenamiento (carga, tipo de sesiones,
sesión clave), no una etiqueta de calendario. Recalcularla al mover dejaría
semanas de una sola sesión y otras de seis, y rompería el progreso que muestra el
selector. El límite es que la fecha nueva caiga dentro del plan.

### El catálogo de plantillas no pagina

**Por qué:** ocho plantillas de arranque, decenas en el peor caso realista. Un
cursor aquí sería maquinaria para un problema que no existe, y agregarlo después
es aditivo: `meta.nextCursor` no rompe a ningún cliente que hoy lo ignore.

---

## Checkpoint 10a — Entrenamientos: sesiones y consolidación

### Las métricas son del servidor, punto

El cliente manda sus números en `clientReported`; se guardan y no se publican.
Todo lo que la app pinta sale de `consolidar()`.

**Por qué:** el filtrado GPS de cada SDK es distinto, y dos teléfonos que hacen
el mismo recorrido reportan distancias que difieren en cientos de metros. En un
entrenamiento suelto da igual; en el ranking de una maratón significa que el
puesto depende del modelo de teléfono. Guardar lo que dijo el cliente cuesta una
columna `jsonb` y permite detectar deriva sin confiar en ella.

### `metrics.ts` es puro y se prueba sin base de datos

Haversine, filtrado, splits, elevación, tiempo en movimiento y calorías: un array
de puntos entra, unas métricas salen. Sin Prisma, sin reloj.

**Por qué:** es la lógica con más casos límite del backend (rebotes del GPS,
huecos de la app congelada, splits que caen a mitad de tramo) y la que menos
tiene que ver con la persistencia. Con veinte tests unitarios que corren en cinco
segundos se puede tocar el algoritmo con confianza; embebida en el servicio haría
falta sembrar Postgres para comprobar que un semáforo no cuenta como movimiento.

### Los tres filtros, y por qué esos números

| Filtro | Valor | Razón |
|---|---|---|
| Precisión | > 30 m se descarta | Lo pide el PROMT y coincide con lo razonable: entre edificios altos el GPS rebota 20–40 m |
| Velocidad | > 12,5 m/s (45 km/h) se descarta el tramo | Más rápido que el récord de 100 m, sostenido. Es el GPS reenganchando tras un túnel |
| Hueco | > 120 s no cuenta ni distancia ni tiempo | Es la app congelada en segundo plano. Unir los dos lados en recta inventa un recorrido |

El umbral de elevación son 3 m contra la **última altitud de referencia**, no
contra el punto anterior: comparar punto a punto acumula el temblor del sensor
entero y una carrera llana termina con 400 m de "desnivel".

### El tiempo parado sale de las posiciones, no de los eventos de pausa

`pause`/`resume` solo cambian el estado de la sesión (que es lo que abre y cierra
la ingesta). `movingSeconds` es la suma de los tramos con velocidad ≥ 0,5 m/s.

**Por qué:** contar con los eventos obliga a confiar en que todos llegan y en
orden. Una pausa cuyo `resume` se perdió en un túnel deja el entrenamiento con
horas de parada inventadas, y no hay forma de arreglarlo después. Las posiciones,
en cambio, ya están ahí y dicen la verdad. De paso resuelve la auto-pausa sin
necesidad de que el cliente la reporte.

El coste: el corredor que se para exactamente donde no hay señal pierde ese
tramo. Es un caso raro y el error va hacia el lado seguro (menos tiempo en
movimiento, ritmo medio ligeramente peor).

### El `ingestToken` no es el JWT del usuario

Token opaco de 256 bits, devuelto en claro una sola vez, guardado como sha256.

**Por qué:** es el credencial que sale del teléfono cada 20 segundos durante una
hora. Si se filtra, con el JWT se compromete la cuenta entera; con esto, lo único
que se puede hacer es mandar puntos a **una** sesión, y muere al cerrarla. Es
sha256 y no argon2 porque son 32 bytes aleatorios, no una contraseña: no hay
diccionario que atacar, y la ingesta lo verifica en cada lote — argon2 ahí sería
100 ms por lote de CPU regalados.

### Arrancar es idempotente, y el token se rota en el reintento

**Por qué lo primero:** el `clientUuid` lo genera el cliente sin red, y la
conexión que se corta entre mandar el arranque y recibir la respuesta es el caso
normal, no el raro. Sin idempotencia eso son dos entrenamientos.

**Por qué lo segundo:** el token anterior solo existe como hash, es
irrecuperable. Un cliente que perdió la respuesta original se quedaría sin poder
subir a su propia sesión. Rotar además invalida el viejo, que es justo lo que se
quiere si el reintento vino de otro dispositivo.

### Una sola sesión abierta por usuario

**Por qué:** dos sesiones vivas son dos flujos de posiciones del mismo teléfono y
ninguna forma de saber a cuál pertenece cada punto. El error devuelve el
`sessionId` de la abierta porque el 95% de las veces es una sesión colgada de
cuando el sistema mató la app: el cliente la cierra o la descarta y reintenta,
sin tener que buscarla.

### Descartar borra las posiciones de verdad; el workout no

`Workout.deletedAt`, pero `DELETE` real sobre las posiciones.

**Por qué:** son las dos mitades de la misma decisión. El workout es una fila
barata y recuperable desde el panel cuando el usuario se arrepiente. Las
posiciones son **datos de ubicación**: guardar el rastro completo de un recorrido
que el usuario pidió tirar es exactamente lo que no hay que hacer con un dato
sensible, y no sirve para nada — sin el workout no se pueden ni leer.

La política de retención completa de `positions` se documenta en la Fase 11.

### Los kilómetros de la zapatilla se suman dentro de la transacción

`ShoesService.sumarDistancia(tx, ...)` recibe la transacción del cierre.

**Por qué:** si la consolidación se cae, los kilómetros no pueden quedarse
sumados a un entrenamiento que no llegó a guardarse. Sin zapatilla principal
devuelve `null` y no pasa nada: mucha gente nunca registra sus zapatillas, y
tumbar la consolidación por un dato opcional sería perder el entrenamiento
entero.

La alerta de desgaste hoy es un `log`. El evento `shoe.wear_alert` sale por
`NotificationService` en la Fase 16; la respuesta del cierre ya trae
`shoe.wearAlert` para que la pantalla de fin de carrera lo pinte sin esperar a
esa fase.

### Cerrar la sesión del plan va fuera de la transacción

Si falla, se registra un `warn` y el entrenamiento se guarda igual.

**Por qué:** son dos cosas de distinta importancia. Perder una hora de carrera
porque la sesión del plan ya estaba marcada como saltada sería absurdo; el
usuario puede marcarla a mano en dos toques.

### Las calorías son `null` sin peso

**Por qué:** el método MET necesita el peso. Sustituirlo por "70 kg" da un número
que parece del usuario y no lo es, y es el tipo de dato que la gente compara con
lo que le dice el reloj. `null` es información honesta: la UI puede pedir el peso
en vez de mostrar una cifra inventada.

Aun con el peso es una estimación de gama, no una medida: sin frecuencia cardíaca
no hay forma de hacerlo mejor.

### El último split parcial no se emite

2,5 km dan **dos** splits, no tres.

**Por qué:** un split de 500 m tiene un ritmo que no se compara con los de 1 km, y
al ser el más corto es justo el que saldría como "mejor km". El resto sigue
contando en la distancia total, que es donde el usuario lo espera. Un tramo que
cruza la marca del kilómetro se reparte proporcionalmente: a 1 Hz el error es de
centímetros, pero en modo ahorro de batería (un punto cada 30 s) asignar el tramo
entero a un lado descuadraría los splits visiblemente.

---

## Checkpoint 10b — Historial, estadísticas y sincronización offline

### El sync resuelve entrenamiento por entrenamiento, no el lote entero

`POST /workouts/sync` devuelve `200` con un resultado por item (`created`,
`duplicated`, `rejected`) en vez de fallar el lote al primer problema.

**Por qué:** el móvil puede llevar dos semanas de cola y traer un entrenamiento
con un `planSessionId` que ya no existe. Rechazar los veinte por culpa de ese
condena al cliente a reintentar el mismo lote para siempre, y a no poder subir
nunca los otros diecinueve. El cliente borra de su cola los `created` y los
`duplicated`, y marca los `rejected` para no reintentarlos.

### La idempotencia real la da `clientUuid`, no la cabecera

`Idempotency-Key` se exige, pero lo que impide el duplicado es la unicidad de
`clientUuid` en la base.

**Por qué:** guardar la respuesta de cada clave necesitaría una tabla de
idempotencia con su expiración y su limpieza. `clientUuid` ya está en el esquema,
ya es único y ya identifica al entrenamiento desde antes de que exista la red:
reenviar cualquier lote, con la clave que sea, no puede duplicar nada. La
cabecera se pide igual porque es el contrato del endpoint y porque le deja claro
al cliente que el reintento es seguro.

### Sin puntos se le cree al usuario

Un item sin `points` se guarda como `source: manual` con el `distanceMeters` y el
`durationSeconds` que declara el cliente.

**Por qué:** es la única excepción a "las métricas son del servidor" (Checkpoint
10a) y no es una concesión: sin recorrido no hay nada que recalcular. Queda
marcado como `manual` para que se pueda distinguir de lo medido, aquí y en
cualquier ranking futuro.

### Los puntos sincronizados también cuelgan de una `TrackingSession`

Un entrenamiento subido offline crea su sesión de tracking ya cerrada, solo para
que las posiciones tengan de dónde colgar.

**Por qué:** la alternativa era una segunda forma de guardar un recorrido, y con
ella un `if` en cada consumidor futuro (mapa de la carrera, simplificación
Douglas-Peucker de la Fase 12, live tracking). El `ingestToken` de esas sesiones
es un marcador (`sync:<workoutId>`), no una credencial: la ingesta compara contra
un sha256 en hexadecimal, y una sesión cerrada no acepta posiciones.

### Un punto fuera de la ventana del entrenamiento se descarta

Solo se guardan y se miden los puntos entre `startedAt` y `endedAt`, con 5 min de
tolerancia a cada lado.

**Por qué:** un solo punto con la fecha a cero —el que emite el GPS al arrancar
en frío— convierte una hora de carrera en una duración de tres días, y además
mandaría filas a la partición de un mes que no toca. La tolerancia existe porque
el reloj del teléfono no coincide al segundo con el `startedAt` que el propio
cliente reporta.

### Semanas y meses se cortan en hora local, y el corte lo hace Postgres

Los agregados de `/workouts/grouped` y `/workouts/stats/weekly` usan
`date_trunc` sobre la hora local (`DEFAULT_TIMEZONE`), en SQL.

**Por qué:** en La Paz (UTC−4) toda carrera de domingo después de las 20:00
locales cae en lunes UTC, y contarla en la semana siguiente es mentirle al
usuario. Se hace en la base y no en el proceso porque traerse tres años de
entrenamientos para sumarlos en JavaScript funciona hoy, con historiales de
decenas de filas, y se cae solo el día que alguien lleve corriendo en serio.

### El resumen semanal se arma por día y se pliega en memoria

`stats/weekly` pide a la base el total **por día** y reparte en semanas con
`armarSemanas()`.

**Por qué:** un `GROUP BY week` solo devuelve las semanas que existen, y la tira
Mon–Sun necesita las casillas vacías tanto como las llenas: una semana sin correr
**es** información y tiene que aparecer con sus siete ceros. El pliegue es una
función pura y se prueba sin base de datos.

### Borrar un entrenamiento conserva las posiciones y los kilómetros

`DELETE /workouts/:id` marca `deletedAt` y no toca ni las posiciones ni la
zapatilla, al revés que descartar una sesión en curso (Checkpoint 10a).

**Por qué:** descartar es "esto nunca pasó, tíralo" y ocurre a los segundos;
borrar del historial es "no quiero verlo", y ese entrenamiento puede estar colgado
de una carrera o de una sesión de plan. Los kilómetros de la zapatilla tampoco se
restan: el desgaste del material ocurrió de verdad aunque el usuario esconda el
entrenamiento. La política de retención de las posiciones conservadas sigue
pendiente para la Fase 11.

### El historial pagina hacia atrás

`GET /workouts` ordena por `startedAt DESC` y usa `antesDe()`, la mitad simétrica
de `despuesDe()` en `common/pagination/cursor.ts`.

**Por qué:** la pantalla abre por arriba y el usuario baja; paginar en ascendente
obligaría a traerlo todo para pintar los tres últimos. El listado no incluye
splits porque el historial no los pinta y son diez o cuarenta filas por
entrenamiento.

---

## Checkpoint 11a — Ingesta de posiciones

> El detalle operativo (endpoint, límites, motivos de rechazo) está en
> `docs/tracking.md`. Aquí solo el porqué de cada decisión.

### Se descartó montar un servidor Traccar

La ingesta se implementa directamente en Node.

**Por qué:** Traccar existe para hablar los ~200 protocolos binarios de trackers
de hardware (localizadores de flota, balizas OBD-II). Una app de celulares no usa
ninguno: manda JSON por HTTPS. La parte que de verdad es difícil —mantener el GPS
vivo en segundo plano con el sistema operativo intentando matar la app— la
resuelve el plugin de Flutter, no el servidor, así que Traccar no ayudaría
justamente donde duele. A cambio costaría una JVM (~700 MB de RAM en un VPS de 4
GB), un segundo modelo de datos que sincronizar con el nuestro y una segunda
superficie que actualizar y proteger.

Lo que sí se conserva de esa idea son las dos puertas abiertas, que son baratas:
`PositionIngestionSource` y el endpoint compatible con el protocolo OsmAnd
(checkpoint 11b), con el que la app oficial de Traccar Client, un reloj o un
tracker físico pueden apuntar a este backend sin cambios.

### La ingesta se autentica con el `ingestToken`, no con el JWT

`POST /tracking/sessions/:id/positions` es `@Public()` para el guard de JWT y lo
protege `IngestTokenGuard`.

**Por qué:** es el único endpoint que recibe un credencial cada veinte segundos
durante una hora seguida, desde un teléfono, muchas veces por red móvil abierta.
Ese credencial tiene que ser el de menor alcance posible: el `ingestToken` sirve
para mandar puntos a **una** sesión, muere cuando la sesión se cierra y no da
acceso a nada más de la cuenta. Pasear el JWT de usuario mil veces por
entrenamiento sería mucho más caro de perder.

Token inexistente y token de otra sesión responden lo mismo (`401
INVALID_INGEST_TOKEN`): distinguirlos sería un oráculo para adivinar ids ajenos.

### El rate limit se cuenta por sesión, no por IP

`IngestThrottlerGuard` sobrescribe `getTracker()` para usar el id de la sesión.

**Por qué:** media maratón entera sale por la misma red móvil con la misma IP
pública. Un límite por IP tiene que elegir entre dejar pasar a un cliente roto o
cortar a doscientos corredores legítimos a la vez; por sesión no hay que elegir.
La sesión ya viene resuelta por el guard anterior, así que no cuesta nada.

### Solo se rechaza lo imposible; la precisión mala se guarda

Fecha en el futuro, fecha anterior al arranque y coordenada fuera de rango se
descartan. La precisión (`accuracy > 30 m`) **no**: eso lo filtra `metrics.ts` al
consolidar.

**Por qué:** guardar un punto impreciso cuesta una fila y deja recalcular el
entrenamiento con otro umbral el día que haga falta. Tirarlo en la ingesta es una
decisión irreversible tomada con la peor información disponible. Y los rechazos
se cuentan por motivo en la respuesta porque un número alto es un síntoma del
cliente (reloj desincronizado, cola sucia), no ruido que convenga esconder.

Ningún punto malo tumba el lote: se responde `202` con el desglose. Un lote de
treinta puntos del que uno tiene la fecha corrupta no puede costar los otros 29.

### La pausa ya no cierra la ingesta

Se acepta en `active` y en `paused`; solo `finished` y `discarded` dan `409`.

**Por qué:** en el Checkpoint 10a se dijo lo contrario, y era un error. Un lote en
vuelo cuando el usuario pulsa "pausa" contiene puntos que ocurrieron de verdad; si
se rechaza, el cliente lo reintenta, vuelve a fallar y acaba tirándolos. El tiempo
parado sale igual de las posiciones al consolidar, así que aceptar esos puntos no
falsea nada. Corregido también en `docs/api.md`.

### El dedupe es del índice, no de una consulta previa

`createMany({ skipDuplicates: true })` sobre el único `(clientPointId,
recordedAt)`.

**Por qué:** comprobar antes con un `SELECT` sería una consulta extra por lote y
además una carrera: dos reintentos simultáneos pasarían los dos la comprobación.
El índice decide, y decide bien aunque lleguen a la vez.

### `workoutId` se llena al cerrar, no al ingerir

Los puntos entran con `workoutId: null` y se cuelgan del entrenamiento en el
`finish`.

**Por qué:** hasta ese momento la sesión todavía puede descartarse, y entonces
esos puntos no pertenecen a ningún entrenamiento. Rellenarlo al llegar obligaría
a limpiarlo después.

### Las particiones se crean solas, con memoria en el proceso

`PrismaService.ensurePositionsPartitions()` recuerda los meses ya comprobados.

**Por qué:** la ingesta llama a esto en cada lote, varias veces por minuto y por
corredor; sin caché sería una consulta extra por lote para crear una partición
que ya existe. Al reiniciar el proceso vuelve a preguntar una vez por mes, que es
gratis. Sigue habiendo una partición `positions_default` como red de seguridad.

### Sin BullMQ todavía

El PROMT pide que el post-procesado pesado vaya a una cola. Hoy no hay
post-procesado: la ingesta guarda y responde, y las métricas se calculan una sola
vez al cerrar la sesión.

**Por qué:** meter Redis, BullMQ, un worker y su supervisión para no ejecutar nada
es infraestructura que hay que mantener sin recibir nada a cambio. La cola entra
en la Fase 14, cuando haya que publicar posiciones a espectadores en vivo — que
es el primer trabajo que de verdad no cabe en el request.

### `PositionIngestionSource` con una sola implementación, a propósito

La interfaz existe con `AppBatchSource` como única implementación.

**Por qué:** normalmente una interfaz con un solo implementador sobra. Aquí la
segunda llega en el mismo checkpoint siguiente (OsmAnd) y el PROMT la pide
explícitamente como puerta abierta. Lo que hace que valga la pena no es la
interfaz en sí sino dónde está la frontera: la fuente **solo** traduce su payload
a `PuntoNormalizado[]`; validar, deduplicar y guardar vive una vez y no se
duplica por fuente.

---

## Checkpoint 11b — OsmAnd y simulación

### El `id` del dispositivo es el credencial del endpoint OsmAnd

`GET|POST /tracking/osmand?id=<uniqueId>&…`, sin token ni JWT.

**Por qué:** el protocolo no tiene dónde meter nada mejor — un tracker físico
solo sabe decir quién es. La alternativa era no soportarlo, y con eso se cierra
la puerta a Traccar Client, a los relojes y a cualquier hardware que no vayamos a
escribir nunca.

El daño queda acotado por dos cosas: el `uniqueId` es un UUID que genera la app
(no un número de serie adivinable), y un punto solo entra si ese dispositivo
tiene una **sesión abierta**. La ventana de abuso es la duración de un
entrenamiento, no la vida de la cuenta.

### Un GET suelto no abre sesión

Sin sesión abierta la respuesta es `409 SESSION_NOT_ACTIVE`.

**Por qué:** abrir una sesión al primer punto sería cómodo justo una vez y molesto
para siempre: un tracker olvidado encendido en un cajón generaría entrenamientos
fantasma a perpetuidad, y habría que inventar reglas para cerrarlos. La sesión la
abre quien sale a correr.

### El `speed` de OsmAnd se guarda tal cual

Se asume m/s y no se convierte.

**Por qué:** Traccar lo interpreta en nudos y los clientes no se ponen de acuerdo,
así que cualquier conversión sería una suposición disfrazada de dato. Da igual:
las métricas se calculan desde las coordenadas (`metrics.ts`) y este campo es
solo informativo. Documentado en `docs/tracking.md` para que nadie lo use como
fuente de verdad.

### La query de OsmAnd se valida sin `forbidNonWhitelisted`

Decorador `@OsmAndQuery()`: descarta los campos de más y deja que la validación
global se ocupe del resto ya limpio.

**Por qué:** Traccar Client manda `hdop`, `charge`, `cell`, `wifi`… La regla
global —rechazar lo que no se pidió— es correcta para *nuestra* API, donde un
campo desconocido es casi siempre un cliente mal escrito; aplicada a un protocolo
ajeno convertiría cada versión nueva del cliente en un 400. Con un protocolo que
no controlamos, lo correcto es ignorar lo que no se entiende.

### El límite de OsmAnd es otro número y otra unidad

`TRACKING_OSMAND_POINTS_PER_MINUTE` (120) por **dispositivo**, contra los 20
lotes por sesión de la app.

**Por qué:** aquí cada punto es una petición, así que a 1 Hz un tracker manda 60
por minuto y el límite de lotes lo cortaría en el primer minuto. Y la sesión
todavía no está resuelta cuando corre el throttler —se descubre dentro del
handler, a partir del `id`—, así que la unidad de cuenta es el dispositivo.

### La simulación entra por el mismo `ingerir()`

`POST /tracking/simulate`, con el `ingestToken`, solo fuera de producción.

**Por qué:** un simulador que escribiera directo en `positions` probaría el
simulador, no la ingesta. Pasando por el camino real, la misma validación y el
mismo dedupe que sufren los puntos de verdad, si la simulación consolida bien es
porque el camino real funciona. Y se autentica igual que la ingesta porque hace
lo mismo: meter puntos en una sesión.

Los tiempos van hacia atrás desde ahora y la sesión se retrasa si el track no
cabe: un recorrido de veinte minutos en una sesión recién arrancada tendría todos
los puntos en el futuro y se descartaría solo. Es un detalle feo, pero es
exactamente lo que evita que la herramienta de pruebas mienta.

### Los puntos simulados se guardan como `app_batch`

Con el `clientPointId` prefijado `sim-`.

**Por qué:** el enum `PositionSource` no tiene un valor para simulación y añadirlo
es una migración para una herramienta que no existe en producción. El prefijo
alcanza para reconocerlos. Si algún día hay que filtrarlos en consultas, ahí sí
toca la migración — anotado con un `ponytail:` en el código.

---

## Fase 12 — Carreras

### La sección se direcciona por `registrationId`, no por `raceResultId`

La inscripción existe desde que el corredor paga; el `RaceResult` no nace hasta
que cruza la meta. Si las rutas colgaran del resultado, la mitad de la pantalla
—todas las carreras próximas, que son justo las que el usuario mira a diario— no
tendría URL, y habría que inventar un segundo esquema de direcciones para ellas.
Con la inscripción como clave hay una sola ruta y `result: null` mientras no haya
tiempos.

### El resultado lo produce el cierre de la sesión, no un endpoint propio

No hay `POST /races`. Cuando se finaliza —o se sincroniza— un entrenamiento que
venía atado a una inscripción, el módulo de carreras lo convierte en resultado
oficial. Un endpoint aparte significaría que el corredor puede terminar la
maratón y quedarse sin resultado porque la app no hizo la segunda llamada.

La llamada es **best-effort y no propaga errores**: el entrenamiento ya está
guardado, y tumbar esa respuesta porque el resultado no cuajó le haría creer al
corredor que perdió la carrera entera. Queda el log; el resultado se puede
rehacer desde el panel, el entrenamiento no.

Es idempotente por `registrationId` (`upsert`), así que reprocesar es seguro.

### La meta se cruza en el último punto, no al pulsar "finalizar"

`finishedAt` sale del último punto del recorrido. El botón lo pulsa alguien que
acaba de correr 42 km y a veces tarda dos minutos en encontrarlo; peor, un
entrenamiento grabado sin cobertura puede subirse tres horas después. Cualquiera
de las dos cosas metería ese retraso en el tiempo oficial de todos los que
llegaron detrás.

### `finishTime` desde la largada, `chipTime` del propio corredor

El tiempo oficial se mide contra `marathon.startsAt` porque **eso** es lo que
ordena una clasificación: dos corredores que salen en cajones distintos no son
comparables por su reloj. `chipTimeSeconds` guarda el del corredor, que es el que
la app enseña como marca personal.

Si el tiempo desde la largada saliera negativo —un reloj desfasado, o alguien
probando el flujo antes de la carrera— cae al tiempo del corredor. Un número
negativo en una clasificación es peor que uno impreciso.

### Los empates comparten puesto

Dos corredores con el mismo tiempo oficial son ambos terceros, y el siguiente es
quinto. Es la regla de cualquier clasificación deportiva; numerarlos 3 y 4 por
orden de `id` inventaría una diferencia que no existe y que además cambiaría al
reordenar.

### Los puestos se recalculan sobre la maratón entera

Cada vez que entra un resultado se reordena toda la maratón, y solo se escriben
las filas cuyo puesto cambió. Con miles de resultados son decenas de
milisegundos. La alternativa —insertar en el medio y arrastrar los de abajo— es
la clase de optimización que acaba dejando dos corredores con el mismo puesto por
un fallo a mitad de camino.

`recalcularPuestos(marathonId)` es público desde ya: es lo que va a invocar la
acción "cargar resultados" del panel (Fase 15).

### Douglas-Peucker con tope duro de vértices

Una maratón de cinco horas a 1 Hz son ~18.000 posiciones. Sin simplificar son
~500 KB de JSON, varios segundos de parseo en el móvil y un `Polyline` que no se
dibuja a 60 fps.

Se eligió Douglas-Peucker y no un muestreo "uno de cada diez" —que es más corto
de escribir— porque conserva la **forma**: tira los puntos de las rectas y
respeta las curvas. Un muestreo redondearía las esquinas y cortaría las
horquillas de un cerro, que en La Paz son medio recorrido.

La tolerancia arranca en 5 m (el propio error del GPS de un teléfono en un buen
día: afinar más sería dibujar el ruido con más detalle) y **se duplica hasta
caber en 2.000 vértices**. El tope es duro a propósito: un recorrido con GPS
ruidoso se resiste a la simplificación, y nadie quiere descubrirlo el día de la
carrera con 40.000 puntos en vuelo.

Está implementado iterativo, con pila propia: la versión recursiva es más corta
pero su peor caso es una rama por punto, y aquí los puntos son decenas de miles.

### Los checkpoints se calculan en `metrics.ts`, no en el módulo de carreras

Tienen que salir del **mismo** recorrido filtrado que la distancia y los splits.
Calculados aparte, con otro criterio de descarte, el marcador del km 20 caería en
un sitio donde el corredor —según el resto de la API— no estuvo.

El punto se interpola dentro del tramo que cruza la marca. Con muestreo de 1 Hz
da igual, pero en modo ahorro de batería hay 30 s entre puntos y clavar el
marcador en el siguiente regalaría medio minuto de parcial.

### El comprobante no se reimplementa: se delega en pagos

`GET /races/:id/receipt` resuelve cuál fue el cobro y llama al mismo servicio que
`/payments/:id/receipt`. Dos generadores de PDF para el mismo cobro acabarían
dando dos documentos distintos, y el que llega a Impuestos siempre es el que no
revisaste.

### La tarjeta se compone como SVG y la rasteriza `sharp`

`sharp` ya está instalado para los avatares. Puppeteer —un Chrome entero, ~400 MB
de RAM por proceso, para dibujar seis líneas de texto— está descartado en el
PROMT y con razón.

**Ceiling conocido:** el texto lo rasteriza librsvg con las fuentes *del sistema*.
En un VPS pelado no hay ninguna y la tarjeta saldría en blanco; `fontconfig` y
`fonts-dejavu-core` van en la lista de paquetes de `docs/despliegue.md` (Fase 18).
Empaquetar una fuente propia es el siguiente paso si se quiere tipografía de
marca.

Se **regenera en cada POST**, sobre la misma clave de archivo. El puesto cambia
cuando el organizador carga los resultados que faltaban, y una imagen cacheada
seguiría diciendo "puesto 12" cuando ya es el 40. Como la clave no cambia, la URL
tampoco.

### En la base se guarda la clave del archivo, no la URL

`shareCardUrl` almacena `races/cards/<id>.png` y la URL pública se recalcula al
leer, igual que los avatares. Guardar `http://localhost:3000/...` en una fila es
una bomba de relojería que estalla el día del despliegue.

### El gasto total sale de los pagos, no de los precios

`totalSpentCents` suma los `Payment` en estado `paid`. Un precio de catálogo
cambia y un cobro no: sumar precios le mostraría al usuario un total que nunca
pagó. Un reembolso mueve el pago a `refunded`, así que sale de la suma solo — no
hay que restarlo aparte.

---

## Fase 13 — Home y predicción

### El home es un módulo de composición, sin tablas ni reglas propias

`HomeService` no calcula nada suyo: le pide a maratones, planes y entrenamientos
lo que ya saben responder y lo cose. El día que cambie cómo se cuenta una semana
de plan, cambia en planes y el home se entera solo. Todas las flechas salen de
este módulo y ninguna entra, así que no puede cerrar un ciclo con nadie.

### Un endpoint agregado en vez de cinco llamadas

Arrancar la app pidiendo maratón, plan, semana, sesión de hoy y estadísticas por
separado son cinco viajes en serie sobre una red móvil boliviana, y cinco
oportunidades de que una falle y la pantalla quede a medias. Aquí van juntas y en
paralelo. El precio —un endpoint que no es REST puro— lo paga el servidor una
vez; el otro lo paga el usuario en cada arranque.

No hay caché. El pull-to-refresh es volver a llamar, y una caché de home es
exactamente lo que hace que el usuario tire hacia abajo tres veces preguntándose
por qué no aparece el entrenamiento que acaba de subir.

### La maratón propia gana a la del catálogo

Si el usuario tiene una carrera pagada por delante, esa es la destacada aunque sea
más lejana que otra del catálogo. Taparla con una promocionada sería publicidad
en el sitio donde el corredor mira su dorsal. Sin inscripción sí se muestra la
próxima publicada, que ahí es una invitación legítima.

### La tira cruza plan y realidad por fecha, no por día de la semana

Mientras el plan está en curso, su semana y la del calendario coinciden y las dos
formas dan lo mismo. Pero `semanaActual` devuelve la **última** semana de un plan
ya terminado —a propósito, para que el selector no tenga que saber de bordes—, y
casar por `weekday` pintaría las sesiones de marzo sobre la tira de esta semana.
Cruzar por `scheduledDate` es correcto en los dos casos y cuesta lo mismo.

### Riegel sobre el mejor esfuerzo, no sobre la media

Se proyecta cada entrenamiento de las últimas 12 semanas a la distancia objetivo
y se toma el **mejor** resultado. Promediar mezclaría los rodajes suaves —que son
la mayoría de lo que corre cualquiera— y devolvería el ritmo de *entrenar*, no el
de *competir*.

Se descartan los esfuerzos de menos de 2 km: proyectar una maratón desde 800 m da
un número con la forma correcta y ninguna relación con la realidad.

Ventana de 12 semanas (el PROMT admite 8–12): lo de hace tres meses todavía dice
algo, y con una ventana corta un usuario que se lesiona dos semanas se queda sin
predicción justo cuando más quiere verla.

### La corrección por volumen solo puede empeorar el pronóstico

Riegel asume un corredor **entrenado para esa distancia**. Quien corre 15 km por
semana y se apunta a una maratón no va a hacer el tiempo que dice la fórmula, y
enseñárselo sin más es mandarlo a reventar en el km 30.

Se compara el volumen semanal medio contra el que los planes de fondo dan por
supuesto —unas **2,5 veces** la distancia de la carrera— y se aplica una
penalización proporcional a lo que falte, con tope del **12%**. Sobre una maratón
de 4 h son casi 30 minutos: suficiente para que la cifra deje de ser optimista sin
convertir la pantalla en un castigo.

La corrección es **unidireccional a propósito**: tener mucho volumen no te hace
más rápido de lo que ya demostraste ser, así que nunca regala tiempo. No se
pretende precisión —no la hay sin un test de laboratorio— sino no mentir hacia el
lado peligroso.

### `confidence` la manda la extrapolación, no la cantidad de datos

Proyectar una maratón desde un 10K estira la fórmula cuatro veces más allá de lo
demostrado, y eso pesa mucho más que tener tres entrenamientos o treinta. Por
encima de 3× la distancia del mejor esfuerzo, `low`; por encima de 2×, `medium`.

### Sin datos se responde 200 con `reason`, no un error

Con menos de 3 entrenamientos útiles, `finishTimeSeconds` es `null` y `reason` es
`insufficient_data`. En el home eso no es un fallo: es un corredor que acaba de
instalar la app. Devolver un 404 o un 409 obligaría al cliente a envolver la
llamada en un `catch` para pintar un estado perfectamente normal — y a distinguir
ese error de los que sí lo son.

### La fórmula vive en un archivo puro, separada de Prisma

`prediction.ts` no toca la base y `prediction.service.ts` no toca la fórmula.
Ajustar la predicción es cambiar un archivo y correr su test, sin levantar
Postgres. Es el mismo reparto que en `metrics.ts` y por la misma razón: lo que se
va a discutir mil veces tiene que poder probarse en un segundo.

---

## Fase 14 — Tiempo real

### El socket exige token, aunque el PROMT lo dejara para después

La sección 7.5 lista la autorización de espectadores como pendiente. Aun así el
handshake pide un JWT válido: las posiciones de una persona en tiempo real son de
lo más sensible que guarda esta API, y un namespace público es de esas puertas que
nadie se acuerda de cerrar después. Lo que queda pendiente es la política **fina**
—público, solo inscritos, enlace compartido—, no la puerta.

### Se verifica al conectar, no en cada mensaje

Un socket vive horas; verificar el JWT en cada evento sería verificarlo miles de
veces por el mismo cliente. La contrapartida es que el token puede caducar con el
socket abierto: el peor caso es un espectador viendo dorsales quince minutos de
más, y pagar por eso una verificación por mensaje no sale a cuenta.

### Solo se publican las carreras

La sesión guarda `marathonId` al arrancar si venía con `registrationId`. Sin él no
se publica nada: un entrenamiento por el barrio no tiene espectadores ni debe
tenerlos. Guardarlo en la sesión, y no deducirlo, es lo que evita una consulta por
lote en el camino caliente para casi siempre no publicar nada.

### El payload lleva el dorsal y nada más

Ni nombre, ni `userId`, ni id de sesión. Quien mira el mapa ve un número en una
carrera pública, que es lo mismo que vería desde la acera. Todo lo que se añada
ahí es información personal retransmitida a desconocidos.

### La distancia en vivo es aproximada, y se dice

Se acumula con haversine sobre los puntos del lote, sin el filtrado por precisión
ni el descarte de saltos imposibles de `consolidar()`. Un mapa en vivo se mira a
escala de kilómetros y unos metros de ruido no cambian nada; aplicar el filtrado
bueno en cada lote sería rehacer el recorrido entero cada veinte segundos. El
número que vale, el que acaba en la clasificación, es el de la consolidación.

### El throttling es la única forma de que esto escale

Una posición por corredor cada 5 s. El coste real no es emitir, es el **abanico**:
con N corredores y M espectadores se entregan `(N/5) × M` mensajes por segundo.
Con 500 corredores y 200 espectadores son 20.000/s, que aguanta el VPS previsto;
con 5.000 y 2.000 son dos millones por segundo, que no aguanta nadie. Por eso el
clustering no es opcional a partir de unos cientos de corredores, y por eso el
número vive en `LIVE_UPDATE_MIN_INTERVAL_MS` y no incrustado en el código.

### El estado del throttling vive en memoria, no en Redis

Con el despliegue previsto —un VPS, un servicio systemd— el mapa en memoria es
exacto y cuesta cero. Con varias instancias cada una llevaría su contador y un
corredor podría emitir hasta N veces por ventana; el arreglo es un
`SET clave NX PX <ventana>` en Redis en lugar del mapa, unas cinco líneas. Está
marcado con un comentario `ponytail:` en `live.service.ts`.

Las **salas** sí funcionan repartidas desde ya, porque el adapter de Redis está
puesto: es la diferencia entre "el throttling se relaja" y "media audiencia no ve
nada", y solo la segunda es un fallo que no se detecta mirando logs.

### El adapter de Redis se pone hoy aunque hoy no haga falta

Corre una sola instancia. Se instala igual porque es la pieza que permite añadir
la segunda sin tocar una línea de lógica, y porque el día que haga falta será
durante una carrera. Si Redis no responde al arrancar, la API levanta igual con el
adapter en memoria y un `error` en el log: una carrera sin mapa de espectadores
sigue siendo una carrera, pero una API caída no.

### La flecha va de tracking a realtime, nunca al revés

`TrackingModule` importa `RealtimeModule` y publica; realtime no sabe que existe
la ingesta. Así el módulo caliente —el que recibe un lote cada veinte segundos— no
arrastra sockets, y `LiveService.publicar()` **nunca lanza**: el lote ya está
guardado y el corredor no tiene por qué enterarse de que el mapa se cayó.

---

## Fase 15 — Panel de administración

### AdminJS se descartó: no es compatible con este stack

El PROMT pide AdminJS con el adaptador de Prisma. **No se puede usar**, y no por
preferencia. Dos bloqueos, los dos verificados contra el registro de npm antes de
decidir nada:

| Pieza | Estado | Choque |
|---|---|---|
| `adminjs@7.8.17` | `"type": "module"` | El proyecto compila a **CommonJS**. AdminJS 7 es ESM puro |
| `@adminjs/prisma@5.0.4` | peer `@prisma/client: ^5.0.0 \|\| ^6.0.0` | Este proyecto usa **Prisma 7** |

La versión más alta del adaptador de Prisma es la 5.0.4 y no declara soporte para
Prisma 7 — que además cambió dónde y cómo se genera el cliente, que es
exactamente lo que el adaptador introspecciona.

Las salidas eran: bajar el proyecto entero a Prisma 6, migrar el build a ESM, o
no usar AdminJS. Romper el ORM de toda la API por un CRUD generado es cambiar el
cimiento por el mueble.

**Lo que se hizo:** la parte que el PROMT declara importante —*"toda la lógica
vive en servicios de Nest expuestos también como endpoints REST bajo
`/api/v1/admin/*`, y AdminJS solo los invoca"*— está completa, y en su sitio hay
una página estática de una sola pieza que consume esa API.

Ese reparto era el punto del requisito: cuando se construya el panel web propio,
la API ya está lista y no hay que reimplementar nada. Lo que cambia es que el
cliente de hoy son 400 líneas de HTML sin dependencias en vez de un framework de
administración — que además no habría que desmontar después.

### Lo que falta respecto al PROMT

AdminJS regalaba el **CRUD completo** de siete recursos (crear y editar
maratones, categorías, extras, plantillas de plan y sus sesiones). Eso no está:
el panel de hoy es de lectura más las seis acciones. Escribir a mano el CRUD de
esos recursos es una fase propia, no la coleta de esta — ver la regla 0.3 del
PROMT sobre el tamaño de las fases.

Las **seis acciones personalizadas** que el PROMT llama "las que AdminJS no da
gratis" sí están todas: activar/desactivar el fee con vista previa,
publicar/despublicar, confirmar transferencia, cerrar inscripciones, cargar
resultados con recálculo de puestos y exportar a CSV.

### La página no tiene ningún privilegio

`GET /admin` sirve HTML sin un solo dato dentro. Se marca `@Public()` porque un
guard sobre el HTML solo conseguiría que el navegador —que no manda cabeceras
`Authorization` al pedir una página— recibiera un 401 en vez del formulario. La
puerta está donde tiene que estar: en `/api/v1/admin/*`, con `@Roles('admin')`.

El token vive en `sessionStorage` y muere al cerrar la pestaña. No hay cookie de
sesión, así que no hay CSRF que gestionar.

### El HTML va en un `.ts`, no en un `.html`

Como plantilla de TypeScript entra en `dist/` con el resto del código. Un `.html`
suelto obligaría a tocar la configuración de assets del build, y el día que
alguien reordene el `nest-cli.json` el panel desaparece en producción sin que
falle ningún test.

### Ninguna acción reimplementa reglas de otros módulos

Confirmar una transferencia llama a `PaymentsService`, que emite el dorsal y toma
el cupo en la transacción de siempre. Recalcular puestos llama a `RacesService`.
Previsualizar el fee usa `calcularServiceFee()`, la misma función que cobra.

Es la regla que evita el fallo clásico de los paneles: una segunda forma de
acreditar un pago, con la mitad de las comprobaciones, que acaba dando dos
dorsales iguales.

### Los resultados se cargan por dorsal, y un dorsal malo no tumba la carga

El cronometraje entrega dorsales y tiempos; no sabe nada de nuestros ids. Un
dorsal que no existe vuelve en `unknownBibs` en vez de abortar: una lista de
3.000 líneas con dos erratas tiene que poder subirse igual, y quien la sube no
puede quedarse sin resultados por eso.

Los puestos se recalculan **una vez al final**, no por fila: importar 3.000
resultados no puede ser 3.000 reordenaciones de la clasificación entera.

### El CSV se escapa contra fórmulas, no solo contra comas

Una celda que empieza por `=` la ejecuta Excel al abrir el archivo. El vector es
un campo que rellena el usuario al inscribirse: basta con llamarse
`=HYPERLINK(...)` para que el organizador que abre el listado ejecute lo que le
pongan. Se antepone una comilla simple y la hoja lo trata como texto.

El BOM UTF-8 son tres bytes que deciden si "Cochabamba" sale con la tilde o rota,
y con ella si el organizador puede usar el archivo.

### Los usuarios se consultan sin nada sensible

Ni hash de contraseña, ni tokens, ni ubicaciones: el `select` los deja fuera de
la consulta, no del serializador. Lo que no se consulta no puede filtrarse por un
descuido al añadir un campo.

---

## Fase 16 — Transversales

### El enlace profundo es una página, no un `302`

**Decisión:** `/links/*` devuelve HTML con metadatos Open Graph y salta a la app
desde JavaScript. Nunca redirige desde el servidor.

**Razón:** el enlace lo abren dos clientes distintos y sólo uno es una persona.
WhatsApp, Telegram y Facebook rascan la URL para armar la previsualización del
mensaje y **no ejecutan JavaScript**; un `302` los dejaría sin `<head>` que leer
y el mensaje saldría con una URL pelada. Con la página, el bot se lleva los
metadatos y el teléfono se lleva el salto. Es la misma razón por la que tampoco
se usa `<meta http-equiv="refresh">`.

El salto se intenta **una sola vez** y sólo si la navegación es `navigate`: al
volver atrás desde la app el navegador restaura la página desde su caché, y
reintentar ahí encierra al usuario en un bucle de recargas.

### La página lleva su propia CSP con nonce

**Decisión:** cada respuesta de `/links/*` pisa la CSP de helmet con
`default-src 'none'` y un nonce nuevo para su `<style>` y su `<script>`.

**Razón:** helmet pone `script-src 'self'`, que bloquea los dos bloques inline y
deja una página sin estilo que además no salta. Las alternativas eran peor:
`'unsafe-inline'` abre la puerta a cualquier inyección, y sacar el CSS y el JS a
archivos servidos son dos peticiones más para una página de tres líneas. El
nonce es por respuesta; reutilizarlo lo convertiría en una lista blanca
permanente.

### Del entrenamiento y del resultado compartidos sale lo mínimo

**Decisión:** el enlace de una maratón publica todo; el de un entrenamiento y el
de un resultado publican distancia, tiempo y nombre de la carrera — nunca el
nombre del corredor, su recorrido ni sus coordenadas.

**Razón:** el id es la única llave, así que quien tiene el enlace es porque su
dueño se lo dio. Pero la previsualización la renderiza el chat para **todo el
grupo**, no sólo para el destinatario, y una ruta dibujada en la tarjeta es el
mapa de dónde vive alguien. La imagen del resultado sólo aparece si el corredor
generó la tarjeta a mano (`POST /races/:id/share-card`): es un acto deliberado
suyo, no un efecto de haber corrido.

Los ids son cuids: no se enumeran. Es el modelo de "URL secreta", igual que un
documento compartido por enlace, y está asumido.

### El aviso de zapatilla sale al cruzar el umbral, no cada vez

**Decisión:** `sumarDistancia` devuelve `justCrossedWearAlert`, y es eso —y no
`wearAlert`— lo que dispara la notificación.

**Razón:** `wearAlert` es un estado, no un evento: pasado el umbral es `true`
para siempre. Notificar sobre el estado sería un push en cada salida hasta que el
usuario retire las zapatillas, y eso no enseña a cambiar de zapatillas: enseña a
apagar los push. La detección vive en `ShoesService` y no en cada consumidor
porque hay dos caminos que consolidan un entrenamiento (cerrar una sesión y
sincronizar offline) y el usuario no distingue por cuál entró.

### `NotificationsService` resuelve el destinatario; el driver, el transporte

**Decisión:** dos piezas. `NotificationsService` mira las preferencias y junta
los `pushToken` de los dispositivos; `PushSender` sólo entrega.

**Razón:** "si el usuario apagó los push, no se le manda nada" no es una regla
del transporte, y dejarla dentro del driver obligaría a reescribirla al cambiar
de consola a FCM. El servicio **nunca lanza**: una notificación es un efecto
secundario agradable, y que falle no puede tumbar el cierre de un entrenamiento
que ya se guardó.

**Para enchufar FCM** hace falta: cuenta de servicio de Firebase (`google-services.json`
y `GoogleService-Info.plist` en el cliente, credenciales del admin SDK en el
servidor), `firebase-admin` como dependencia, una clase `FcmPushSender` con el
mismo `send`, cambiar el provider en `NotificationsModule`, y manejar el
`UNREGISTERED` que devuelve FCM para borrar el `pushToken` muerto del `Device`.
Nada de eso toca a quien emite el evento.

### El borrado de cuenta confía en la cascada de Postgres

**Decisión:** `DELETE /users/me/data` cancela las inscripciones vigentes, hace un
`user.delete()` y borra los archivos. No barre tabla por tabla.

**Razón:** cada relación ya declara su `onDelete: Cascade`. Un barrido a mano
sería una segunda lista que mantener, y la que se olvidaría el día que alguien
agregue una tabla: los datos quedarían huérfanos y nadie se enteraría. Lo que la
base **no** sabe hacer son las dos cosas que sí van a mano: soltar el
`slotsTaken` de la maratón (borrar la inscripción no decrementa el contador, y la
plaza quedaría ocupada por alguien que ya no existe) y borrar los binarios del
disco.

Los archivos se borran **después** del `DELETE`: si el borrado fallara, un
usuario que sigue existiendo se habría quedado sin avatar y sin comprobantes. Al
revés, lo peor que pasa es un archivo huérfano.

Una cancelación que falle **no impide** el borrado: el derecho a borrar la cuenta
no depende de que un cupo se contabilice bien. Queda en el log para que el
organizador pueda cuadrarlo.

### `MIN_APP_VERSION` es entorno, no constante

**Decisión:** la versión mínima soportada sale de una variable de entorno y se
publica en `/config/app`.

**Razón:** obligar a actualizar es una decisión de producto que se toma un
martes cualquiera —normalmente porque una versión vieja hace algo que ya no se
puede sostener—, y no debería requerir compilar y desplegar la API.

---

## Fase 17 — Seeds, docs y tests

### Checkpoint 17a — Cuentas, catálogo y plantillas

#### El seed se parte en módulos y **nunca** sobreescribe

**Decisión:** `prisma/seed.ts` orquesta y cada dominio vive en
`prisma/seed/*.ts`. Todo es idempotente por clave natural (email, slug), y una
fila que ya existe se deja **exactamente como está**.

**Razón:** un seed que pisa lo que encuentra es un seed que nadie se anima a
correr sobre la base con la que estaba trabajando — y entonces deja de correrse.
Si respeta lo existente, `npm run db:seed` es seguro en cualquier momento y sirve
además para incorporar datos nuevos a una base vieja, que es lo que pasa cada vez
que se agrega una maratón al catálogo de ejemplo.

#### Los estados del catálogo se provocan, no se escriben

**Decisión:** ninguna maratón del seed tiene su estado puesto a dedo. Una está a
tres días (`closing_soon` por fecha), otra con el 4% de cupo libre
(`closing_soon` por cupo), otra con el cupo lleno (`full`) y otra con el plazo
vencido (`closed`).

**Razón:** un seed que escribe `registrationStatus: 'full'` a mano prueba que la
columna acepta el valor, no que `resolverEstado` funcione. Provocando la
condición, el catálogo de la app enseña los cuatro estados **y** si la regla se
rompe se nota al abrir la pantalla, sin escribir un test para eso.

#### Las plantillas de plan se generan, no se teclean

**Decisión:** cada plantilla declara su patrón semanal (3, 4 o 5 sesiones con su
tipo y su parte del volumen) y una curva de carga; las 378 filas de
`training_plan_template_sessions` salen de ahí.

**Razón:** 378 sesiones escritas a mano son 378 oportunidades de equivocarse, y
ninguna se revisa en un diff. Generarlas hace que las reglas de entrenamiento
sean **código legible y probable**: la rampa de carga, la semana de descarga cada
cuatro y el afinamiento de las dos últimas se leen en diez líneas, y
`planes.spec.ts` verifica que ninguna semana repita día — que es lo que reventaría
el `@@unique([templateId, week, weekday])` con el seed a medio correr.

#### La curva de carga se normaliza para no mentirle al catálogo

**Decisión:** los factores semanales se dividen por su propia media, de forma que
el volumen medio real del plan sea el `avgWeeklyDistanceMeters` que anuncia la
plantilla. Y lo que la tirada larga no puede absorber por su techo **se reparte
entre las demás sesiones** en vez de perderse.

**Razón:** sin las dos cosas, una plantilla que promete 38 km por semana entregaba
30. El corredor elige la plantilla **por ese número**: si el plan da un 20% menos,
el catálogo miente. Los dos ajustes están cubiertos por tests con margen del 5%,
que es lo único que mueven los redondeos a 500 m.

#### El techo de la tirada larga depende de la distancia objetivo

**Decisión:** maratón, 30K. Media maratón, la distancia de carrera. 5K y 10K, un
20% por encima del objetivo con suelo de 10 km.

**Razón:** a la maratón se llega con 30K y el resto lo pone el día de la carrera;
un plan que te hace correr 42K entrenando produce lesionados, no maratonistas. En
5K, en cambio, el límite no lo pone la carrera sino el corredor: una larga de 6 km
en un plan de 5K no entrena nada.

#### El recorrido del seed es sintético y no finge no serlo

**Decisión:** `routeGeoJson` es un circuito cerrado generado alrededor del punto
de largada, con la longitud que corresponde a la distancia de la carrera.

**Razón:** no hace falta la traza real de ninguna carrera —copiar recorridos
ajenos al repo no aporta nada— pero sí que la **forma** del dato sea real: un
`LineString` con suficientes puntos para que el mapa dibuje algo y para que
`simplificar()` tenga algo que simplificar.

#### El cargo por servicio se siembra apagado, contra lo que pedía el PROMT

**Decisión:** la config global nace con `enabled = false`.

**Razón:** el PROMT (§11) pedía sembrarla activa para poder probar el apagado,
pero en la Fase 0 se decidió lo contrario y esa decisión es posterior y más
específica. Los valores quedan precargados (10%, mínimo Bs 5), así que encenderlo
para probar el otro camino es un click en el panel o un `UPDATE` de una fila.

### Checkpoint 17b — La actividad del corredor

#### Las métricas del seed las calcula la API, no el seed

**Decisión:** los entrenamientos sembrados se crean generando **posiciones GPS**
y pasándolas por `consolidar()` y `calorias()`, las mismas funciones que usa el
cierre de una sesión real. Los checkpoints de la carrera salen de `marcadores()`.

**Razón:** si el seed escribiera sus propias distancias y ritmos, la app mostraría
números que el backend nunca habría producido — y el día que la consolidación
cambie, los datos de ejemplo dejarían de tener sentido sin que nadie se entere.
Además, así el seed es una prueba de humo de la consolidación: si `consolidar()`
se rompe, `db:seed` produce basura visible.

#### El recorrido es determinista

**Decisión:** el generador usa un PRNG con semilla (mulberry32), nunca
`Math.random`.

**Razón:** dos `db:reset` dan exactamente los mismos entrenamientos. Eso permite
comparar una captura de pantalla de ayer con la de hoy y reproducir un bug de la
app sin que el dato de abajo se haya movido.

#### Deformar un círculo lo alarga un 7%

**Decisión:** el radio del circuito se calcula integrando el perímetro real de la
curva deformada, no como el de un círculo de la distancia pedida.

**Razón:** es el bug que este checkpoint encontró mirando los números. Con
`r(θ) = R(1 + 0,18·sin3θ)`, un "10K" medía 10.700 m — y con él salían torcidos a
la vez el historial, las estadísticas semanales, la predicción de llegada y los
kilómetros de la zapatilla, sin que nada lo delatara. `track.spec.ts` lo fija con
un margen del 3%.

El recorrido de la carrera sí se genera un 1% largo, y eso **es** correcto: el
GPS de un teléfono siempre mide de más en competición, y sin ese margen el
recorrido no cruza la marca del último kilómetro y se pierde un checkpoint.

#### Un punto cada 10 s, no cada segundo

**Decisión:** el muestreo del seed es de 10 s; la app real manda 1 Hz.

**Razón:** a 1 Hz, cuarenta entrenamientos son 130.000 filas y un `db:reset` de
varios minutos. A 10 s hay un punto cada ~30 m, de sobra para que splits,
desnivel y marcadores salgan bien. Es un `ponytail:` explícito con su constante
arriba por si alguien quiere el detalle fino.

#### Uno de cada cien puntos llega con mala precisión

**Decisión:** el generador emite ~1% de puntos con `accuracy` por encima del
límite de 30 m.

**Razón:** un seed que solo produce puntos perfectos nunca ejerce el camino del
descarte, que es justo el que rompe las métricas cuando falla. Con el ruido
dentro, `discardedPoints` es distinto de cero desde el primer día.

#### El puesto de la carrera corrida se escribe

**Decisión:** `overallRank` y `categoryRank` del resultado sembrado son valores
fijos (37.º general, 8.º de categoría) en vez de salir de `recalcularPuestos`.

**Razón:** esa función ordena a los corredores **que existen en la base**, y aquí
hay uno: saldría primero de 873. Sembrar 872 corredores falsos es mucho trabajo
para un número que la app solo muestra. Estos son los que habría devuelto el
cronometraje.

#### La semana del corredor tiene forma, y un hueco

**Decisión:** tres salidas fijas (martes de series, viernes suave, domingo
larga), con una progresión del 6% a lo largo de los cuatro meses y **dos semanas
sin correr** por la lesión que el perfil ya declara.

**Razón:** días sueltos al azar dan un historial que ningún corredor tendría y
dejan la pantalla de estadísticas semanales sin forma reconocible. La progresión
existe para que Riegel tenga algo que predecir — sin deriva, "el mejor esfuerzo
reciente" da siempre lo mismo. Y un historial de cuatro meses sin un solo hueco
tampoco es el de nadie.

Los tres días coinciden con tres de los cuatro del plan de 21K, así que las
sesiones cumplidas cuelgan de un entrenamiento real. La del miércoles queda
completada **sin** workout: eso también pasa, y la app tiene que saber pintarlo.

#### La zapatilla principal queda cerca del umbral, no pasada

**Decisión:** 742 km sobre un umbral de 800.

**Razón:** así la barra de desgaste se ve en amarillo y **una salida larga más
dispara el aviso por el camino real** (`justCrossedWearAlert`), en vez de por un
dato puesto a mano. Sembrarla ya pasada haría que el evento no se pudiera
observar nunca.

#### El QR pendiente es un PNG de verdad

**Decisión:** el seed genera el código QR con `qrcode` y lo escribe en
`UPLOADS_DIR` con la misma clave que usaría el proveedor mock.

**Razón:** ocho líneas, y son la diferencia entre poder mirar la pantalla de pago
por QR y encontrarse una imagen rota. El vencimiento se cuenta desde **ahora** y
no desde la fecha de inscripción, por lo mismo: uno vencido hace tres días deja
esa pantalla inservible.

### Checkpoint 17c — Documentación

#### Retención de datos de ubicación

Las posiciones GPS son el dato más sensible que guarda este backend: el recorrido
de alguien dice dónde vive, a qué hora sale de casa y qué días no está. La
política, en cuatro reglas:

**1. Nadie ve las posiciones de otro.** No hay un solo endpoint que devuelva
posiciones por `userId`. El recorrido de un entrenamiento solo lo lee su dueño, y
el seguimiento en vivo es opt-in y publica un payload mínimo (`bib`, `lat`,
`lng`, `t`) sin identidad. Los tests e2e lo intentan explícitamente y esperan
`403/404`.

**2. Lo que el usuario borra, se borra.** Descartar una sesión de tracking borra
sus puntos de verdad, no los marca. Borrar la cuenta se los lleva todos en
cascada. La única excepción deliberada es borrar un **entrenamiento**: ahí el
soft delete conserva los puntos, porque "borré la salida del martes sin querer"
es un caso real y recuperable, y sin los puntos no hay nada que recuperar.

**3. La traza cruda caduca a los 18 meses; lo derivado, no.** Lo que da valor
a largo plazo —distancia, ritmo, splits, desnivel, el resultado de una carrera y
sus marcadores— ya está consolidado en tablas propias y se conserva
indefinidamente: es el historial del corredor. La secuencia de coordenadas, en
cambio, deja de aportar y pasa a ser solo riesgo. A los 18 meses se descarta el
mes entero:

```sql
DROP TABLE positions_2025_03;
```

Instantáneo y sin bloquear nada, que es **exactamente para lo que se particionó
la tabla por mes** (ver la decisión de la Fase 2). Un `DELETE` sobre millones de
filas habría hecho impracticable esta política, y una política impracticable no
se cumple.

Los puntos de un entrenamiento borrado con soft delete caen bajo la misma
ventana: no se distinguen.

**4. Fuera de la base no salen.** Los logs redactan ubicaciones igual que
contraseñas y tokens; los backups heredan la retención de la base porque rotan a
7 días.

**Lo que falta:** el `DROP TABLE` es hoy una operación manual documentada, no un
job. Automatizarlo va con el resto del mantenimiento programado; mientras tanto,
la línea de arriba es el procedimiento completo y el `create_positions_partition`
del arranque ya garantiza que siempre exista la partición del mes en curso.

---

## Fase 18 — Despliegue

### Un solo directorio de trabajo, no releases numeradas

El patrón habitual —`releases/<timestamp>` y un symlink `current`— compra dos
cosas: rollback instantáneo y despliegue atómico. Aquí no compra ninguna de las
dos. El rollback real de esta API incluye la base de datos, y las migraciones no
se deshacen solas: volver al symlink anterior con el esquema ya migrado deja el
código viejo hablando con tablas que no reconoce. Y el despliegue no es atómico
de todos modos, porque el proceso se reinicia.

Así que un solo checkout en `/srv/running-api/current`, y volver atrás es
`git checkout` del commit anterior más otra pasada de `release.sh`. Menos
piezas, mismo resultado. Si algún día hay varias instancias detrás de un
balanceador, esto se reconsidera.

### `release.sh` no toca git

Qué versión se publica es una decisión humana. Un script que empieza con
`git pull` publica siempre lo último que alguien empujó, que no es lo mismo que
lo que se quería publicar. El script asume que el directorio ya está en el commit
correcto y se ocupa del resto: `npm ci`, cliente de Prisma, build, `migrate
deploy`, restart y verificación contra `/health` y `/ready`.

Las migraciones van **antes** del restart, para que el proceso nuevo encuentre su
esquema. El precio es explícito: durante esos segundos el código viejo corre
contra el esquema nuevo, así que toda migración tiene que ser compatible hacia
atrás. Agregar una columna, sí; renombrarla, en dos despliegues.

### `sudo` acotado a dos comandos

`release.sh` corre como `paceup` y necesita reiniciar el servicio. En vez de
correr todo el despliegue como root, hay una línea en `/etc/sudoers.d/` que
autoriza exactamente `systemctl restart running-api` y `journalctl -u
running-api`. Si el script se corrompe, lo peor que puede hacer es reiniciar su
propio servicio.

### El healthcheck externo apunta a `/health`, no a `/ready`

Son cosas distintas y confundirlas causa el fallo que pretende evitar.
`/health` dice que el proceso responde y no toca dependencias. `/ready` además
comprueba Postgres y Redis.

Si el reinicio automático se colgara de `/ready`, una caída de Redis reiniciaría
en bucle una API que sigue perfectamente capaz de servir el catálogo — y el
reinicio no arregla Redis. `/ready` sirve para decidir si mandar tráfico, no para
decidir si matar el proceso.

### `trust proxy` en loopback: el rate limit por IP estaba muerto detrás de Caddy

Encontrado al escribir la configuración del proxy. El throttler global cuenta por
`req.ip`, y detrás de Caddy el peer TCP es siempre `127.0.0.1`: sin
`trust proxy`, **todos los usuarios comparten un único cubo de 120 peticiones por
minuto**. Con cincuenta personas usando la app, la API empieza a devolver 429 a
gente que no hizo nada raro, y el log no señala a ninguna IP concreta porque
todas son la misma.

Se confía **solo** en loopback, no en `true`. La diferencia importa: con `true`,
cualquiera desde internet podría mandar `X-Forwarded-For: 1.2.3.4` y saltarse el
límite cambiando la cabecera en cada petición. Confiando solo en loopback, la
cabecera únicamente se respeta cuando la conexión llega del propio Caddy.

### Caddy sirve `/uploads` desde disco

Pasar un avatar por el event loop de Node para leer un archivo del disco es
trabajo tirado. Caddy lo sirve directo, con la misma ruta pública que expone la
API, así que las URLs ya guardadas en la base no cambian. Node conserva su
servidor estático porque en desarrollo no hay proxy delante.

### El backup escribe a un temporal

`pg_dump | gzip > archivo.sql.gz` con el disco lleno deja un `.sql.gz` truncado
con el nombre del día y código de salida 0. Al día siguiente lo rota otro, y el
día del incendio te enteras. El script escribe a `.parcial`, comprueba que el
resultado tenga un tamaño creíble y solo entonces lo renombra: si algo falla, el
backup de ayer sigue siendo el más reciente y eso es visible.

Lo que **no** hace es verificar restaurando. Está anotado como `ponytail:` en el
script y el procedimiento manual está en `docs/despliegue.md`; automatizarlo pide
una base desechable y un cron semanal.

### Sin Docker, por decisión del PROMT

Instalación nativa de Postgres, Redis, Node y Caddy. Para un VPS único con una
sola app es menos capas que depurar a las tres de la mañana. El coste es que las
versiones dependen de los repos del sistema, así que quedan fijadas y anotadas en
la guía: Node 22 LTS, PostgreSQL 17, Redis 7, Caddy 2.

---

## Pendientes de documentar en fases posteriores

- **Live tracking masivo** — la base está en la Fase 14; lo que falta
  (autorización fina, opt-in de privacidad, clustering, publicación en cola) está
  detallado con su estimación de carga en `docs/tracking.md`.
- **Purga automática de posiciones** — la política de retención está arriba
  (Checkpoint 17c) y el `DROP TABLE` de la partición vencida es una línea, pero
  hoy se ejecuta a mano. Va con el resto del mantenimiento programado.
- **Notificaciones push reales** — el driver es `console`. Lo que falta para FCM
  está listado arriba, en la Fase 16.
- **CRUD del catálogo en el panel** — crear y editar maratones, categorías,
  extras y plantillas de plan. Es lo que AdminJS regalaba y lo que su descarte
  deja pendiente; da para una fase propia.
- ~~**`drift` vs `hive_ce`**~~ — resuelto en la Fase 20, ver abajo.

---

## Fase 20 — `drift` para la base local de la app

**Decisión: `drift`.** `hive_ce` se queda sólo para `HiveTrainingRepository`
—datos falsos— hasta que la Fase 22 lo sustituya.

Lo que decidió no fue el rendimiento sino la **outbox**. Drenar una cola pide
justo lo que un almacén clave-valor no tiene: «lo pendiente cuyo
`next_attempt_at` ya pasó, ordenado por id, máximo 50». En Hive eso es recorrer
todas las claves y filtrar en Dart, o mantener a mano un índice que SQLite ya
sabe llevar. El backoff y el contador de intentos viven **en la fila**, no en
memoria, para sobrevivir a que el usuario mate la app entre reintentos.

Tres tablas: `outbox_entries` (escrituras sin red), `pending_workouts`
(entrenamientos a la espera de `/workouts/sync`) y `cached_docs` (respuestas de
GET por clave). Los entrenamientos no van por la outbox porque el sync es por
lotes y resuelve cada item por separado: una fila de outbox por petición no
sabría qué hacer con un `rejected` en el sexto de cincuenta.

La `Idempotency-Key` se persiste con la fila. Es lo que impide que la conexión
cortada entre el envío del checkout y su respuesta se convierta en un segundo
cobro.

**No se instaló `connectivity_plus`.** El drenado se dispara al arrancar y al
volver la app al frente; si el primer intento falla, el backoff se encarga.
Escuchar la conectividad sería una dependencia más para adivinar lo que el
propio reintento averigua. Si algún día hace falta drenar en el instante en que
vuelve la red, es añadir el paquete y llamar al mismo `drain()`.


---

## Fase 21 — geolocalización en segundo plano: `geolocator`, sin paquete nuevo

Lo comprobado en pub.dev antes de decidir (agosto 2026):

| Paquete | Versión | Licencia | Estado |
| --- | --- | --- | --- |
| `geolocator` | 14.0.3 | MIT | Ya instalado. `ForegroundNotificationConfig` en Android, `UIBackgroundModes` + `AppleSettings` en iOS |
| `flutter_foreground_task` | 11.0.1 | MIT | Servicio en primer plano genérico; **no da ubicación**, hay que combinarlo con otro paquete |
| `background_locator_2` | 2.0.6 | MIT | Sin publicar desde hace ~3 años, subido por un usuario no verificado |
| `flutter_background_geolocation` | 5.5.0 | Apache-2.0 el envoltorio, pero **licencia de pago para builds de release en Android** | Es el más capaz: detección de movimiento, geofencing, batería |

**Decisión: `geolocator`, que ya estaba.** Cubre el caso —seguir grabando con la
app fuera de pantalla— con un servicio en primer plano en Android y
`UIBackgroundModes: location` en iOS, sin añadir dependencia ni licencia
comercial. Añadir un paquete que hay que pagar para publicar en Android es una
decisión de negocio, no técnica, y no se toma sola.

**Lo que se pierde:** la inteligencia de movimiento de Transistorsoft (parar el
GPS cuando el usuario está quieto, arrancarlo cuando vuelve a moverse). Se
traduce en más batería en carreras largas y en algún hueco si Android decide
matar el proceso pese al servicio en primer plano. **Cuándo cambiar:** si las
pruebas en dispositivos reales muestran cortes en carreras de más de dos horas,
la migración es reimplementar `LocationService` —una interfaz de tres métodos—
y comprar la licencia. Nada más del cliente lo toca.

Permisos: `whileInUse` alcanza para grabar con el servicio en primer plano;
`always` se pide **después**, y solo cuando ya hay una grabación que lo
justifique. Si se deniega, la grabación sigue funcionando y se avisa
(`backgroundDenied`), no se bloquea el entrenamiento.
