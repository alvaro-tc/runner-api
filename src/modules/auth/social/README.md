# Login social — no implementado (a propósito)

Los botones de Google, LinkedIn y Facebook de la app son **solo UI** por ahora.
Este directorio existe para marcar dónde irá el flujo real y para que quede
escrito qué falta, en vez de dejar el tema flotando.

## Por qué no está implementado

El flujo real no es código: es papeleo. Cada proveedor exige una aplicación
registrada, credenciales, URLs de redirección declaradas y — en el caso de
Facebook y LinkedIn — una revisión antes de poder pedir el email del usuario.
Escribir la estrategia sin nada de eso produce código que no se puede ni
ejecutar ni probar.

## Qué haría falta para activarlo

1. **Registrar la app** en cada proveedor y obtener `clientId` / `clientSecret`.
   - Google: Google Cloud Console → OAuth consent screen + credenciales.
   - Facebook: Meta for Developers, con revisión para el permiso `email`.
   - LinkedIn: LinkedIn Developers, producto *Sign In with LinkedIn*.
2. **Declarar los redirect URI**, incluido el esquema de la app móvil para el
   retorno desde el navegador del sistema.
3. **Añadir las credenciales al esquema de entorno** (`src/config/env.schema.ts`),
   opcionales, para que la ausencia de un proveedor no impida arrancar.
4. **Modelo de datos:** una tabla `SocialAccount` con
   `(provider, providerAccountId)` único, `userId`, y los tokens del proveedor.
   No hace falta tocar `User`.
5. **Decidir la política de vinculación por email** — es la parte con filo:
   si alguien se registró con `ana@mail.com` y contraseña, y después entra con
   Google usando ese mismo email, ¿es la misma cuenta? Vincular automáticamente
   es cómodo y es exactamente el agujero por el que se toma una cuenta ajena si
   el proveedor no verificó el email. La regla segura: vincular solo si el
   proveedor marca el email como verificado, y si no, pedir la contraseña
   existente antes de unir las cuentas.
6. **En Flutter:** abrir el flujo en el navegador del sistema (no en un webview
   embebido, que los proveedores rechazan), capturar el retorno por deep link y
   canjearlo en `POST /api/v1/auth/social/:provider`.

## Lo que ya está resuelto y no habría que rehacer

El resultado del login social es el mismo par de tokens que emite el login
normal. `TokenService.issueForNewSession(userId, role, device)` es el punto de
entrada: una vez resuelto qué usuario es, la sesión, la rotación de 60 días y la
detección de reuso funcionan igual. La parte difícil de la sesión ya está hecha.
