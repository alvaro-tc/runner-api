# Cobro por QR con verificación manual

> **Esto es temporal.** Existe para poder cobrar hoy, sin pasarela. Está escrito
> para que el día que entre un PSP de verdad se borre en una tarde, y este
> documento dice exactamente qué borrar.

---

## 1. Qué problema resuelve

No hay pasarela de pagos contratada. El organizador cobra con el QR de su cuenta
bancaria, como cobra hoy cualquiera en Bolivia, y alguien mira los comprobantes.

La API no puede *saber* si un pago entró: no habla con el banco. Así que no lo
finge. Lo que hace es llevar la cuenta de tres hechos distintos, que la mayoría
de los sistemas caseros confunden en uno:

| Hecho | Dónde vive |
|---|---|
| El corredor **vio** el QR | `payments.status = pending`, `method = qr_manual` |
| El corredor **dice** que pagó | `payment_proofs.status = in_review` |
| Un organizador **verificó** que el dinero llegó | `payments.status = paid` |

Un comprobante subido **no confirma la inscripción**. No hay dorsal, no se
descuenta cupo y no se descuenta stock de adicionales hasta que una persona
aprueba. Confundir "ya lo mandé" con "ya lo cobraron" es exactamente cómo se
acaba con corredores inscritos que no pagaron.

## 2. El recorrido, de punta a punta

```
                                 ┌──────────────────────────────┐
  App móvil ──── checkout ──────▶│ payments                     │
  (qr_manual)                    │ status = pending             │
                                 │ methodDetails.manualQr = {   │
  Web pública ─ POST /public ───▶│   imageUrl, instructions,    │
  (crea o vincula la cuenta)     │   reference: "PU-A1B2C3"     │
                                 │ }                            │
                                 └───────────────┬──────────────┘
                                                 │
                        el corredor paga con su banca móvil
                        y sube la captura (app o web)
                                                 │
                                 ┌───────────────▼──────────────┐
                                 │ payment_proofs               │
                                 │ status = in_review           │
                                 │ payments.status SIGUE pending│
                                 └───────────────┬──────────────┘
                                                 │
                   un organizador cuadra la referencia contra el extracto
                                                 │
                    ┌────────────────────────────┴──────────────────┐
                    │ aprueba                                       │ rechaza
                    ▼                                               ▼
   PaymentsService.acreditarManualmente()            proof.status = rejected
   → payments.status = paid                          payments.status = pending
   → RegistrationsService.confirmarPago()            (el corredor sube otro)
     · reserva cupo (SELECT … FOR UPDATE)
     · descuenta stock
     · emite dorsal
```

Lo importante de ese dibujo: **la rama de aprobación no tiene código propio de
cobro**. Entra por `acreditarManualmente()`, que es la misma puerta que usa la
transferencia bancaria, que a su vez llama al mismo `confirmarPago()` que usa la
tarjeta. Un segundo camino para reservar cupo es como se acaba con dos corredores
con el mismo dorsal.

## 3. Los tres caminos del corredor

### a) Se registra en la app y paga desde la app

1. `POST /auth/register` con `name`, `password` y **`ci`** (el `email` es opcional).
2. Flujo normal de inscripción: `POST /registrations` → `PATCH …/category-extras`.
3. `POST /registrations/:id/checkout` con `method: "qr_manual"`.
   La respuesta trae `payment.methodDetails.manualQr` con `payload` (el QR como
   texto, que la app dibuja), `imageUrl` (respaldo, o `null`) y la glosa.
4. `POST /payments/:id/proof` (multipart, campo `file`, `reference` opcional).
5. La app relee `GET /payments/:id`, que ahora incluye `proof`. **No sondea**:
   al otro lado no hay un banco que responda en segundos, hay una persona que va
   a mirar una imagen cuando pueda.

### b) Se registró en la app y paga en la web

Igual que (c) desde el lado de la web. `POST /public/registrations` busca al
usuario **por CI**; si no lo encuentra por CI pero sí por email, le completa la CI
a esa cuenta. La inscripción queda colgada de la cuenta que ya tenía, así que la
ve en la app sin hacer nada.

Si el email que teclea en la web ya pertenece a otra cuenta **con otra CI**,
responde `EMAIL_ALREADY_REGISTERED` en vez de decidir por su cuenta cuál de las
dos personas es.

### c) Se inscribe solo desde la web

`POST /public/registrations` le crea la cuenta:

- usuario = su **CI normalizada** (`1234567 LP` → `1234567LP`)
- contraseña = **la misma CI**
- `mustChangePassword = true`

La contraseña inicial es pública a sabiendas: la sabe cualquiera que vea su
documento. Por eso `mustChangePassword` no es un aviso, es una puerta — la app
manda al usuario a `POST /auth/change-password` antes de dejarle usar nada, y
hasta entonces lo único que hay dentro de la cuenta es su propia inscripción.

La respuesta devuelve un **`publicToken`** de 256 bits, **una sola vez**. Es lo
que autoriza a la web a subir el comprobante y a consultar el estado sin sesión.
Reenviar el formulario emite uno nuevo e invalida el anterior.

