# Login social

**Google: implementado.** `POST /api/v1/auth/google`.
**Apple: implementado.** `POST /api/v1/auth/apple` y `POST /api/v1/auth/apple/notifications`.
**Facebook y LinkedIn: descartados** — sus botones ya no existen en la app.

## Google — como funciona

El SDK nativo (`google_sign_in` en Flutter) es el cliente OAuth 2.0. La app no
abre navegador ni maneja redirecciones: obtiene un **ID token** —un JWT firmado
por Google— y lo manda a `POST /auth/google`. `GoogleVerifier` comprueba la
firma y el `audience` contra `GOOGLE_WEB_CLIENT_ID`, y de ahi sale el email.

La respuesta es **la misma** que la de `/auth/login`: `TokenService
.issueForNewSession` emite el par de tokens y la rotacion de 60 dias funciona
igual. El cliente no distingue como entro.

## Decisiones que no son obvias

**No hay tabla `SocialAccount`.** La identidad es el email verificado, que ya es
unico en `users` y ya es credencial de acceso. Una tabla de vinculacion no diria
nada que la fila del usuario no diga. Si algun dia entra un segundo proveedor,
ese es el momento de crearla, no antes.

**Vincular por email es seguro solo por una condicion:** `GoogleVerifier` exige
`email_verified`. Sin ella, un dominio de Workspace mal configurado emite una
identidad con el correo de otra persona y eso es entrar en su cuenta. Si alguna
vez se relaja esa comprobacion, hay que pedir la contrasena antes de vincular.

**La cuenta nueva nace con un hash aleatorio, no con `passwordHash` nulo.** Asi
`login()` no necesita un caso especial: la comparacion contra ese hash nunca
acierta y el usuario simplemente no tiene contrasena. Si la quiere, la pone por
"olvide mi contrasena". Un `passwordHash` nulo obligaria a una migracion y a
recordar el `if` en cada sitio que compara contrasenas — el dia que uno se
olvide, contrasena vacia = entrar.

**`GOOGLE_CLIENT_IDS` es una lista, no un valor.** El `aud` del ID token
depende de como pidio el token el SDK: normalmente es el cliente Web (el
`serverClientId`), pero segun plataforma y version puede llegar el de Android o
el de iOS. Aceptar los tres clientes **del mismo proyecto** no afloja nada y
evita el fallo mas comun de esta integracion, que se manifiesta como un 401 sin
pista. Lo que nunca se puede hacer es quitar el `audience`.

**Es opcional.** Sin el, la API arranca igual y `/auth/google` responde 503, para
que un entorno sin credenciales no tire todo lo demas.

## Configuracion

`GOOGLE_CLIENT_IDS`: los IDs de cliente del proyecto de Google Cloud separados
por comas (web, android, ios). No son secretos: viajan dentro del APK.

En la **app** hay que pasar el del cliente **Web** como `serverClientId` — ese
si tiene que ser exactamente ese y no otro, porque es lo que le dice a Google
para quien emitir el token.

## Facebook y LinkedIn

Descartados. Los dos exigen una revision de la app para poder pedir el email, y
sin email no hay forma de saber de quien es la cuenta. Para el volumen de
usuarios de PaceUp, ese papeleo no se paga. Si algun dia se retoman, el patron
de arriba sirve tal cual: verificar, sacar el email verificado, reutilizar
`issueForNewSession`.

## Apple — por que existe y como funciona

App Review rechazo la app por la **guia 4.8**: quien ofrece un login de terceros
(Google) tiene que ofrecer tambien uno que limite los datos a nombre y correo,
permita ocultar el correo y no rastree para publicidad. Sign in with Apple
cumple las tres. Todo lo de abajo sigue la documentacion de Apple
("Authenticating users", "Verifying a user", "Token revocation", "Processing
changes for Sign in with Apple accounts").

### Login: `POST /auth/apple`

La app (iOS) pide `fullName` y `email` con un **nonce**: genera uno aleatorio,
le pasa a Apple su SHA-256 y nos manda el original. Del lado del servidor
(`AppleVerifier`):

1. Firma RS256 contra las claves publicas de `appleid.apple.com/auth/keys`
   (cacheadas un dia; se recargan si llega un `kid` nuevo).
2. `nonce` = SHA-256 del que mando la app. Sin esto, un token robado se podria
   reenviar.
3. `iss` = `https://appleid.apple.com`, `aud` en `APPLE_CLIENT_IDS`, `exp`.

**La identidad es el `sub`**, no el email: con "Ocultar mi correo" el email es un
relay `@privaterelay.appleid.com` que no coincide con nada, y el usuario puede
dejar de compartirlo. Por eso, a diferencia de Google, aqui si hay columna de
proveedor: `users.appleSub`. Orden de busqueda: por `sub`; si no, por el email
**verificado** (vincula una cuenta que ya existia con ese correo); si no, cuenta
nueva sin contrasena.

**El nombre solo llega la primera vez** que alguien autoriza la app, y fuera del
token. La app lo manda aparte (`givenName`, `familyName`) y la cuenta se crea con
el. Apple pide no volver a preguntar lo que ya se compartio.

### Canje y revocacion (`AppleClient`)

En cada login se canjea el `authorizationCode` (5 minutos, un solo uso) en
`/auth/token` por un **refresh token**, que se guarda en `users.appleRefreshToken`.
No da acceso a nada: existe para **revocarlo** en `/auth/revoke` cuando el
usuario borra su cuenta, que es requisito de Apple para apps con Sign in with
Apple. Lo hace `UsersService.borrarCuenta` despues del DELETE (tambien cuando
borra un admin).

Para hablar con esa API hace falta un `client_secret`: un JWT ES256 firmado con
la clave `.p8` del equipo (`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`).
Sin ellas el login funciona, pero no se guarda token y no se podra revocar: en
produccion tienen que estar.

### Notificaciones servidor a servidor: `POST /auth/apple/notifications`

Apple avisa de lo que el usuario cambia desde los ajustes de su Apple Account.
El cuerpo es `{ "payload": "<JWS>" }`, firmado con las mismas claves:

| Evento | Que se hace |
|---|---|
| `consent-revoked` | Dejo de usar Apple con CamRun: se cierran sus sesiones y se olvida el token. El `sub` se conserva: si vuelve, recupera su cuenta. |
| `account-deleted` | Borro su Apple Account: ademas se desvincula el `sub`. La cuenta de CamRun **no** se borra sola (puede tener contrasena, carreras pagadas). |
| `email-disabled` / `email-enabled` | Solo log: el unico correo que se manda es el de recuperar contrasena, y lo pide el usuario. |

### Configuracion en Apple Developer

1. **Identifiers > App ID `com.tumype.camrun`**: activar *Sign In with Apple*
   (como app principal). En su *Edit*, poner como *Server-to-Server
   Notification Endpoint* `https://<API_DOMAIN>/api/v1/auth/apple/notifications`.
2. **Keys**: crear una clave con *Sign in with Apple*, asociada a ese App ID.
   Descargar el `.p8` (una sola vez) y anotar su Key ID.
3. **Correo de relay**: en *Sign in with Apple for Email Communication*,
   registrar el dominio o la direccion desde la que se envian los correos de
   recuperar contrasena. Sin eso, los correos a `@privaterelay.appleid.com`
   rebotan.
4. Entorno: `APPLE_CLIENT_IDS=com.tumype.camrun` y las tres credenciales.
