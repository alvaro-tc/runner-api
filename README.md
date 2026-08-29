# PaceUp API

Backend de [PaceUp](../running-app): maratones, inscripciones, planes de
entrenamiento y tracking GPS.

NestJS · TypeScript estricto · Prisma · PostgreSQL · Redis

> **Estado:** Fase 18. La API está completa de punta a punta —auth con sesión de
> 60 días, perfil, catálogo, precios, inscripciones, pagos mock, planes de
> entrenamiento, entrenamientos con consolidación en el servidor, tracking GPS,
> carreras, home con predicción de Riegel, tiempo real, panel de administración y
> transversales— con seeds completos, la suite en verde y el despliegue en el VPS
> documentado y listo para ejecutar. Queda la integración del lado Flutter
> (19–22). El plan completo está en
> [`../running-app/PROMT.md`](../running-app/PROMT.md).

---

## Requisitos

- **Node.js 20+** (probado en 22 LTS)
- **PostgreSQL 16+** (probado en 18.4) y **Redis 7**, accesibles desde tu máquina

No se usa Docker en ningún entorno: instala Postgres y Redis nativamente (paquete
del sistema o servicio gestionado). El despliegue en VPS con systemd + Caddy llega
en la Fase 18.

## Puesta en marcha

```bash
npm install
cp .env.example .env      # ajusta DATABASE_URL y REDIS_URL a tu entorno
npm run db:migrate        # crea el esquema
npm run db:generate       # genera el cliente de Prisma
npm run db:seed           # 3 cuentas, catálogo completo y un corredor con historial
npm run dev
```

### Bases de datos que necesitas

```sql
CREATE ROLE paceup LOGIN PASSWORD 'paceup';
CREATE DATABASE paceup        OWNER paceup;  -- desarrollo
CREATE DATABASE paceup_shadow OWNER paceup;  -- solo prisma migrate dev
CREATE DATABASE paceup_test   OWNER paceup;  -- tests e2e
```

`paceup_shadow` la usa `prisma migrate dev` para detectar drift; se puede borrar
y recrear sin perder nada. Antes de correr los tests e2e por primera vez, aplica
las migraciones a la base de tests:

```bash
DATABASE_URL="postgresql://paceup:paceup@localhost:5432/paceup_test?schema=public" \
  npx prisma migrate deploy
```

La API queda en `http://localhost:3000/api/v1` y la documentación interactiva en
`http://localhost:3000/api/docs`.

Si falta una variable de entorno o tiene un valor imposible, **el proceso muere
al arrancar** diciendo exactamente cuál. Es a propósito: nunca se levanta a
medias.

## Verificación rápida

```bash
curl -s http://localhost:3000/health      # 200: el proceso responde
curl -s http://localhost:3000/ready       # 200 si Postgres y Redis responden, 503 si no
curl -s http://localhost:3000/api/v1/config/app     # constantes del entorno, sin token
curl -s "http://localhost:3000/api/v1/marathons?limit=3"   # catálogo público
```

