import { montoLiteral } from './amount-in-words';

describe('Importe literal del recibo', () => {
  it.each([
    [0, 'Cero 00/100'],
    [1, 'Cero 01/100'],
    [15050, 'Ciento cincuenta 50/100'],
    [10000, 'Cien 00/100'],
    [22699, 'Doscientos veintiséis 99/100'],
    [2100000, 'Veintiún mil 00/100'],
    [100000000, 'Un millón 00/100'],
    [
      2147483647,
      'Veintiún millones cuatrocientos setenta y cuatro mil ochocientos treinta y seis 47/100',
    ],
  ])('%i centavos → %s', (amount, expected) => expect(montoLiteral(amount)).toBe(expected));

  it.each([-1, 1.5, NaN, Infinity, 2147483648])('rechaza %s sin inventar un importe', (amount) => {
    expect(() => montoLiteral(amount)).toThrow();
  });
});
