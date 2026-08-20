import { validateEnv } from './env.schema';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'un-secreto-de-prueba-con-mas-de-32-caracteres',
};

/** Un entorno de produccion valido: cada test rompe solo lo que quiere probar. */
const produccion = {
  ...base,
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://app.paceup.example',
  PAYMENT_WEBHOOK_SECRET: 'un-secreto-de-webhook-largo-y-propio',
};

describe('validateEnv', () => {
  it('aplica los valores por defecto cuando solo se dan los obligatorios', () => {
    const env = validateEnv({ ...base });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DEFAULT_TIMEZONE).toBe('America/La_Paz');
    expect(env.LOG_PRETTY).toBe(false);
  });

  it('convierte PORT a numero y LOG_PRETTY a booleano', () => {
    const env = validateEnv({ ...base, PORT: '8080', LOG_PRETTY: 'true' });

    expect(env.PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
  });

  it('muere nombrando la variable que falta', () => {
    expect(() => validateEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('rechaza una DATABASE_URL que no sea de postgres', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rechaza un NODE_ENV desconocido', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('exige un JWT_SECRET largo: un secreto por defecto es un secreto publico', () => {
    const sinSecreto: Record<string, unknown> = { ...base };
    delete sinSecreto['JWT_SECRET'];

    expect(() => validateEnv(sinSecreto)).toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...base, JWT_SECRET: 'corto' })).toThrow(/JWT_SECRET/);
  });

  it('los TTL de sesion traen los valores acordados', () => {
    const env = validateEnv({ ...base });

    expect(env.ACCESS_TOKEN_TTL_MINUTES).toBe(15);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(60);
    expect(env.AUTH_RATE_LIMIT_PER_MINUTE).toBe(10);
  });

  it('prohibe CORS_ORIGINS="*" en produccion pero lo permite en desarrollo', () => {
    expect(() => validateEnv({ ...produccion, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(validateEnv({ ...base, CORS_ORIGINS: '*' }).CORS_ORIGINS).toBe('*');
  });

  it('prohibe el secreto de webhook por defecto en produccion', () => {
    // Un secreto por defecto es un secreto publico: con el, cualquiera podria
    // firmar un webhook y declarar pagada una inscripcion.
    const { PAYMENT_WEBHOOK_SECRET, ...sinSecreto } = produccion;
    void PAYMENT_WEBHOOK_SECRET;

    expect(() => validateEnv(sinSecreto)).toThrow(/PAYMENT_WEBHOOK_SECRET/);
    expect(validateEnv(produccion).PAYMENT_WEBHOOK_SECRET).not.toBe(
      'mock-webhook-secret-de-desarrollo',
    );
  });

  it('fuera de produccion el secreto de webhook por defecto vale', () => {
    expect(validateEnv({ ...base }).PAYMENT_WEBHOOK_SECRET).toBe(
      'mock-webhook-secret-de-desarrollo',
    );
  });

  it('exige que la latencia minima del mock no supere a la maxima', () => {
    expect(() =>
      validateEnv({
        ...base,
        PAYMENT_MOCK_LATENCY_MIN_MS: '2000',
        PAYMENT_MOCK_LATENCY_MAX_MS: '500',
      }),
    ).toThrow(/PAYMENT_MOCK_LATENCY_MIN_MS/);
  });
});