Con los seeds cargados, el catálogo devuelve maratones en los cuatro estados de
inscripción (`open`, `closing_soon`, `full`, `closed`) sin que nadie haya tocado
una columna: salen de las fechas y los cupos sembrados.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga en caliente |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta lo compilado |
| `npm test` | Tests unitarios |
| `npm run test:e2e` | Tests end-to-end |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run db:migrate` | Crea y aplica una migración (desarrollo) |
| `npm run db:deploy` | Aplica migraciones pendientes (producción) |
| `npm run db:generate` | Regenera el cliente de Prisma |
| `npm run db:seed` | Siembra cuentas, catálogo, planes y la actividad del corredor (idempotente) |
| `npm run db:reset` | **Borra y recrea la base.** Pide confirmación |
| `npm run db:studio` | Explorador visual de la base |

## Convenciones de la API

**Prefijo:** `/api/v1`. `/health` y `/ready` quedan fuera a propósito: los
consume la infraestructura, no el cliente, y no deben romperse con `/api/v2`.
`/uploads` también queda fuera: son binarios públicos (avatares, tarjetas de
resultado, comprobantes), y la URL de una imagen ya guardada no debería cambiar
porque salga una `/api/v2`. `/admin` es una página, no un endpoint: su API sí
vive dentro, en `/api/v1/admin/*`.

**Unidades base** — el formateo es siempre del cliente:

| Magnitud | Unidad en la API |
|---|---|
| Distancia | metros (entero) |
| Duración | segundos (entero) |
| Ritmo | segundos por kilómetro |
| Dinero | centavos (entero) + `currency: "BOB"` |
| Fechas | ISO-8601 UTC |

**Sobre de respuesta.** Éxito:

```json
{ "data": { }, "meta": { "requestId": "…", "timestamp": "2026-08-18T14:03:22.118Z" } }
```

Error:

```json
{ "error": { "code": "MARATHON_FULL", "message": "…", "details": [] },
  "meta": { "requestId": "…" } }
```

Dos reglas para el cliente:

1. **Mapea por `error.code`, nunca por `error.message`.** El catálogo vive en
   `src/common/errors/error-codes.ts`.
2. **`meta.timestamp` es la hora del servidor.** Calcula las cuentas regresivas
   contra ese valor, no contra el reloj del teléfono.

**Trazabilidad.** Cada respuesta lleva `meta.requestId`, también en la cabecera
`x-request-id` y en cada línea de log. Si un usuario reporta un error y te pasa
ese id, encuentras su traza completa.


## Autenticación

La sesión dura **60 días y se renueva sola**: el access token vive 15 minutos y
el refresh rota en cada uso, recalculando su caducidad. Mientras el usuario abra
la app cada tanto, no vuelve a loguearse.

Un detalle que importa al escribir el cliente: **el refresh rota siempre**, así
que ante varios `401` simultáneos hay que disparar **un solo** refresh con un
mutex. Diez refresh concurrentes hacen que nueve lleguen con un token ya rotado,
y el servidor lo interpreta —correctamente— como robo y cierra la sesión. Está
explicado en [`docs/api.md`](docs/api.md).

Credenciales de prueba, tras `npm run db:seed`:

| Cuenta | Rol | Qué tiene |
|---|---|---|
| `runner@test.com` | runner | Cuatro meses de actividad: entrenamientos con GPS, plan de 21K a medias, 4 inscripciones, 3 zapatillas |
| `runner2@test.com` | runner | Vacía a propósito: es con la que se comprueba que no ve los datos del otro |
| `admin@test.com` | admin | Acceso a `/admin` y a `/api/v1/admin/*` |
| `organizer@test.com` | organizer | Admin recortado: usuarios corredores y comprobantes QR. También `organizer2@` y `organizer3@` |

Contraseña para todas: `Test1234!`

## Conectar la app Flutter al backend local

| Dónde corre la app | URL base |
|---|---|
| Emulador Android | `http://10.0.2.2:3000/api/v1` |
| Simulador iOS | `http://localhost:3000/api/v1` |
| Dispositivo físico | `http://<IP-de-tu-PC>:3000/api/v1` |

El emulador de Android no ve `localhost` como tu máquina: `10.0.2.2` es el alias
del host. Para un dispositivo físico, además, la API ya escucha en `0.0.0.0` y
solo hace falta que el firewall deje pasar el puerto.

## Estructura

```
src/
├── main.ts                  Arranque: prefijo, helmet, CORS, pipes, Swagger
├── app.module.ts            Módulo raíz + filtro e interceptor globales
├── swagger.ts               Documentación OpenAPI
├── config/
│   ├── env.schema.ts        Esquema zod del entorno (fuente única)
│   ├── app-config.service.ts  Acceso tipado; nadie más toca process.env
│   ├── config.module.ts
│   └── logger.config.ts     pino: requestId y redacción de secretos
├── common/
│   ├── errors/              Catálogo ErrorCode + AppException
│   ├── filters/             Sobre de error
│   ├── interceptors/        Sobre de éxito
│   └── dto/                 Tipos del sobre + modelos de Swagger
├── database/                PrismaService (única puerta a la base)
├── modules/
│   ├── auth/                Registro, login, rotación de tokens, guards
│   │   ├── guards/          JwtAuthGuard (global) + RolesGuard
│   │   ├── decorators/      @Public, @Roles, @CurrentUser
│   │   └── social/          Login social: no implementado, documentado
│   ├── users/               Perfil, preferencias, avatar, zapatillas, salud
│   ├── marathons/           Catálogo público, categorías, extras
│   ├── pricing/             QuoteService: la única fuente del total
│   ├── registrations/       Inscripción en 3 pasos, cupos, dorsal
│   ├── payments/            PaymentProvider + driver mock, comprobantes, webhook
│   ├── training-plans/      Plantillas, sugerencias, instanciación
│   ├── workouts/            Sesiones, consolidación de métricas, historial
│   ├── tracking/            Ingesta por lotes, OsmAnd, simulación
│   ├── races/               Resultados, checkpoints, ranking, tarjeta
│   ├── home/                /home/summary y PredictionService (Riegel)
│   ├── realtime/            Socket.IO con adapter de Redis
│   ├── admin/               Panel y endpoints de administración
│   ├── links/               Enlaces profundos con Open Graph
│   ├── app-info/            GET /config/app
│   ├── notifications/       NotificationsService + driver console
│   ├── storage/             StorageService (driver local, cambiable a S3)
│   └── mail/                MailService + driver console
└── health/                  /health y /ready

prisma/
├── schema.prisma            Modelo de datos completo
├── seed.ts                  Orquesta el seed
├── seed/                    Un módulo por dominio, todo idempotente
├── migrations/              Historial de migraciones
└── sql/
    └── positions-partitioning.sql   Copia legible del bloque de particionado

deploy/
├── running-api.service      Unidad systemd (usuario dedicado, endurecida)
├── Caddyfile                Proxy inverso con TLS automático
└── release.sh               Instala, compila, migra, reinicia y verifica

scripts/
└── backup-db.sh             pg_dump comprimido con rotación de 7 días

generated/prisma/            Cliente generado. NO se versiona: npm run db:generate
```

### Sobre `positions`

Es una **tabla particionada por mes** sobre `recordedAt`, y es la única del
esquema con tratamiento especial. Prisma no sabe expresar particionado, así que
ese bloque se escribió a mano dentro de la migración inicial. Antes de tocar esa
tabla, lee la sección correspondiente en [`docs/decisiones.md`](docs/decisiones.md):
hay dos consecuencias que no son obvias (la PK es compuesta y el dedupe incluye
`recordedAt`).

## Documentación

- [`docs/api.md`](docs/api.md) — contrato de la API: unidades, sobre de
  respuesta, catálogo de códigos de error, y cada módulo con sus reglas
- [`docs/tracking.md`](docs/tracking.md) — ingesta de posiciones, protocolo
  OsmAnd, simulación de GPS y seguimiento en vivo
- [`docs/flutter-integracion.md`](docs/flutter-integracion.md) — cómo conecta la
  app: Dio, el mutex del refresh, offline-first, tracking y deep links
- [`docs/despliegue.md`](docs/despliegue.md) — puesta en marcha en el VPS paso a
  paso, backups, dimensionamiento y checklist de seguridad
- [`docs/decisiones.md`](docs/decisiones.md) — cada decisión técnica con su
  porqué, fase por fase. Incluye la política de retención de ubicaciones

## Control de versiones

Los commits los hace el humano. Este proyecto se desarrolla por fases y cada
fase termina en una pausa para commit.
