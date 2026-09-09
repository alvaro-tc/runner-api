# Login social

**Google: implementado.** `POST /api/v1/auth/google`.
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
