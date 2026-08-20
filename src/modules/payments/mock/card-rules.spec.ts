import { MotivoDeRechazo, evaluarTarjeta, marcaDe, pasaLuhn } from './card-rules';
import type { DatosDeTarjeta } from '../payment-provider';

const AHORA = new Date('2026-08-19T12:00:00.000Z');

const tarjeta = (over: Partial<DatosDeTarjeta> = {}): DatosDeTarjeta => ({
  number: '4242424242424242',
  holder: 'ALVARO QUISPE',
  expMonth: 12,
  expYear: 2030,
  cvv: '123',
  ...over,
});

describe('pasaLuhn', () => {
  it('acepta las tres tarjetas de prueba', () => {
    expect(pasaLuhn('4242424242424242')).toBe(true);
    expect(pasaLuhn('4000000000000002')).toBe(true);
    expect(pasaLuhn('4000000000000069')).toBe(true);
  });

  it('rechaza un digito cambiado', () => {
    expect(pasaLuhn('4242424242424243')).toBe(false);
  });

  it('ignora espacios y guiones, como los teclea la gente', () => {
    expect(pasaLuhn('4242 4242 4242 4242')).toBe(true);
    expect(pasaLuhn('4242-4242-4242-4242')).toBe(true);
  });

  it('rechaza longitudes imposibles', () => {
    expect(pasaLuhn('42424242')).toBe(false);
    expect(pasaLuhn('4'.repeat(25))).toBe(false);
  });
});

describe('marcaDe', () => {
  it('deduce la marca del prefijo', () => {
    expect(marcaDe('4242424242424242')).toBe('visa');
    expect(marcaDe('5555555555554444')).toBe('mastercard');
    expect(marcaDe('2223003122003222')).toBe('mastercard');
    expect(marcaDe('378282246310005')).toBe('amex');
    expect(marcaDe('9999999999999999')).toBe('unknown');
  });
});

describe('evaluarTarjeta', () => {
  it('aprueba la 4242 y devuelve solo marca y ultimos cuatro', () => {
    const r = evaluarTarjeta(tarjeta(), AHORA);

    expect(r).toEqual({ approved: true, reason: null, brand: 'visa', last4: '4242' });
  });

  it('rechaza la 4000...0002 con card_declined', () => {
    const r = evaluarTarjeta(tarjeta({ number: '4000000000000002' }), AHORA);

    expect(r.approved).toBe(false);
    expect(r.reason).toBe(MotivoDeRechazo.card_declined);
    expect(r.last4).toBe('0002');
  });

  it('rechaza la 4000...0069 con expired_card aunque la fecha sea futura', () => {
    const r = evaluarTarjeta(tarjeta({ number: '4000000000000069' }), AHORA);

    expect(r.reason).toBe(MotivoDeRechazo.expired_card);
  });

  it('rechaza como invalid_card lo que no pasa Luhn', () => {
    const r = evaluarTarjeta(tarjeta({ number: '4242424242424243' }), AHORA);

    expect(r.reason).toBe(MotivoDeRechazo.invalid_card);
  });

  it('rechaza un CVV que no son 3 o 4 digitos', () => {
    expect(evaluarTarjeta(tarjeta({ cvv: '12' }), AHORA).reason).toBe(MotivoDeRechazo.invalid_card);
    expect(evaluarTarjeta(tarjeta({ cvv: 'abc' }), AHORA).reason).toBe(
      MotivoDeRechazo.invalid_card,
    );
  });

  it('rechaza un mes fuera de rango antes de mirar la expiracion', () => {
    expect(evaluarTarjeta(tarjeta({ expMonth: 13 }), AHORA).reason).toBe(
      MotivoDeRechazo.invalid_card,
    );
  });

  it('la tarjeta vale hasta el ultimo dia del mes impreso', () => {
    // Agosto de 2026 es el mes en curso segun AHORA: todavia sirve.
    expect(evaluarTarjeta(tarjeta({ expMonth: 8, expYear: 2026 }), AHORA).approved).toBe(true);
    // Julio de 2026 ya paso.
    expect(evaluarTarjeta(tarjeta({ expMonth: 7, expYear: 2026 }), AHORA).reason).toBe(
      MotivoDeRechazo.expired_card,
    );
  });

  it('aprueba cualquier otra tarjeta estructuralmente valida', () => {
    // Los seeds y las pruebas manuales no tienen que memorizar numeros.
    expect(evaluarTarjeta(tarjeta({ number: '5555555555554444' }), AHORA).approved).toBe(true);
  });
});
