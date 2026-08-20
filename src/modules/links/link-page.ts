/**
 * Pagina HTML de un enlace profundo. Funcion pura, sin Nest ni base de datos.
 *
 * La pagina hace dos trabajos que parecen uno solo:
 *
 * 1. **Dar metadatos Open Graph** a quien la rasca — WhatsApp, Facebook,
 *    Telegram, iMessage — para que la previsualizacion del mensaje muestre la
 *    carrera y no una URL pelada. Esos bots **no ejecutan JavaScript**, asi que
 *    todo lo que importa vive en el `<head>`.
 * 2. **Llevar a la app** a quien la abre de verdad.
 *
 * Por eso el salto a la app se hace desde JavaScript y no con un `302` del
 * servidor: un redirect del lado servidor dejaria al bot sin metadatos que
 * leer, y la previsualizacion quedaria en blanco. Es el mismo motivo por el que
 * tampoco se usa `<meta http-equiv="refresh">`.
 */

export interface DatosDeEnlace {
  /** URL del esquema propio: `paceup://marathon/la-paz-21k`. `null` cuando no
   *  hay nada que abrir (pagina de error): sin destino no hay salto ni boton. */
  deepLink: string | null;
  /** URL canonica de esta misma pagina. */
  canonical: string;
  /**
   * Nonce de la CSP de esta respuesta. El `<style>` y el `<script>` de la
   * pagina son inline, y la CSP que pone helmet solo admite `'self'`: sin
   * nonce el navegador bloquea los dos y queda una pagina sin estilo que
   * ademas no salta a la app. Uno nuevo por peticion; reutilizarlo lo
   * convertiria en una lista blanca permanente.
   */
  nonce: string;
  title: string;
  description: string;
  /** Imagen de previsualizacion, absoluta. `null` = sin imagen. */
  imageUrl: string | null;
  appStoreUrl?: string | undefined;
  playStoreUrl?: string | undefined;
}

/**
 * Escapa texto para que sea seguro dentro de un atributo o de un nodo.
 *
 * Se escapan tambien las comillas simples y dobles porque el mismo valor se usa
 * en `content="..."` y en el cuerpo: una sola funcion, sin tener que acordarse
 * de cual contexto es cual. Casi nada de lo que llega aqui lo escribe un
 * usuario, pero el nombre de una maraton lo teclea un organizador en el panel,
 * y esa es exactamente la clase de dato del que uno se olvida.
 */
export function escapar(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function paginaDeEnlace(datos: DatosDeEnlace): string {
  const t = escapar(datos.title);
  const d = escapar(datos.description);
  const canonical = escapar(datos.canonical);
  const nonce = escapar(datos.nonce);

  const imagen = datos.imageUrl
    ? `\n    <meta property="og:image" content="${escapar(datos.imageUrl)}">` +
      `\n    <meta name="twitter:card" content="summary_large_image">`
    : `\n    <meta name="twitter:card" content="summary">`;

  const tiendas = [
    datos.appStoreUrl ? boton(datos.appStoreUrl, 'App Store', 'secundario') : '',
    datos.playStoreUrl ? boton(datos.playStoreUrl, 'Google Play', 'secundario') : '',
  ].join('');

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${t}</title>
    <link rel="canonical" href="${canonical}">
    <meta name="description" content="${d}">
    <meta property="og:site_name" content="PaceUp">
    <meta property="og:type" content="website">
    <meta property="og:locale" content="es_BO">
    <meta property="og:title" content="${t}">
    <meta property="og:description" content="${d}">
    <meta property="og:url" content="${canonical}">${imagen}
    <style nonce="${nonce}">
      :root { color-scheme: light dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: Canvas; color: CanvasText; padding: 24px;
      }
      main { max-width: 32rem; text-align: center; }
      h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 .5rem; }
      p { margin: 0 0 1.5rem; opacity: .8; }
      a { display: inline-block; margin: 0 .25rem .5rem; padding: .75rem 1.5rem;
          border-radius: .5rem; text-decoration: none; font-weight: 600; }
      .principal { background: #16a34a; color: #fff; }
      .secundario { border: 1px solid currentColor; }
    </style>
  </head>
  <body>
    <main>
      <h1>${t}</h1>
      <p>${d}</p>
      ${datos.deepLink ? boton(datos.deepLink, 'Abrir en PaceUp', 'principal') : ''}${tiendas}
    </main>${datos.deepLink ? salto(datos.deepLink, nonce) : ''}
  </body>
</html>
`;
}

/**
 * El salto a la app. Un solo intento, y solo si la pagina se abrio de frente:
 * al volver atras desde la app el navegador la restaura desde su cache, y
 * reintentar ahi dejaria al usuario en un bucle del que no puede salir.
 *
 * El `<` se escapa a `\u003c` porque `JSON.stringify` no sabe nada de HTML: un
 * `</script>` dentro de la cadena cerraria el bloque y lo que viniera despues
 * seria markup.
 */
function salto(deepLink: string, nonce: string): string {
  const literal = JSON.stringify(deepLink).replace(/</g, '\\u003c');

  return `
    <script nonce="${nonce}">
      var nav = performance.getEntriesByType('navigation')[0];
      if (!nav || nav.type === 'navigate') location.href = ${literal};
    </script>`;
}

function boton(href: string, texto: string, clase: string): string {
  return `<a class="${clase}" href="${escapar(href)}">${escapar(texto)}</a>`;
}

/** Pagina de "esto no existe". Sin metadatos ricos: no hay nada que previsualizar. */
export function paginaNoEncontrada(canonical: string, nonce: string): string {
  return paginaDeEnlace({
    nonce,
    // Sin destino: saltar a la app para mostrarle un 404 no le sirve a nadie, y
    // apuntar el salto a esta misma pagina seria un bucle de recargas.
    deepLink: null,
    canonical,
    title: 'Este enlace ya no existe',
    description:
      'La carrera, el entrenamiento o el resultado que buscabas no esta disponible. Puede que se ' +
      'haya borrado o que el enlace este incompleto.',
    imageUrl: null,
  });
}
