# Recibo de donación CAM

[PDF de ejemplo con datos ficticios](recibo-ejemplo.pdf).

Al confirmar un cobro y su inscripción se emite el PDF. Esto cubre aprobación
del comprobante QR, confirmación manual de transferencia, tarjeta y QR simulado.
El aviso de pago validado conserva su enlace al detalle de la carrera.

La plantilla `src/modules/payments/receipt/assets/donaciones.jpeg` es una copia
binaria de la imagen entregada: no se recorta, redibuja ni recomprime. El PDF
tiene una página de 828 × 495 puntos y conserva las proporciones originales.
Poppins se incrusta únicamente para los valores añadidos; su licencia acompaña
al archivo de fuente. La resolución del fondo es la de la imagen original.

| Campo | Valor |
| --- | --- |
| Nro. | ID completo y único del pago |
| Donador | `personalData.fullName` de la inscripción |
| Concepto | Inscripción y nombre de la carrera |
| Bs. / $US | Moneda del pago; sin conversión |
| Total | Importe efectivamente cobrado, con dos decimales |
| La suma de | Importe en letras y centavos `NN/100` |
| Fecha | Fecha de pago en la zona horaria de la carrera |

Los valores largos reducen el tamaño de letra dentro de sus casillas. No se
agregan textos, logotipos, filas ni páginas al modelo entregado.

## Persistencia y recuperación

- Los archivos se guardan en `payments/receipts/cam-v1/<paymentId>.pdf` dentro
  del almacenamiento configurado. `receiptUrl` conserva el resultado.
- Consultas concurrentes comparten la misma emisión dentro del proceso.
- Un fallo de PDF no revierte un pago validado. Cada minuto, un servicio revisa
  lotes de hasta 50 pagos confirmados sin recibo y reintenta; la cola persiste
  en la base y se recupera después de reiniciar el backend.
- La descarga también reintenta una emisión pendiente. Si falta un archivo
  previamente guardado, lo vuelve a generar. Un recibo de la plantilla anterior
  se sustituye por la versión CAM al consultarlo, conservando el archivo viejo.
- Los assets se copian junto al JavaScript mediante `nest-cli.json`, por lo
  que funcionan tanto en desarrollo como en el artefacto `dist/` desplegado.

## App móvil

**Mis carreras → detalle de la carrera → Descargar recibo.** El botón se
muestra cuando el pago está en `paid`. Abre un visor con carga, error y
reintento; ofrece guardar/compartir el PDF e imprimirlo mediante las opciones
nativas del dispositivo. La app muestra el PDF del servidor, no lo reconstruye.

`GET /api/v1/races/:registrationId/receipt/pdf` entrega `application/pdf`,
requiere sesión y valida que la inscripción sea del usuario. Responde 404 para
una inscripción ajena y 409 si no existe un pago cobrado. Las rutas anteriores
que devuelven `{ url }` siguen disponibles.

No requiere migraciones nuevas. Para instalar el cambio, compilar/reiniciar el
backend y ejecutar `flutter pub get` y una compilación completa de la app: el
visor usa el plugin nativo [printing](https://pub.dev/packages/printing), así que
hot reload por sí solo no instala esa dependencia.

## Verificación

- Tests de PDF: imagen original incrustada sin modificaciones, página única,
  proporciones, importes en letras, centavos y textos largos.
- Integración con PostgreSQL: aprobación de QR por organizador, recibo inmediato,
  descarga propia, rechazo de acceso ajeno, fallo de almacenamiento y recuperación,
  reutilización y emisión concurrente.
- Flutter: descarga binaria, errores JSON en respuestas binarias, rechazo de
  contenido no PDF, y carga/error/reintento del visor.

Las suites e2e deben ejecutarse contra una base de pruebas migrada. Fijar
`PAYMENT_QR_AUTO_CONFIRM_SECONDS=0` para que el QR simulado se confirme en el
primer sondeo de las pruebas, como espera `test/setup-env.ts`.

Validación realizada: 356 pruebas unitarias del backend, 77 de integración con
PostgreSQL aislado, 65 pruebas Flutter de carreras/red/visor, lint del backend,
análisis de los archivos Flutter modificados y compilación iOS para simulador.
También se revisó visualmente el PDF de ejemplo.

Limitaciones del entorno: la compilación Android encontró que la configuración
existente usa `compileSdk = 37` con AGP 9.0.1, mientras el SDK disponible se
instala como `android-37.0`. La actualización de esa cadena de herramientas
queda fuera del cambio del recibo. Consultar la
[compatibilidad oficial de AGP y SDK](https://developer.android.com/build/releases/about-agp).
El análisis Flutter global y la guardia i18n mantienen hallazgos previos en
tracking, administración y el mapa; no señalan los archivos nuevos del recibo.
Las acciones nativas de guardar/compartir/imprimir requieren una prueba final
en dispositivo físico.
