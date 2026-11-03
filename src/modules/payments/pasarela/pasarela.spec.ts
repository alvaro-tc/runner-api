import { aCentavos, aMonto } from './pasarela.client';

describe('montos de la pasarela', () => {
  it('convierte texto a centavos sin float', () => {
    expect(aCentavos('150.01')).toBe(15001);
    expect(aCentavos('10')).toBe(1000);
    expect(aCentavos('10.5')).toBe(1050);
    expect(aCentavos('0.07')).toBe(7);
  });

  it('convierte centavos a texto', () => {
    expect(aMonto(15001)).toBe('150.01');
    expect(aMonto(1000)).toBe('10.00');
    expect(aMonto(7)).toBe('0.07');
  });
});
