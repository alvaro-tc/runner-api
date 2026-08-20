/**
 * Se ejecuta ANTES de importar el codigo de la app.
 *
 * `ConfigModule.forRoot()` resuelve el entorno en tiempo de importacion del
 * modulo, asi que ajustar `process.env` dentro de un `beforeAll` llega tarde.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://paceup:paceup@localhost:5432/paceup_test?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.LOG_LEVEL = 'fatal';
process.env.LOG_PRETTY = 'false';

// Los tests hacen decenas de logins seguidos desde la misma IP. El limite real
// (10/min) es correcto en produccion y aqui solo estorba: se sube en vez de
// desactivarse, para que el guard siga en el camino y no deje de probarse.
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '1000';
process.env.GLOBAL_RATE_LIMIT_PER_MINUTE = '10000';

// Los avatares de los tests van a un subdirectorio propio: `uploads/` esta en
// .gitignore, pero mezclar los binarios de los tests con los de `npm run dev`
// hace que borrar uno se lleve el otro por delante.
process.env.UPLOADS_DIR ??= './uploads/test';

// El mock de pagos simula la latencia de un PSP real (300-1500 ms). En los
// tests eso serian minutos de espera pura: se apaga. Lo que se prueba es el
// estado del cobro, no cuanto tarda.
process.env.PAYMENT_MOCK_LATENCY_MIN_MS = '0';
process.env.PAYMENT_MOCK_LATENCY_MAX_MS = '0';

// El QR se paga solo en el primer sondeo en vez de a los 8 s, para no dormir
// el test. La espera real sigue configurada por entorno y se prueba aparte
// poniendo el reloj hacia atras.
process.env.PAYMENT_QR_AUTO_CONFIRM_SECONDS ??= '0';

// Secreto del webhook fijado: los tests firman con el mismo valor que verifica
// la app, y asi la firma se prueba de verdad en vez de depender del .env local.
process.env.PAYMENT_WEBHOOK_SECRET = 'secreto-de-webhook-para-los-tests-e2e';
