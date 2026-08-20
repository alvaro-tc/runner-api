/**
 * Catalogo unico de codigos de error de la API.
 *
 * El cliente Flutter mapea SIEMPRE por `code`, nunca por el texto de `message`
 * (que es humano, traducible y puede cambiar sin aviso). Todo codigo nuevo se
 * agrega aqui y se documenta en `docs/api.md`.
 */
export const ErrorCode = {
  // ─── Genericos ──────────────────────────────────────────────────────────
  /** Fallo no controlado. Nunca expone el detalle interno al cliente. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** El body / query / params no paso la validacion de DTO. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** El recurso no existe, o existe pero no es de este usuario. */
  NOT_FOUND: 'NOT_FOUND',
  /** Falta el token, esta vencido o es invalido. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Autenticado, pero sin permiso sobre este recurso. */
  FORBIDDEN: 'FORBIDDEN',
  /** Conflicto de estado (duplicado, transicion no permitida). */
  CONFLICT: 'CONFLICT',
  /** Se supero el rate limit. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Una dependencia externa (BD, Redis) no responde. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // ─── Autenticacion ──────────────────────────────────────────────────────
  /** Email o contrasena incorrectos. Mensaje deliberadamente ambiguo: no
   *  revela si el email existe. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Ya hay una cuenta con ese email. */
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  /** El refresh token no existe, caduco o ya se reemplazo. El cliente debe
   *  limpiar el storage y volver a Welcome. */
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  /** Llego un refresh token YA rotado: alguien tiene una copia vieja. Se
   *  revocan todas las sesiones de ese dispositivo. El cliente debe pedir
   *  login de nuevo. */
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  /** El enlace de recuperacion no existe, ya se uso o caduco. */
  INVALID_RESET_TOKEN: 'INVALID_RESET_TOKEN',
  /** Autenticado, pero el rol no alcanza para esta operacion. */
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',

  // ─── Usuarios y perfil ──────────────────────────────────────────────────
  /** El archivo subido no es una imagen que se pueda decodificar, o su tipo
   *  real no coincide con lo declarado. */
  INVALID_IMAGE: 'INVALID_IMAGE',
  /** El archivo supera el limite de tamano del endpoint. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',

  // ─── Maratones y precios ────────────────────────────────────────────────
  /** La categoria no pertenece a esa maraton. */
  INVALID_CATEGORY: 'INVALID_CATEGORY',
  /** El adicional no pertenece a esa maraton, o se pidio una cantidad absurda. */
  INVALID_EXTRA: 'INVALID_EXTRA',
  /** No queda stock del adicional para la cantidad pedida. */
  EXTRA_OUT_OF_STOCK: 'EXTRA_OUT_OF_STOCK',

  // ─── Inscripciones ──────────────────────────────────────────────────────
  /** Se agotaron los cupos mientras el usuario completaba el flujo. */
  MARATHON_FULL: 'MARATHON_FULL',
  /** Las inscripciones estan cerradas: vencio el plazo o el organizador cerro. */
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  /** Ya hay una inscripcion confirmada de este usuario en esta maraton. */
  ALREADY_REGISTERED: 'ALREADY_REGISTERED',
  /** La inscripcion ya no es un borrador: confirmada o cancelada no se edita. */
  REGISTRATION_NOT_EDITABLE: 'REGISTRATION_NOT_EDITABLE',
  /** Falta elegir categoria en una maraton que las tiene. */
  CATEGORY_REQUIRED: 'CATEGORY_REQUIRED',
  /** La carrera ya ocurrio, o el estado no admite cancelacion. */
  CANCELLATION_NOT_ALLOWED: 'CANCELLATION_NOT_ALLOWED',

  // ─── Planes de entrenamiento ────────────────────────────────────────────
  /** Ya hay un plan activo. Solo puede haber uno: el cliente tiene que
   *  confirmar que abandona el anterior (`replaceActive: true`). */
  PLAN_ALREADY_ACTIVE: 'PLAN_ALREADY_ACTIVE',
  /** No quedan semanas suficientes hasta la carrera ni recortando las de base.
   *  `details[0]` trae `weeksAvailable` y `minimumWeeks`. */
  PLAN_DOES_NOT_FIT: 'PLAN_DOES_NOT_FIT',
  /** Se intento abandonar un plan que ya esta cerrado. */
  PLAN_NOT_ACTIVE: 'PLAN_NOT_ACTIVE',
  /** La sesion ya esta completada o saltada: no admite otro cambio. */
  SESSION_NOT_PENDING: 'SESSION_NOT_PENDING',

  // ─── Entrenamientos y tracking ──────────────────────────────────────────
  /** Ya hay una sesion de tracking abierta. `details[0]` trae su `sessionId`:
   *  casi siempre es una vieja que quedo colgada al morir la app. */
  SESSION_ALREADY_ACTIVE: 'SESSION_ALREADY_ACTIVE',
  /** La sesion no esta en el estado que la operacion necesita: ya se cerro, o
   *  se intento reanudar una que no estaba en pausa. */
  SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
  /** El `ingestToken` falta, no existe o no es el de esa sesion. Los tres casos
   *  responden igual a proposito: distinguirlos seria un oraculo para adivinar
   *  ids de sesiones ajenas. */
  INVALID_INGEST_TOKEN: 'INVALID_INGEST_TOKEN',

  // ─── Pagos ──────────────────────────────────────────────────────────────
  /** Falta la cabecera `Idempotency-Key` en un endpoint que cobra. */
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  /** Esa clave ya se uso para cobrar OTRA cosa. Reusarla borraria el rastro
   *  del primer cobro, asi que se rechaza en vez de resolverse a la fuerza. */
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  /** El proveedor rechazo el cobro. `details[0].reason` dice por que
   *  (`card_declined`, `expired_card`, `invalid_card`). */
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  /** El metodo pedido existe en el enum pero este proveedor no lo atiende. */
  PAYMENT_METHOD_NOT_SUPPORTED: 'PAYMENT_METHOD_NOT_SUPPORTED',
  /** El pago ya esta cerrado (`paid`, `failed` o `refunded`): no admite otra
   *  confirmacion ni otro reembolso. */
  PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  /** Todavia no hay comprobante: el cobro no llego a `paid`. */
  RECEIPT_NOT_AVAILABLE: 'RECEIPT_NOT_AVAILABLE',
  // ─── Carreras ───────────────────────────────────────────────────────────
  /** La carrera todavia no tiene resultado: no se corrio, o el organizador aun
   *  no cargo los tiempos. No es un error del cliente, es un "todavia no". */
  RESULT_NOT_AVAILABLE: 'RESULT_NOT_AVAILABLE',

  /** La firma HMAC del webhook falta, no cuadra o llego fuera de la ventana de
   *  tolerancia. Deliberadamente indistinguibles entre si. */
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