## 4. Entrar con email **o** con CI

`POST /auth/login` recibe un solo campo, `identifier`. Si lleva `@` se trata como
email; si no, como CI. Se decide por el carácter y **no** preguntando a la base:
un endpoint que responde distinto según cuál acertó es un comprobador gratuito de
quién tiene cuenta.

La CI se guarda normalizada (mayúsculas, sin espacios ni guiones ni puntos), que
es lo único que hace útil al índice único de `users.ci`: si no, `1234567 LP` y
`1234567-lp` serían dos personas.

`users.email` pasó a ser **opcional**. La regla "email o CI, al menos uno" la
garantiza el código (`AuthService.register`, `PublicRegistrationService`), no un
CHECK en la base: el borrado en diferido vacía el email para liberarlo y un CHECK
bloquearía esa baja.

## 5. Configuración

Por maratón:

| Campo | Qué es |
|---|---|
| `paymentQrPayload` | El QR **como texto**: lo que devuelve la banca móvil al exportarlo, un deep link o un número de cuenta. **Sin esto la carrera no admite `qr_manual`** y el checkout responde `QR_NOT_CONFIGURED` |
| `paymentQrUrl` | Clave de storage (o URL absoluta) del QR como imagen. **Respaldo**: sólo se pinta si no hay texto |
| `paymentQrInstructions` | Texto libre que se pinta junto al QR, editable en `PUT /admin/marathons/:id` o el formulario del panel |

El QR viaja **como texto y lo dibuja el cliente**. No es una preferencia
estética: un string son unos bytes donde un PNG son cientos de KB, el código
sale nítido a cualquier tamaño, y se pinta aunque la conexión esté caída — que
es exactamente lo que pasa cuando alguien saca el teléfono para pagar. La app lo
tiñe con el violeta de marca sobre blanco en los dos temas: un QR es un
contraste antes que un adorno, y el violeta claro del tema oscuro sobre fondo
oscuro no lo lee ningún escáner.

