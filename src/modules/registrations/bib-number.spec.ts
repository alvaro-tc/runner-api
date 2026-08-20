import { armarDorsal, prefijoDorsal } from './bib-number';

describe('prefijoDorsal', () => {
  it('toma las iniciales de las palabras del nombre', () => {
    expect(prefijoDorsal('Maraton La Paz 3600')).toBe('MLP');
    expect(prefijoDorsal('Media Maraton Santa Cruz')).toBe('MMS');
  });

  it('no se come el articulo de un nombre propio', () => {
    // "La" de "La Paz" es parte del nombre de la ciudad, no un articulo suelto.
    expect(prefijoDorsal('Maraton La Paz 3600')).toContain('L');
  });

  it('ignora los conectores', () => {
    expect(prefijoDorsal('Carrera de los Andes')).toBe('CLA');
  });

  it('completa con letras de la primera palabra cuando las iniciales no alcanzan', () => {
    expect(prefijoDorsal('Nocturna')).toBe('NOC');
    expect(prefijoDorsal('Ruta 5K')).toBe('RUT');
    expect(prefijoDorsal('Maraton Potosi')).toBe('MAR');
  });

  it('quita los acentos: un dorsal con tilde rompe todo lo que venga despues', () => {
    expect(prefijoDorsal('Maratón Potosí')).toBe('MAR');
    expect(prefijoDorsal('Ñuflo Tarija Sucre')).toBe('NTS');
  });

  it('cae a un prefijo por defecto si el nombre no tiene letras', () => {
    expect(prefijoDorsal('10 20 30')).toBe('RUN');
    expect(prefijoDorsal('')).toBe('RUN');
  });

  it('siempre devuelve exactamente tres caracteres', () => {
    for (const nombre of ['A', 'Ab', 'Maraton La Paz 3600', '', '5K', 'de del y']) {
      expect(prefijoDorsal(nombre)).toHaveLength(3);
    }
  });
});

describe('armarDorsal', () => {
  it('rellena el correlativo a cuatro digitos', () => {
    expect(armarDorsal('Maraton La Paz 3600', 1)).toBe('MLP-0001');
    expect(armarDorsal('Maraton La Paz 3600', 742)).toBe('MLP-0742');
  });

  it('deja crecer el numero antes que rechazar una inscripcion', () => {
    expect(armarDorsal('Maraton La Paz 3600', 12_345)).toBe('MLP-12345');
  });
});
