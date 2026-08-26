import { z } from 'zod';

/**
 * Esquema unico de variables de entorno.
 *
 * Se valida al arrancar (ver `validateEnv`). Si falta algo o tiene un valor
 * imposible, el proceso muere con un mensaje que dice exactamente que variable
 * esta mal: nunca arrancamos con configuracion a medias.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  API_DOMAIN: z.string().min(1).default('api.paceup.example'),
  /** Lista separada por comas. `*` solo se acepta fuera de produccion. */
  CORS_ORIGINS: z.string().default('*'),

  DATABASE_URL: z.string().refine((v) => v.startsWith('postgres'), {
    message: 'DATABASE_URL debe ser una cadena de conexion postgresql://',
  }),
  REDIS_URL: z.string().refine((v) => v.startsWith('redis'), {
    message: 'REDIS_URL debe ser una cadena de conexion redis://',
  }),
  /// Solo la usa `prisma migrate dev` para detectar drift. La app nunca la abre.
  SHADOW_DATABASE_URL: z.string().optional(),

  // ─── Autenticacion ────────────────────────────────────────────────────────
  /// Secreto de firma del access token. Sin default a proposito: un secreto por
  /// defecto es un secreto publico. Generalo con `openssl rand -base64 48`.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  /// TTL del access token. Corto: si se filtra, caduca solo.
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  /// TTL del refresh token. 60 dias, y rota en cada uso: mientras el usuario
  /// abra la app cada tanto, la sesion nunca caduca.
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(60),
  /// Ventana de validez del enlace de recuperacion de contrasena.
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /// Intentos por minuto y por IP en los endpoints que aceptan credenciales.
  /// Es la perilla de calibracion: 10 no molesta a quien escribe mal la clave
  /// y corta el ataque automatizado, pero detras de un NAT compartido (una
  /// oficina, una red movil) puede quedarse corto. Los tests lo suben.
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /// Peticiones por minuto y por IP en el resto de la API.
  GLOBAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /// Lotes de posiciones por minuto y POR SESION (no por IP: media maraton sale
  /// por la misma red movil con la misma IP publica). El ritmo normal son 2-4;
  /// el resto es margen para el cliente que drena su cola al salir de un tunel.
  TRACKING_INGEST_BATCHES_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /// Puntos por minuto y POR DISPOSITIVO en el endpoint OsmAnd. Mucho mas alto
  /// que el de lotes porque ahi cada punto es una peticion: a 1 Hz un tracker
  /// manda 60 por minuto.
  TRACKING_OSMAND_POINTS_PER_MINUTE: z.coerce.number().int().positive().default(120),

  // ─── Tiempo real ─────────────────────────────────────────────────────────────
  /// Minimo entre dos posiciones del MISMO corredor hacia los espectadores.
  /// Un corredor manda 30 puntos por lote; reenviarlos todos multiplicaria por
  /// treinta el trafico para dibujar tres pixeles de movimiento.
  LIVE_UPDATE_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  DEFAULT_TIMEZONE: z.string().min(1).default('America/La_Paz'),

  INVOICE_LEGAL_NAME: z.string().min(1).default('PaceUp SRL'),
  INVOICE_NIT: z.string().min(1).default('0000000000'),
  INVOICE_ADDRESS: z.string().min(1).default('La Paz, Bolivia'),

  BODY_LIMIT: z.string().default('2mb'),

  // ─── App movil: enlaces profundos y version minima ───────────────────────
  /// Esquema propio de la app (`paceup://maraton/la-paz-21k`). Es lo que abre
  /// el telefono desde una pagina de `/links/*`.
  APP_LINK_SCHEME: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*$/, {
      message: 'APP_LINK_SCHEME debe ser un esquema URI valido, en minusculas',
    })
    .default('paceup'),
  /// Version minima de la app que la API soporta (semver). El cliente la lee en
  /// `/config/app` y decide si obliga a actualizar. Subirla es una decision de
  /// producto, no un despliegue de codigo: por eso es env y no constante.
  MIN_APP_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, {
      message: 'MIN_APP_VERSION debe ser semver (1.2.3)',
    })
    .default('1.0.0'),
  /// Fichas de tienda para quien abre un enlace sin la app instalada. Vacias
  /// mientras no haya publicacion: la pagina simplemente no pinta el boton.
  APP_STORE_URL: z.string().url().optional(),
  PLAY_STORE_URL: z.string().url().optional(),

  // ─── Pagos (proveedor simulado) ──────────────────────────────────────────
  /// Latencia artificial del mock, en milisegundos. No es capricho: un cobro
  /// que responde en 2 ms deja la UI sin loaders y esconde justo los bugs de
  /// estado que aparecen cuando la red tarda. Los tests la ponen en 0.
  PAYMENT_MOCK_LATENCY_MIN_MS: z.coerce.number().int().min(0).default(300),
  PAYMENT_MOCK_LATENCY_MAX_MS: z.coerce.number().int().min(0).default(1500),
  /// Ventana de validez del QR. Pasada, el cobro queda `failed` con
  /// `qr_expired` y hay que pedir uno nuevo.
  PAYMENT_QR_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  /// Segundos que tarda el QR mock en "pagarse" solo, para que el polling del
  /// cliente tenga algo real que observar.
  PAYMENT_QR_AUTO_CONFIRM_SECONDS: z.coerce.number().int().min(0).default(8),

  // ─── Datos bancarios mock para el metodo `bank_transfer` ─────────────────
  PAYMENT_BANK_NAME: z.string().min(1).default('Banco Nacional de Bolivia'),
  PAYMENT_BANK_ACCOUNT: z.string().min(1).default('1000-0000-0000'),
  PAYMENT_BANK_ACCOUNT_TYPE: z.string().min(1).default('Caja de ahorro'),

  /// Secreto con el que se firman y verifican los webhooks del proveedor.
  /// Sin default en produccion: un secreto por defecto es un secreto publico y
  /// cualquiera podria declarar pagada una inscripcion. Ver `validateEnv`.
  PAYMENT_WEBHOOK_SECRET: z.string().min(16).default('mock-webhook-secret-de-desarrollo'),
  /// Ventana de tolerancia de la marca de tiempo del webhook, en segundos.
  /// Fuera de ella la peticion se rechaza aunque la firma sea correcta: es lo
  /// que impide reenviar un webhook capturado hace un mes.
  PAYMENT_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

  // ─── Archivos subidos (avatares, tarjetas de resultado) ──────────────────
  /// Raiz del driver local de `StorageService`. Se sirve en `/uploads`.
  UPLOADS_DIR: z.string().min(1).default('./uploads'),
  /// Base publica con la que se arman las URLs de los archivos servidos. En el
  /// VPS es `https://<API_DOMAIN>`; en local, el puerto de `npm run dev`.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  /// Tamano maximo del avatar ANTES de procesar. 5 MB.
  AVATAR_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  /// Lado del avatar cuadrado que se guarda. Todo lo que llega se redimensiona.
  AVATAR_SIZE_PX: z.coerce.number().int().positive().default(512),

  // --- Cobro por QR manual (TEMPORAL, ver docs/pago-qr-manual.md) ----------
  /// Tamano maximo del comprobante ANTES de procesar. 8 MB: una captura de
  /// pantalla de banca movil pesa menos, pero una foto de un telefono nuevo no.
  PAYMENT_PROOF_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  /// Ancho maximo al que se reescala el comprobante guardado. 1600 px deja el
  /// numero de transaccion legible y evita guardar fotos de 12 MP.
  PAYMENT_PROOF_MAX_WIDTH_PX: z.coerce.number().int().positive().default(1600),
  /// Horas que se le dan al corredor para subir el comprobante. Pasadas, el
  /// cobro queda `failed` y el cupo se suelta: sin esto un QR sin pagar
  /// bloquearia una plaza para siempre.
  PAYMENT_PROOF_TTL_HOURS: z.coerce.number().int().positive().default(48),
  /// Deja abierta la inscripcion publica desde la web. Apagarlo cierra
  /// `/public/*` de golpe sin desplegar codigo.
  PUBLIC_REGISTRATION_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

export type Env = z.infer<typeof envSchema>;

/** Validador que `ConfigModule` invoca con `process.env`. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuracion de entorno invalida:\n${detalle}`);
  }

  if (parsed.data.PAYMENT_MOCK_LATENCY_MIN_MS > parsed.data.PAYMENT_MOCK_LATENCY_MAX_MS) {
    throw new Error(
      'Configuracion de entorno invalida:\n  - PAYMENT_MOCK_LATENCY_MIN_MS: no puede ' +
        'superar a PAYMENT_MOCK_LATENCY_MAX_MS',
    );
  }

  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.PAYMENT_WEBHOOK_SECRET === 'mock-webhook-secret-de-desarrollo'
  ) {
    throw new Error(
      'Configuracion de entorno invalida:\n  - PAYMENT_WEBHOOK_SECRET: el valor por defecto ' +
        'no se permite en produccion (generalo con `openssl rand -base64 32`)',
    );
  }

  if (parsed.data.NODE_ENV === 'production' && parsed.data.CORS_ORIGINS.trim() === '*') {
    throw new Error(
      'Configuracion de entorno invalida:\n  - CORS_ORIGINS: "*" no se permite en produccion',
    );
  }

  return parsed.data;
}
