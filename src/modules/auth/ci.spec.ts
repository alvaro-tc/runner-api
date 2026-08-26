import { esCiValida, esEmail, normalizarCi } from './ci';

describe('normalizarCi', () => {
  it('trata como la misma CI las formas en que se teclea el mismo documento', () => {
    const formas = ['1234567 LP', '1234567-lp', ' 1234567.LP ', '1234567lp'];

    expect(new Set(formas.map(normalizarCi)).size).toBe(1);
    expect(normalizarCi('1234567 LP')).toBe('1234567LP');
  });

  it('acepta una CI sin extension', () => {
    expect(esCiValida('1234567')).toBe(true);
    expect(esCiValida('1234567 LP')).toBe(true);
  });

  it('rechaza lo que no es una CI', () => {
    expect(esCiValida('')).toBe(false);
    expect(esCiValida('abc')).toBe(false);
    expect(esCiValida('runner@test.com')).toBe(false);
  });

  it('distingue email de CI por el @, sin tocar la base', () => {
    expect(esEmail('runner@test.com')).toBe(true);
    expect(esEmail('1234567 LP')).toBe(false);
  });
});
