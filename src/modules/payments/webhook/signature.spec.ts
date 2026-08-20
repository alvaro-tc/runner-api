import { ResultadoDeVerificacion, firmar, parsearFirma, verificar } from './signature';

const SECRETO = 'un-secreto-de-webhook-de-prueba';
const AHORA = new Date('2026-08-19T12:00:00.000Z');
const CUERPO = '{"id":"evt_1","type":"payment.paid","data":{"externalId":"mock_pi_1"}}';

const opciones = (over: Partial<Parameters<typeof verificar>[0]> = {}) => ({
  cabecera: firmar(CUERPO, SECRETO, AHORA),
  cuerpo: CUERPO,
  secreto: SECRETO,
  toleranciaSegundos: 300,
  ahora: AHORA,
  ...over,
});

describe('parsearFirma', () => {
  it('descompone la cabecera', () => {
    expect(parsearFirma('t=1755600000,v1=abc123')).toEqual({ timestamp: 1755600000, v1: 'abc123' });
  });

  it('tolera espacios alrededor de las partes', () => {
    expect(parsearFirma(' t=1755600000 , v1=abc123 ')?.v1).toBe('abc123');
  });

  it('devuelve null en vez de adivinar', () => {
    expect(parsearFirma(undefined)).toBeNull();
    expect(parsearFirma('')).toBeNull();
    expect(parsearFirma('abc123')).toBeNull();
    expect(parsearFirma('v1=abc123')).toBeNull();
    expect(parsearFirma('t=abc,v1=abc123')).toBeNull();
    expect(parsearFirma('t=1755600000')).toBeNull();
  });
});

describe('firmar', () => {
  it('es determinista para el mismo cuerpo, secreto y momento', () => {
    expect(firmar(CUERPO, SECRETO, AHORA)).toBe(firmar(CUERPO, SECRETO, AHORA));
  });

  it('cambia si cambia el cuerpo', () => {
    expect(firmar(CUERPO, SECRETO, AHORA)).not.toBe(firmar(`${CUERPO} `, SECRETO, AHORA));
  });

  it('cambia si cambia el secreto', () => {
    expect(firmar(CUERPO, SECRETO, AHORA)).not.toBe(firmar(CUERPO, 'otro-secreto', AHORA));
  });

  it('cambia con el tiempo aunque el cuerpo sea el mismo', () => {
    const despues = new Date(AHORA.getTime() + 60_000);

    expect(firmar(CUERPO, SECRETO, AHORA)).not.toBe(firmar(CUERPO, SECRETO, despues));
  });
});

describe('verificar', () => {
  it('acepta una firma correcta y fresca', () => {
    expect(verificar(opciones())).toBe(ResultadoDeVerificacion.ok);
  });

  it('rechaza una cabecera ausente o malformada', () => {
    expect(verificar(opciones({ cabecera: undefined }))).toBe(ResultadoDeVerificacion.malformed);
    expect(verificar(opciones({ cabecera: 'basura' }))).toBe(ResultadoDeVerificacion.malformed);
  });

  it('rechaza si el cuerpo cambio aunque sea un byte', () => {
    // El caso real: alguien intercepta el webhook y sube el monto.
    const manipulado = CUERPO.replace('payment.paid', 'payment.paíd');

    expect(verificar(opciones({ cuerpo: manipulado }))).toBe(ResultadoDeVerificacion.mismatch);
  });

  it('rechaza una firma hecha con otro secreto', () => {
    expect(verificar(opciones({ cabecera: firmar(CUERPO, 'otro-secreto', AHORA) }))).toBe(
      ResultadoDeVerificacion.mismatch,
    );
  });

  it('rechaza un digest de longitud distinta sin reventar', () => {
    expect(verificar(opciones({ cabecera: 't=1755604800,v1=corto' }))).toBe(
      ResultadoDeVerificacion.mismatch,
    );
  });

  it('rechaza un webhook viejo aunque la firma sea correcta', () => {
    // Un webhook capturado y reenviado media hora despues.
    const viejo = firmar(CUERPO, SECRETO, new Date(AHORA.getTime() - 30 * 60_000));

    expect(verificar(opciones({ cabecera: viejo }))).toBe(ResultadoDeVerificacion.stale);
  });

  it('rechaza tambien un webhook fechado en el futuro', () => {
    const futuro = firmar(CUERPO, SECRETO, new Date(AHORA.getTime() + 30 * 60_000));

    expect(verificar(opciones({ cabecera: futuro }))).toBe(ResultadoDeVerificacion.stale);
  });

  it('acepta dentro de la ventana de tolerancia, a los dos lados', () => {
    const antes = firmar(CUERPO, SECRETO, new Date(AHORA.getTime() - 299_000));
    const despues = firmar(CUERPO, SECRETO, new Date(AHORA.getTime() + 299_000));

    expect(verificar(opciones({ cabecera: antes }))).toBe(ResultadoDeVerificacion.ok);
    expect(verificar(opciones({ cabecera: despues }))).toBe(ResultadoDeVerificacion.ok);
  });

  it('una firma valida pero vieja no se distingue como "casi correcta"', () => {
    // Comprueba el orden: primero firma, despues frescura. Quien no tiene el
    // secreto recibe `mismatch` y nunca llega a saber si acerto el timestamp.
    const sinSecreto = verificar(
      opciones({ cabecera: firmar(CUERPO, 'no-es-el-secreto', new Date(AHORA.getTime() - 1e6)) }),
    );

    expect(sinSecreto).toBe(ResultadoDeVerificacion.mismatch);
  });
});
