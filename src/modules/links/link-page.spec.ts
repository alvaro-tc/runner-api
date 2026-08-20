import { escapar, paginaDeEnlace, paginaNoEncontrada } from './link-page';

/**
 * Lo que importa de esta pagina no es como se ve, sino que no se pueda inyectar
 * markup por el nombre de una maraton y que no entre en un bucle de recargas.
 */
describe('paginaDeEnlace', () => {
  const base = {
    deepLink: 'paceup://marathon/la-paz-21k',
    canonical: 'https://api.paceup.bo/api/v1/links/marathon/la-paz-21k',
    title: 'Media Maratón de La Paz',
    description: '21 K en La Paz.',
    imageUrl: null,
    nonce: 'n0nce',
  };

  it('escapa el markup que venga en el titulo', () => {
    const html = paginaDeEnlace({ ...base, title: '<img src=x onerror="alert(1)">' });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('escapa las comillas dentro de los metadatos Open Graph', () => {
    const html = paginaDeEnlace({ ...base, description: 'Carrera "nocturna" de La Paz' });

    expect(html).toContain('content="Carrera &quot;nocturna&quot; de La Paz"');
  });

  it('no deja que un deep link cierre el bloque de script', () => {
    const html = paginaDeEnlace({ ...base, deepLink: 'paceup://x</script><script>alert(1)' });

    // Solo el `<script nonce>` de la pagina; ninguno inyectado.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('\\u003c/script');
  });

  it('pone el nonce en el estilo y en el script, para que la CSP los deje pasar', () => {
    const html = paginaDeEnlace(base);

    expect(html).toContain('<style nonce="n0nce">');
    expect(html).toContain('<script nonce="n0nce">');
  });

  it('sin imagen usa la tarjeta chica; con imagen, la grande', () => {
    expect(paginaDeEnlace(base)).toContain('name="twitter:card" content="summary"');

    const conImagen = paginaDeEnlace({ ...base, imageUrl: 'https://cdn.test/portada.jpg' });
    expect(conImagen).toContain('property="og:image" content="https://cdn.test/portada.jpg"');
    expect(conImagen).toContain('summary_large_image');
  });

  it('solo pinta los botones de tienda que estan configurados', () => {
    const html = paginaDeEnlace({ ...base, playStoreUrl: 'https://play.google.com/x' });

    expect(html).toContain('Google Play');
    expect(html).not.toContain('App Store');
  });

  it('la pagina de "no existe" no salta a ningun lado', () => {
    const html = paginaNoEncontrada(base.canonical, base.nonce);

    // Sin script no hay bucle: apuntar el salto a esta misma URL recargaria en
    // redondo, y saltar a la app para mostrar un 404 no le sirve a nadie.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('Abrir en PaceUp');
  });
});

describe('escapar', () => {
  it('escapa el ampersand primero, sin doble escape', () => {
    expect(escapar('Trail & Running <2026>')).toBe('Trail &amp; Running &lt;2026&gt;');
  });
});