`paymentQrPayload` se edita en el formulario de la maratón del panel ("Texto del
QR de cobro") o por `PUT /admin/marathons/:id`.

La imagen de respaldo se sigue subiendo con `POST /admin/marathons/:id/qr`
(multipart, campo `file`), o desde el bloque "QR de cobro (imagen, respaldo)"
del panel. Se reencoda a WebP igual que un comprobante o un avatar
(`reencodarImagenAWebp`, `common/utils/image.ts`) y queda con su propia clave
de storage: subir uno nuevo no pisa el archivo anterior, solo el puntero. El
seed deja un QR genérico por maratón (`sembrarQrDeCobro`) para que el flujo se
pueda probar sin que el organizador haya subido el suyo todavía.

`GET /marathons/:slug` los devuelve, para que la app sepa si puede ofrecer el
método en vez de prometer un pago imposible.

Variables de entorno:

| Variable | Por defecto | Para qué |
|---|---|---|
| `PAYMENT_PROOF_MAX_BYTES` | `8388608` (8 MB) | Tope del comprobante antes de procesar |
| `PAYMENT_PROOF_MAX_WIDTH_PX` | `1600` | Ancho al que se reescala. Deja legible el número de transacción sin guardar fotos de 12 MP |
| `PAYMENT_PROOF_TTL_HOURS` | `48` | Plazo para subir el comprobante. Vencido, el cobro queda `failed` y hay que abrir uno nuevo |
| `PUBLIC_REGISTRATION_ENABLED` | `true` | `false` apaga `/public/*` sin desplegar |

## 6. Endpoints

### Corredor (con sesión)

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/registrations/:id/checkout` | Con `method: "qr_manual"`, abre el cobro y devuelve el QR |
| `POST` | `/payments/:id/proof` | Sube el comprobante (`multipart`, campo `file`, `reference` opcional) |
| `GET` | `/payments/:id/proof` | El último comprobante, o `null` |
| `GET` | `/payments/:id` | Estado del cobro; incluye `proof` cuando el método es `qr_manual` |

### Web pública (sin sesión)

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/public/registrations` | Inscribe, crea o vincula la cuenta por CI, abre el cobro, devuelve el `publicToken` |
| `POST` | `/public/registrations/:id/proof` | Sube el comprobante. Token en `X-Public-Token` o `?token=` |
| `GET` | `/public/registrations/:id` | Estado de la inscripción y del comprobante |

Límite: 5 peticiones por minuto y por IP. Este endpoint **crea cuentas sin
token**; sin techo es una fábrica de usuarios.

### Organizador (rol `admin` u `organizer`)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/admin/payment-proofs` | Cola de revisión, del más viejo al más nuevo |
| `POST` | `/admin/payment-proofs/:id/approve` | Acredita el cobro y confirma la inscripción |
| `POST` | `/admin/payment-proofs/:id/reject` | Rechaza con motivo. El cobro **sigue abierto** |

Validar comprobantes es justo para lo que existe el rol `organizer`: mira la
captura y dice si cuadra. El QR de cobro de la maratón lo sigue subiendo un
`admin` —cambiarlo es cambiar a qué cuenta va el dinero—. Ver la sección
*Roles* en `docs/api.md`.

## 7. Decisiones que parecen raras y no lo son

**Tabla aparte y no columnas en `payments`.** Un cobro acumula varios intentos:
se rechaza una captura, el corredor sube otra. Con columnas, la segunda pisa a la
primera y se pierde el rastro de por qué se rechazó. Y borrar el día que entre
una pasarela real es `DROP TABLE` en vez de una migración sobre la tabla de dinero.

**Rechazar no cierra el cobro.** Lo normal es que el corredor haya subido la
captura equivocada. Dejarlo `failed` le obligaría a rehacer la inscripción entera
—y a soltar el cupo— por una foto.

**No se puede subir un segundo comprobante mientras hay uno `in_review`.** Le
daría al organizador dos imágenes y ninguna verdad sobre cuál mirar. Para
corregir, primero hay que rechazar.

**El QR caduca.** `PAYMENT_PROOF_TTL_HOURS`. No es para liberar cupo —un cobro
`pending` no reserva plaza; el cupo se toma al confirmar— sino para que el
corredor que vuelve tres días después reciba un QR y una glosa nuevos en vez de
subir el comprobante a un cobro que ya nadie está mirando.

El vencimiento lo resuelve la siguiente lectura de `GET /payments/:id`, no un
cron: el estado tiene que ser correcto **cuando alguien lo mira**. Es un
vencimiento **blando**: un cobro vencido sigue `pending` en la base hasta que
alguien lo lee, así que un organizador que apruebe a la hora 50 un comprobante
subido a la hora 47 lo acredita sin problema. Es lo que se quiere: el plazo es
para el corredor, no para el que revisa.

**Si el cupo se agota mientras el comprobante espera**, `aprobar()` devuelve el
comprobante a `in_review` en vez de dejarlo aprobado sobre un cobro que sigue
pendiente. Ese es un estado que nadie sabría leer después.

**El comprobante se reencoda a WebP.** No es por el peso: es porque tira el EXIF.
Una foto de teléfono lleva las coordenadas GPS de dónde se tomó, y un comprobante
se saca en casa.

**Cancelar cierra los cobros abiertos.** `RegistrationsService.cancelar()` deja
en `failed` (con `failureReason = cancelled_by_user`) todo cobro que siguiera
`pending`, antes de reembolsar los que estaban `paid`. Sin eso, un QR pendiente
sobrevive a la inscripción que lo abrió: el corredor todavía puede subir un
comprobante y un organizador todavía puede aprobarlo, y aprobar reserva cupo y
emite dorsal — o sea, una inscripción cancelada volvería sola a confirmada. Se
cierra en el estado del cobro y no con un `if` en cada pantalla porque tanto la
subida del comprobante como la acreditación ya exigen `pending`: un solo cambio
de estado tapa los dos caminos.

**El QR es el mismo para todos.** Lo que distingue un pago de otro es la glosa
(`PU-A1B2C3`, los últimos seis del id de inscripción), que es lo que el corredor
escribe en la transferencia y lo que el organizador cuadra contra el extracto.
Seis caracteres caben en el campo de glosa de cualquier banca móvil, que es el
único requisito real: si no cabe, el corredor la recorta y deja de servir.

## 8. Cómo se desmonta

El día que entre una pasarela de verdad:

1. Borrar `src/modules/payments/manual-qr/` y las líneas que la nombran en
   `payments.module.ts` (dos imports, dos entradas).
2. Borrar `src/modules/public/` y su línea en `app.module.ts`.
3. Quitar el desvío `if (dto.method === PaymentMethod.qr_manual)` de
   `PaymentsService.checkout()`, `abrirQrManual()`, `conComprobante()`, y sacar
   `qr_manual` de la lista `CONFIRMABLES` de `acreditarManualmente()`.
4. Migración con el bloque comentado al final de
   `prisma/migrations/20260826120000_qr_manual_payments/migration.sql`.
5. Quitar `qr_manual` de `PaymentMethod` y `manual` de `PaymentProviderName`
   (Postgres no borra valores de un enum: hay que recrear el tipo, y por eso el
   paso 4 no lo intenta).
6. Migración para `marathons.paymentQrPayload` (`DROP COLUMN`, ya escrita
   comentada en `prisma/migrations/20260828120000_marathon_qr_payload/`).
7. En la app, borrar `RacePaymentMethod.qrManual`, la pantalla de comprobante y
   `qr_flutter` del `pubspec.yaml`, y volver a listar los métodos reales en
   `RacePaymentMethod.offered` — que hoy es `[qrManual]` porque no hay pasarela
   contratada.

**Lo que NO se desmonta**, porque es del modelo de cuentas y no del cobro:
`users.ci`, `users.mustChangePassword`, el email opcional y el login por
`identifier`.
