/**
 * El panel de administracion, en un archivo.
 *
 * Es una pagina sin dependencias: nada de React, nada de bundler, nada de paso
 * de build. Todo lo que hace es pedir un token a `/api/v1/auth/login` y llamar a
 * `/api/v1/admin/*`, que es donde vive la logica de verdad. Cambiarla es editar
 * este string y recargar.
 *
 * Va como plantilla de TypeScript y no como `.html` a proposito: asi entra en
 * `dist/` con el resto del codigo y no hay que tocar la configuracion de assets
 * del build para que el panel exista en produccion.
 *
 * El `nonce` lo genera el controlador en cada peticion y marca el `<style>` y el
 * `<script>` como autorizados en la CSP. Sin el, helmet —que sirve una CSP con
 * `script-src 'self'`— bloquea el script de la pagina y el panel se queda en un
 * documento inerte: sin pestanas, sin login, sin nada.
 */
export function panelHtml(nonce: string): string {
  return String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PaceUp · Administración</title>
<style nonce="${nonce}">
  :root { --bg:#0f172a; --panel:#1e293b; --line:#334155; --text:#e2e8f0; --muted:#94a3b8;
          --accent:#38bdf8; --ok:#4ade80; --bad:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui, sans-serif; }
  header { display:flex; align-items:center; gap:16px; padding:12px 20px; background:var(--panel);
           border-bottom:1px solid var(--line); position:sticky; top:0; z-index:2; }
  header h1 { font-size:16px; margin:0; }
  header .who { margin-left:auto; color:var(--muted); font-size:13px; }
  nav { display:flex; gap:4px; padding:10px 20px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  nav button { background:transparent; border:1px solid transparent; color:var(--muted);
               padding:6px 12px; border-radius:6px; cursor:pointer; font-size:14px; }
  nav button.on { background:var(--panel); color:var(--accent); border-color:var(--line); }
  main { padding:20px; max-width:1200px; }
  h2 { font-size:15px; margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; white-space:nowrap; }
  .wrap { overflow-x:auto; border:1px solid var(--line); border-radius:8px; }
  button.act { background:var(--panel); border:1px solid var(--line); color:var(--text);
               padding:4px 9px; border-radius:5px; cursor:pointer; font-size:12px; margin:1px; }
  button.act:hover { border-color:var(--accent); color:var(--accent); }
  input, select, textarea { background:var(--bg); border:1px solid var(--line); color:var(--text);
                            padding:7px 9px; border-radius:6px; font:inherit; }
  textarea { width:100%; min-height:130px; font-family:ui-monospace, monospace; font-size:12px; }
  form.card, section.card { background:var(--panel); border:1px solid var(--line);
                            border-radius:8px; padding:16px; margin-bottom:16px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:end; margin-bottom:10px; }
  label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .muted { color:var(--muted); }
  #flash { position:fixed; right:16px; bottom:16px; background:var(--panel); border:1px solid var(--line);
           border-radius:8px; padding:10px 14px; max-width:420px; display:none; }
  #login { max-width:340px; margin:80px auto; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px;
        overflow-x:auto; font-size:12px; }
</style>
</head>
<body>

<div id="login" class="card" style="display:none">
  <h2>Entrar como administrador</h2>
  <form id="loginForm">
    <div class="row"><label style="flex:1">Email<input id="email" type="email" required></label></div>
    <div class="row"><label style="flex:1">Contraseña<input id="password" type="password" required></label></div>
    <button class="act" type="submit">Entrar</button>
  </form>
  <p class="muted" id="loginError"></p>
</div>

<div id="app" style="display:none">
  <header>
    <h1>PaceUp · Administración</h1>
    <span class="who" id="who"></span>
    <button class="act" id="logout">Salir</button>
  </header>
  <nav id="tabs"></nav>
  <main id="view"></main>
</div>

<div id="flash"></div>

<script nonce="${nonce}">
const API = '/api/v1';
let token = sessionStorage.getItem('paceup_admin_token') || '';

// ─── Utilidades ──────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const bs = (cents) => 'Bs ' + (cents / 100).toFixed(2).replace('.', ',');
const fecha = (iso) => iso ? new Date(iso).toLocaleString('es-BO') : '';

function flash(msg, malo) {
  const el = $('#flash');
  el.innerHTML = '<span class="' + (malo ? 'bad' : 'ok') + '">' + esc(msg) + '</span>';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

/**
 * Confirmacion para lo que no tiene vuelta atras.
 *
 * Solo delante de un borrado: un panel que pregunta por todo entrena a quien lo
 * usa a darle a "aceptar" sin leer, y entonces ya no protege del borrado que
 * importa.
 */
function confirmar(mensaje) {
  return window.confirm(mensaje);
}

/** Toda llamada pasa por aqui: un solo sitio que pone el token y desenvuelve. */
async function api(ruta, opciones = {}) {
  const res = await fetch(API + ruta, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opciones.headers || {}),
    },
  });

  if (res.status === 401) { salir(); throw new Error('Sesión caducada'); }

  const cuerpo = await res.json().catch(() => null);
  if (!res.ok) throw new Error(cuerpo?.error?.message || ('Error ' + res.status));

  return cuerpo?.data;
}

/** Como api(), pero para multipart: el navegador pone el boundary solo. */
async function subirArchivo(ruta, file) {
  const cuerpo = new FormData();
  cuerpo.append('file', file);

  const res = await fetch(API + ruta, {
    method: 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body: cuerpo,
  });

  if (res.status === 401) { salir(); throw new Error('Sesión caducada'); }

  const respuesta = await res.json().catch(() => null);
  if (!res.ok) throw new Error(respuesta?.error?.message || ('Error ' + res.status));

  return respuesta?.data;
}

function tabla(columnas, filas, celda) {
  if (!filas.length) return '<p class="muted">No hay nada que mostrar.</p>';
  const cabecera = columnas.map((c) => '<th>' + esc(c) + '</th>').join('');
  const cuerpo = filas.map((f) => '<tr>' + celda(f).map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('');
  return '<div class="wrap"><table><thead><tr>' + cabecera + '</tr></thead><tbody>' + cuerpo + '</tbody></table></div>';
}

// ─── Sesión ──────────────────────────────────────────────────────────────────

async function entrar(identifier, password) {
  const res = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password, deviceId: 'admin-panel' }),
  });
  const cuerpo = await res.json();
  if (!res.ok) throw new Error(cuerpo?.error?.message || 'No se pudo entrar');
  if (cuerpo.data.user.role !== 'admin') throw new Error('Esa cuenta no es de administrador');

  token = cuerpo.data.accessToken;
  sessionStorage.setItem('paceup_admin_token', token);
  $('#who').textContent = cuerpo.data.user.email;

  arrancar();
}

function salir() {
  token = '';
  sessionStorage.removeItem('paceup_admin_token');
  $('#app').style.display = 'none';
  $('#login').style.display = 'block';
}

// ─── Pestañas ────────────────────────────────────────────────────────────────

const PESTANAS = [
  ['Maratones', vistaMaratones],
  ['Recorridos', vistaRecorridos],
  ['Cargo por servicio', vistaFee],
  ['Transferencias', vistaTransferencias],
  // TEMPORAL - cobro por QR manual. Ver docs/pago-qr-manual.md
  ['Comprobantes QR', vistaComprobantes],
  ['Inscripciones', vistaInscripciones],
  ['Resultados', vistaResultados],
  ['Usuarios', vistaUsuarios],
];

let actual = 0;

/**
 * El manejador de clics de la vista que este pintada.
 *
 * Uno solo, colgado del contenedor y no de cada boton: la tabla se repinta
 * entera despues de cada accion, y volver a enganchar un listener por fila
 * significaria acumular uno encima de otro hasta que un clic dispara la accion
 * cinco veces.
 */
let manejadorClic = null;

$('#view').addEventListener('click', (ev) => { if (manejadorClic) manejadorClic(ev); });

function pintarTabs() {
  $('#tabs').innerHTML = PESTANAS
    .map(([nombre], i) => '<button class="' + (i === actual ? 'on' : '') + '" data-i="' + i + '">' + nombre + '</button>')
    .join('');
}

async function abrir(i) {
  actual = i;
  pintarTabs();
  await pintar(PESTANAS[i][1]);
}

/** Pinta una vista en el contenedor, soltando antes el manejador de la anterior. */
async function pintar(vista, ...args) {
  manejadorClic = null;
  $('#view').innerHTML = '<p class="muted">Cargando…</p>';
  try { await vista(...args); } catch (e) { $('#view').innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
}

// ─── Maratones ───────────────────────────────────────────────────────────────

async function vistaMaratones() {
  const maratones = await api('/admin/marathons');

  $('#view').innerHTML =
    '<h2>Maratones (' + maratones.length + ')</h2>' +
    '<div class="row"><button class="act" data-accion="nueva">+ Nueva maratón</button></div>' +
    tabla(
      ['Maratón', 'Largada', 'Cupos', 'Estado', 'Publicada', 'Cargo', 'Acciones'],
      maratones,
      (m) => [
        '<strong>' + esc(m.name) + '</strong><br><span class="muted">' + esc(m.city) + ' · ' + esc(m.slug) + '</span>',
        fecha(m.startsAt),
        m.slotsTaken + ' / ' + m.capacity,
        esc(m.resolved) + (m.intent !== m.resolved ? '<br><span class="muted">declarado: ' + esc(m.intent) + '</span>' : ''),
        m.published ? '<span class="ok">sí</span>' : '<span class="muted">borrador</span>',
        m.feeOverride ? (m.feeOverride.enabled ? 'propio' : '<span class="bad">exenta</span>') : '<span class="muted">global</span>',
        [
          boton('Editar', 'editar', m.id),
          boton(m.published ? 'Despublicar' : 'Publicar', 'publicar', m.id),
          boton(m.resolved === 'closed' ? 'Reabrir' : 'Cerrar inscr.', 'cerrar', m.id),
          boton('CSV inscritos', 'csv', m.id),
          boton('Recalcular puestos', 'ranks', m.id),
          m.feeOverride ? boton('Quitar cargo propio', 'quitarFee', m.id) : boton('Eximir del cargo', 'eximir', m.id),
        ].join(''),
      ],
    );

  manejadorClic = async (ev) => {
    const b = ev.target.closest('button[data-accion]');
    if (!b) return;

    const id = b.dataset.id;
    const maraton = maratones.find((m) => m.id === id);

    try {
      if (b.dataset.accion === 'nueva') { pintar(vistaEditorMaraton, null); return; }
      if (b.dataset.accion === 'editar') { pintar(vistaEditorMaraton, id); return; }
      if (b.dataset.accion === 'publicar') {
        await api('/admin/marathons/' + id + (maraton.published ? '/unpublish' : '/publish'), { method: 'POST' });
        flash(maraton.published ? 'Sacada del catálogo' : 'Publicada');
      }
      if (b.dataset.accion === 'cerrar') {
        const cerrada = maraton.resolved === 'closed';
        await api('/admin/marathons/' + id + (cerrada ? '/reopen-registrations' : '/close-registrations'), { method: 'POST' });
        flash(cerrada ? 'Inscripciones reabiertas' : 'Inscripciones cerradas');
      }
      if (b.dataset.accion === 'ranks') {
        const r = await api('/admin/marathons/' + id + '/recalculate-ranks', { method: 'POST' });
        flash('Puestos recalculados sobre ' + r.results + ' resultados');
      }
      if (b.dataset.accion === 'eximir') {
        await api('/admin/marathons/' + id + '/service-fee', {
          method: 'PUT',
          body: JSON.stringify({ enabled: false, type: 'percent' }),
        });
        flash('Esta carrera ya no cobra cargo por servicio');
      }
      if (b.dataset.accion === 'quitarFee') {
        await api('/admin/marathons/' + id + '/service-fee', { method: 'DELETE' });
        flash('Vuelve a la configuración global');
      }
      if (b.dataset.accion === 'csv') { await descargarCsv(id); return; }

      abrir(actual);
    } catch (e) { flash(e.message, true); }
  };
}

function boton(texto, accion, id) {
  return '<button class="act" data-accion="' + accion + '" data-id="' + id + '">' + texto + '</button>';
}

// ─── Recorridos ──────────────────────────────────────────────────────────────

/**
 * Los trazados que despues eligen las maratones.
 *
 * La distancia **no se pide**: se mide sobre la geometria al guardar. Un campo
 * de distancia aqui seria una invitacion a escribir 42195 junto a un trazado de
 * 38 km, y quien corre sigue el mapa, no el numero.
 */
async function vistaRecorridos() {
  const recorridos = await api('/admin/routes');

  $('#view').innerHTML =
    '<h2>Recorridos (' + recorridos.length + ')</h2>' +
    '<form class="card" id="rutaForm">' +
      '<div class="row">' +
        '<label>Nombre *<input id="rName" required style="min-width:240px"></label>' +
        '<label>Ciudad *<input id="rCity" required></label>' +
        '<label>Desnivel + (m)<input id="rElev" type="number" min="0" style="width:120px"></label>' +
      '</div>' +
      '<div class="row"><label style="flex:1">Descripción<input id="rDesc" style="min-width:280px"></label></div>' +
      '<div class="row"><label style="flex:1">GeoJSON del trazado *' +
        '<textarea id="rGeo" required style="min-height:120px"></textarea>' +
      '</label></div>' +
      '<button class="act" type="submit">Cargar recorrido</button>' +
      '<span class="muted"> · LineString con pares [lng, lat], por ejemplo ' +
        esc('{"type":"LineString","coordinates":[[-68.13,-16.50],[-68.12,-16.51]]}') +
        '. La distancia se mide sola sobre la geometría.</span>' +
    '</form>' +
    tabla(
      ['Recorrido', 'Ciudad', 'Distancia', 'Desnivel', 'Estado', 'Acciones'],
      recorridos,
      (r) => [
        '<strong>' + esc(r.name) + '</strong><br><span class="muted">' + esc(r.slug) + '</span>',
        esc(r.city),
        (r.distanceMeters / 1000).toFixed(2) + ' km',
        r.elevationGainMeters === null ? '<span class="muted">—</span>' : r.elevationGainMeters + ' m',
        r.archived ? '<span class="muted">archivado</span>' : '<span class="ok">disponible</span>',
        [
          boton(r.archived ? 'Desarchivar' : 'Archivar', 'archivar', r.id),
          boton('Borrar', 'borrarRuta', r.id),
        ].join(''),
      ],
    );

  $('#rutaForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const texto = (campoId) => $('#' + campoId).value.trim();

    let geoJson;
    try {
      geoJson = JSON.parse(texto('rGeo'));
    } catch {
      flash('El GeoJSON no es JSON válido', true);
      return;
    }

    try {
      const creado = await api('/admin/routes', {
        method: 'POST',
        body: JSON.stringify({
          name: texto('rName'),
          city: texto('rCity'),
          description: texto('rDesc') || undefined,
          elevationGainMeters: texto('rElev') === '' ? undefined : Number(texto('rElev')),
          geoJson,
        }),
      });
      flash('Recorrido cargado: ' + (creado.distanceMeters / 1000).toFixed(2) + ' km medidos');
      abrir(actual);
    } catch (e) { flash(e.message, true); }
  });

  manejadorClic = async (ev) => {
    const b = ev.target.closest('button[data-accion]');
    if (!b) return;

    const ruta = recorridos.find((r) => r.id === b.dataset.id);

    try {
      if (b.dataset.accion === 'archivar') {
        await api('/admin/routes/' + ruta.id, {
          method: 'PUT',
          body: JSON.stringify({ archived: !ruta.archived }),
        });
        flash(ruta.archived ? 'Vuelve a estar disponible' : 'Archivado');
      }
      if (b.dataset.accion === 'borrarRuta') {
        if (!confirm('¿Borrar ' + ruta.name + '?')) return;
        await api('/admin/routes/' + ruta.id, { method: 'DELETE' });
        flash('Recorrido borrado');
      }
      abrir(actual);
    } catch (e) { flash(e.message, true); }
  };
}

/**
 * Alta y edicion de una maraton, con sus categorias y sus extras.
 *
 * Con el id en null es un alta; con id, una edicion cargada desde
 * /admin/marathons/:id. Es el mismo formulario en los dos casos a proposito:
 * dos pantallas distintas para crear y para editar acaban divergiendo y con un
 * campo que solo se puede poner al crear.
 *
 * Las categorias y los extras solo aparecen al editar: hasta que la maraton no
 * existe no hay a que colgarlos. Por eso el alta, al guardar, no vuelve a la
 * lista sino que reabre esta misma pantalla ya en modo edicion.
 */
async function vistaEditorMaraton(id) {
  const m = id ? await api('/admin/marathons/' + id) : null;
  // Los recorridos preestablecidos son el punto de partida de una carrera: se
  // elige uno y la maraton copia su trazado y su distancia medida.
  const recorridos = await api('/admin/routes?includeArchived=false');
  const v = (x) => (x === null || x === undefined ? '' : x);

  // El <input datetime-local> habla en hora local del navegador y la API en
  // UTC: sin corregir el desfase, guardar sin tocar la fecha la movería.
  const paraInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const campo = (id_, etiqueta, valor, extra) =>
    '<label>' + etiqueta + '<input id="' + id_ + '" value="' + esc(valor) + '" ' + (extra || '') + '></label>';

  $('#view').innerHTML =
    '<div class="row"><button class="act" data-accion="volver">← Maratones</button></div>' +
    '<h2>' + (m ? 'Editar ' + esc(m.name) : 'Nueva maratón') + '</h2>' +
    '<form class="card" id="marForm">' +
      '<div class="row">' +
        campo('name', 'Nombre *', v(m?.name), 'required style="min-width:260px"') +
        campo('slug', 'Slug', v(m?.slug), 'placeholder="se deriva del nombre"') +
      '</div>' +
      '<div class="row">' +
        campo('startsAt', 'Largada *', paraInput(m?.startsAt), 'type="datetime-local" required') +
        campo('timezone', 'Zona horaria', v(m?.timezone) || 'America/La_Paz') +
        campo('registrationClosesAt', 'Cierre de inscripciones', paraInput(m?.registrationClosesAt), 'type="datetime-local"') +
      '</div>' +
      '<div class="row">' +
        campo('city', 'Ciudad *', v(m?.city), 'required') +
        campo('country', 'País', v(m?.country) || 'BO', 'maxlength="2" style="width:70px"') +
        campo('lat', 'Latitud', v(m?.lat), 'type="number" step="any" style="width:120px"') +
        campo('lng', 'Longitud', v(m?.lng), 'type="number" step="any" style="width:120px"') +
      '</div>' +
      '<div class="row">' +
        '<label style="flex:1">Recorrido preestablecido<select id="routeId">' +
          '<option value="">— sin recorrido (distancia a mano) —</option>' +
          recorridos.map((r) =>
            '<option value="' + esc(r.id) + '"' + (m?.routeId === r.id ? ' selected' : '') + '>' +
              esc(r.name) + ' · ' + esc(r.city) + ' · ' + (r.distanceMeters / 1000).toFixed(1) + ' km' +
            '</option>').join('') +
        '</select></label>' +
        '<span class="muted">al elegir uno, la distancia y el trazado salen de él</span>' +
      '</div>' +
      '<div class="row">' +
        campo('distanceMeters', 'Distancia (m)', v(m?.distanceMeters), 'type="number" min="1" style="width:130px"') +
        campo('capacity', 'Cupos *', v(m?.capacity), 'type="number" min="1" required style="width:110px"') +
        campo('priceCents', 'Precio (centavos) *', v(m?.priceCents), 'type="number" min="0" required style="width:150px"') +
        campo('currency', 'Moneda', v(m?.currency) || 'BOB', 'maxlength="3" style="width:80px"') +
        '<label>Publicada<select id="published">' +
          '<option value="false"' + (m?.published ? '' : ' selected') + '>borrador</option>' +
          '<option value="true"' + (m?.published ? ' selected' : '') + '>sí</option>' +
        '</select></label>' +
      '</div>' +
      '<div class="row">' +
        campo(
          'paymentQrInstructions',
          'Instrucciones del QR',
          v(m?.paymentQrInstructions),
          'style="min-width:280px"',
        ) +
        campo('includes', 'Incluye (separado por comas)', (m?.includes || []).join(', '), 'style="min-width:280px"') +
      '</div>' +
      '<div class="row"><label style="flex:1">Descripción<textarea id="description" style="min-height:80px">' + esc(v(m?.description)) + '</textarea></label></div>' +
      // TEMPORAL - cobro por QR manual. Ver docs/pago-qr-manual.md.
      // Es TEXTO y no una imagen: la app dibuja el código ella misma, así que
      // sale nítido a cualquier tamaño y el checkout no arrastra un PNG.
      // Sin esto la maratón NO admite el pago por QR: se dice aquí y no en un
      // error del corredor tres pantallas más tarde.
      '<div class="row"><label style="flex:1">Texto del QR de cobro' +
        '<textarea id="paymentQrPayload" style="min-height:80px" placeholder="Pega aquí el contenido del QR que exporta tu banca móvil">' +
          esc(v(m?.paymentQrPayload)) +
        '</textarea></label></div>' +
      '<span class="muted">' +
        (m && m.paymentQrPayload
          ? 'Cargado: esta maratón admite el pago por QR.'
          : 'Vacío: esta maratón NO admite el pago por QR y el checkout lo rechaza.') +
        ' · Exportá el QR desde tu banca móvil y pegá el texto que devuelve.' +
      '</span>' +
      '<button class="act" type="submit">' + (m ? 'Guardar cambios' : 'Crear maratón') + '</button>' +
      (m ? ' <button class="act" type="button" data-accion="borrarMaraton">Borrar maratón</button>' : '') +
      '<span class="muted"> · el precio va en centavos: Bs 250,00 son 25000</span>' +
    '</form>' +
    (m ? bloqueAfiche(m) + bloqueQr(m) : '') +
    (m ? bloqueCategorias(m) + bloqueExtras(m) : '<p class="muted">Las categorías y los adicionales se cargan una vez creada la maratón.</p>');

  $('#marForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();

    const texto = (campoId) => $('#' + campoId).value.trim();
    // Un campo vacio es "sin valor", no cero ni cadena vacia: mandar 0 en la
    // latitud pondria la carrera en el golfo de Guinea.
    const numero = (campoId) => (texto(campoId) === '' ? null : Number(texto(campoId)));
    const enUtc = (campoId) => (texto(campoId) === '' ? null : new Date(texto(campoId)).toISOString());

    const cuerpo = {
      name: texto('name'),
      startsAt: enUtc('startsAt'),
      timezone: texto('timezone') || undefined,
      city: texto('city'),
      country: texto('country') || undefined,
      lat: numero('lat'),
      lng: numero('lng'),
      distanceMeters: numero('distanceMeters'),
      // Vacio = desvincular. La API distingue "no vino el campo" de "ponlo a
      // null", y aqui el select siempre viene: mandarlo siempre es lo correcto.
      routeId: $('#routeId').value || null,
      capacity: numero('capacity'),
      priceCents: numero('priceCents'),
      currency: texto('currency') || undefined,
      registrationClosesAt: enUtc('registrationClosesAt'),
      paymentQrInstructions: texto('paymentQrInstructions') || null,
      paymentQrPayload: texto('paymentQrPayload') || null,
      description: texto('description') || null,
      includes: texto('includes') ? texto('includes').split(',').map((x) => x.trim()).filter(Boolean) : [],
      published: $('#published').value === 'true',
    };

    // El slug vacio significa "derivalo del nombre", y eso solo vale al crear:
    // en una edicion, mandarlo vacio seria pedir que cambie el de una carrera
    // que ya se compartio por WhatsApp.
    if (texto('slug')) cuerpo.slug = texto('slug');

    try {
      if (m) {
        await api('/admin/marathons/' + m.id, { method: 'PUT', body: JSON.stringify(cuerpo) });
        flash('Maratón guardada');
        pintar(vistaEditorMaraton, m.id);
      } else {
        const creada = await api('/admin/marathons', { method: 'POST', body: JSON.stringify(cuerpo) });
        flash('Maratón creada como ' + creada.slug);
        pintar(vistaEditorMaraton, creada.id);
      }
    } catch (e) { flash(e.message, true); }
  });

  const coverInput = $('#coverFile');
  if (coverInput) {
    coverInput.addEventListener('change', async () => {
      const file = coverInput.files[0];
      if (!file) return;

      try {
        await subirArchivo('/admin/marathons/' + m.id + '/cover', file);
        flash('Afiche actualizado');
        pintar(vistaEditorMaraton, m.id);
      } catch (e) { flash(e.message, true); }
    });
  }

  const qrInput = $('#qrFile');
  if (qrInput) {
    qrInput.addEventListener('change', async () => {
      const file = qrInput.files[0];
      if (!file) return;

      try {
        await subirArchivo('/admin/marathons/' + m.id + '/qr', file);
        flash('QR actualizado');
        pintar(vistaEditorMaraton, m.id);
      } catch (e) { flash(e.message, true); }
    });
  }

  manejadorClic = async (ev) => {
    const b = ev.target.closest('button[data-accion]');
    if (!b) return;

    try {
      if (b.dataset.accion === 'volver') { abrir(0); return; }

      if (b.dataset.accion === 'borrarMaraton') {
        if (!confirmar('¿Borrar la maratón "' + m.name + '"? Solo se puede si no tiene inscritos.')) return;
        await api('/admin/marathons/' + m.id, { method: 'DELETE' });
        flash('Maratón borrada');
        abrir(0);
        return;
      }

      if (b.dataset.accion === 'nuevaCategoria' || b.dataset.accion === 'guardarCategoria') {
        const catId = b.dataset.id;
        const cuerpo = {
          name: $('[data-cat-name="' + catId + '"]').value.trim(),
          minAge: valorONulo('[data-cat-min="' + catId + '"]'),
          maxAge: valorONulo('[data-cat-max="' + catId + '"]'),
          gender: $('[data-cat-gender="' + catId + '"]').value || null,
          extraPriceCents: Number($('[data-cat-price="' + catId + '"]').value || 0),
        };

        if (catId === 'nueva') {
          await api('/admin/marathons/' + m.id + '/categories', { method: 'POST', body: JSON.stringify(cuerpo) });
        } else {
          await api('/admin/categories/' + catId, { method: 'PUT', body: JSON.stringify(cuerpo) });
        }
        flash('Categoría guardada');
      }

      if (b.dataset.accion === 'borrarCategoria') {
        if (!confirmar('¿Borrar esta categoría? Las inscripciones que la usaban se quedan sin categoría.')) return;
        const r = await api('/admin/categories/' + b.dataset.id, { method: 'DELETE' });
        flash('Categoría borrada' + (r.registrationsWithoutCategory ? ' · ' + r.registrationsWithoutCategory + ' inscripción/es quedaron sin categoría' : ''));
      }

      if (b.dataset.accion === 'nuevoExtra' || b.dataset.accion === 'guardarExtra') {
        const extraId = b.dataset.id;
        const cuerpo = {
          name: $('[data-extra-name="' + extraId + '"]').value.trim(),
          priceCents: Number($('[data-extra-price="' + extraId + '"]').value || 0),
          stock: valorONulo('[data-extra-stock="' + extraId + '"]'),
        };

        if (extraId === 'nuevo') {
          await api('/admin/marathons/' + m.id + '/extras', { method: 'POST', body: JSON.stringify(cuerpo) });
        } else {
          await api('/admin/extras/' + extraId, { method: 'PUT', body: JSON.stringify(cuerpo) });
        }
        flash('Adicional guardado');
      }

      if (b.dataset.accion === 'borrarExtra') {
        if (!confirmar('¿Borrar este adicional? Lo ya vendido no se pierde.')) return;
        await api('/admin/extras/' + b.dataset.id, { method: 'DELETE' });
        flash('Adicional borrado');
      }

      pintar(vistaEditorMaraton, m.id);
    } catch (e) { flash(e.message, true); }
  };
}

/** Un campo numerico vacio es "sin limite" o "sin tope de edad", no cero. */
function valorONulo(selector) {
  const valor = $(selector).value.trim();
  return valor === '' ? null : Number(valor);
}

/**
 * QR de cobro de la maratón. Ver docs/pago-qr-manual.md.
 *
 * El campo de texto libre se cambió por una subida directa: pedirle al
 * organizador que suba la imagen a otro sitio y pegue la URL es un paso de
 * más que solo sirve para que alguien la pegue mal. El seed ya deja un QR
 * genérico por maratón; esto es lo que lo reemplaza por el real.
 */
function bloqueAfiche(m) {
  return (
    '<div class="card">' +
      '<h3>Afiche promocional</h3>' +
      (m.coverUrl
        ? '<img src="' + esc(m.coverUrl) + '" alt="Afiche" style="max-width:280px;border:1px solid #ddd;border-radius:8px">'
        : '<p class="muted">Sin afiche: la app pinta el degradado de marca en su lugar.</p>') +
      '<div class="row"><label>Reemplazar afiche<input id="coverFile" type="file" accept="image/*"></label></div>' +
      '<span class="muted">Se guarda en el servidor y se sirve desde /uploads; ya no se pega un enlace externo.</span>' +
    '</div>'
  );
}

function bloqueQr(m) {
  return (
    '<div class="card">' +
      '<h3>QR de cobro (imagen, respaldo)</h3>' +
      '<p class="muted">Lo que usa la app es el <b>texto del QR</b> de arriba. Esta imagen es solo ' +
        'el respaldo de las maratones que ya la tenían subida.</p>' +
      (m.paymentQrUrl
        ? '<img src="' + esc(m.paymentQrUrl) + '" alt="QR de cobro" style="width:180px;height:180px;object-fit:contain;border:1px solid #ddd;border-radius:8px">'
        : '<p class="muted">Sin QR cargado todavía: se usa el genérico del seed hasta que subas uno.</p>') +
      '<div class="row"><label>Reemplazar QR<input id="qrFile" type="file" accept="image/*"></label></div>' +
      '<span class="muted">Se usa para todos los inscritos que paguen por QR en esta maratón.</span>' +
    '</div>'
  );
}

const GENEROS = ['', 'male', 'female', 'other', 'unspecified'];

function bloqueCategorias(m) {
  const fila = (c) =>
    '<tr>' +
      '<td><input data-cat-name="' + c.id + '" value="' + esc(c.name) + '" style="width:160px"></td>' +
      '<td><input data-cat-min="' + c.id + '" type="number" min="0" value="' + (c.minAge ?? '') + '" style="width:70px"></td>' +
      '<td><input data-cat-max="' + c.id + '" type="number" min="0" value="' + (c.maxAge ?? '') + '" style="width:70px"></td>' +
      '<td><select data-cat-gender="' + c.id + '">' +
        GENEROS.map((g) => '<option value="' + g + '"' + (c.gender === (g || null) ? ' selected' : '') + '>' + (g || 'cualquiera') + '</option>').join('') +
      '</select></td>' +
      '<td><input data-cat-price="' + c.id + '" type="number" min="0" value="' + (c.extraPriceCents ?? 0) + '" style="width:110px"></td>' +
      '<td>' + boton('Guardar', 'guardarCategoria', c.id) + boton('Borrar', 'borrarCategoria', c.id) + '</td>' +
    '</tr>';

  const nueva =
    '<tr>' +
      '<td><input data-cat-name="nueva" placeholder="Nueva categoría" style="width:160px"></td>' +
      '<td><input data-cat-min="nueva" type="number" min="0" style="width:70px"></td>' +
      '<td><input data-cat-max="nueva" type="number" min="0" style="width:70px"></td>' +
      '<td><select data-cat-gender="nueva">' + GENEROS.map((g) => '<option value="' + g + '">' + (g || 'cualquiera') + '</option>').join('') + '</select></td>' +
      '<td><input data-cat-price="nueva" type="number" min="0" value="0" style="width:110px"></td>' +
      '<td>' + boton('Agregar', 'nuevaCategoria', 'nueva') + '</td>' +
    '</tr>';

  return '<section class="card"><h2>Categorías (' + m.categories.length + ')</h2>' +
    '<div class="wrap"><table><thead><tr>' +
      '<th>Nombre</th><th>Edad mín.</th><th>Edad máx.</th><th>Género</th><th>Recargo (centavos)</th><th></th>' +
    '</tr></thead><tbody>' + m.categories.map(fila).join('') + nueva + '</tbody></table></div></section>';
}

function bloqueExtras(m) {
  const fila = (x) =>
    '<tr>' +
      '<td><input data-extra-name="' + x.id + '" value="' + esc(x.name) + '" style="width:200px"></td>' +
      '<td><input data-extra-price="' + x.id + '" type="number" min="0" value="' + x.priceCents + '" style="width:120px"></td>' +
      '<td><input data-extra-stock="' + x.id + '" type="number" min="0" value="' + (x.stock ?? '') + '" placeholder="sin límite" style="width:110px"></td>' +
      '<td>' + boton('Guardar', 'guardarExtra', x.id) + boton('Borrar', 'borrarExtra', x.id) + '</td>' +
    '</tr>';

  const nuevo =
    '<tr>' +
      '<td><input data-extra-name="nuevo" placeholder="Nuevo adicional" style="width:200px"></td>' +
      '<td><input data-extra-price="nuevo" type="number" min="0" value="0" style="width:120px"></td>' +
      '<td><input data-extra-stock="nuevo" type="number" min="0" placeholder="sin límite" style="width:110px"></td>' +
      '<td>' + boton('Agregar', 'nuevoExtra', 'nuevo') + '</td>' +
    '</tr>';

  return '<section class="card"><h2>Adicionales (' + m.extras.length + ')</h2>' +
    '<div class="wrap"><table><thead><tr>' +
      '<th>Nombre</th><th>Precio (centavos)</th><th>Stock</th><th></th>' +
    '</tr></thead><tbody>' + m.extras.map(fila).join('') + nuevo + '</tbody></table></div>' +
    '<p class="muted">Stock vacío = sin límite.</p></section>';
}

/**
 * El CSV se pide con fetch y no con un <a href>: la ruta exige el token en la
 * cabecera, y un enlace normal no la lleva.
 */
async function descargarCsv(marathonId) {
  const res = await fetch(API + '/admin/marathons/' + marathonId + '/registrants.csv', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) { flash('No se pudo exportar', true); return; }

  const blob = await res.blob();
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(blob);
  enlace.download = 'inscritos.csv';
  enlace.click();
  URL.revokeObjectURL(enlace.href);
}

// ─── Cargo por servicio ──────────────────────────────────────────────────────

async function vistaFee() {
  const { global: g, overrides } = await api('/admin/service-fee');
  const v = (x) => (x === null || x === undefined ? '' : x);

  $('#view').innerHTML =
    '<h2>Cargo por servicio (global)</h2>' +
    '<form class="card" id="feeForm">' +
      '<div class="row">' +
        '<label>Activo<select id="enabled"><option value="true"' + (g?.enabled ? ' selected' : '') + '>sí</option>' +
        '<option value="false"' + (g && !g.enabled ? ' selected' : '') + '>no</option></select></label>' +
        '<label>Tipo<select id="type">' +
          ['percent', 'fixed', 'mixed'].map((t) => '<option' + (g?.type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
        '</select></label>' +
        '<label>Porcentaje (bps)<input id="percentBps" type="number" min="0" value="' + v(g?.percentBps) + '"></label>' +
        '<label>Fijo (centavos)<input id="fixedCents" type="number" min="0" value="' + v(g?.fixedCents) + '"></label>' +
        '<label>Mínimo<input id="minCents" type="number" min="0" value="' + v(g?.minCents) + '"></label>' +
        '<label>Máximo<input id="maxCents" type="number" min="0" value="' + v(g?.maxCents) + '"></label>' +
        '<label>Etiqueta<input id="label" value="' + esc(g?.label ?? 'Cargo por servicio') + '"></label>' +
      '</div>' +
      '<button class="act" type="submit">Guardar</button>' +
      '<span class="muted"> · 1000 bps = 10 %</span>' +
    '</form>' +
    '<section class="card"><h2>Vista previa</h2>' +
      '<div class="row"><label>Subtotal de ejemplo (centavos)<input id="preview" type="number" value="20000"></label>' +
      '<button class="act" id="verPreview">Calcular</button></div>' +
      '<pre id="previewOut">—</pre>' +
    '</section>' +
    '<h2>Maratones con configuración propia</h2>' +
    tabla(['Maratón', 'Cargo'], overrides, (o) => [
      esc(o.name) + ' <span class="muted">' + esc(o.slug) + '</span>',
      o.serviceFeeConfig.enabled ? esc(o.serviceFeeConfig.label) : '<span class="bad">exenta</span>',
    ]);

  $('#feeForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const num = (id) => ($('#' + id).value === '' ? null : Number($('#' + id).value));
    try {
      await api('/admin/service-fee', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: $('#enabled').value === 'true',
          type: $('#type').value,
          percentBps: num('percentBps'),
          fixedCents: num('fixedCents'),
          minCents: num('minCents'),
          maxCents: num('maxCents'),
          label: $('#label').value,
        }),
      });
      flash('Guardado');
      abrir(actual);
    } catch (e) { flash(e.message, true); }
  });

  $('#verPreview').addEventListener('click', async () => {
    try {
      const p = await api('/admin/service-fee/preview?subtotalCents=' + Number($('#preview').value));
      $('#previewOut').textContent =
        'Subtotal    ' + bs(p.subtotalCents) + '\n' +
        'Cargo       ' + (p.serviceFeeCents === null ? '— (no se cobra ni se muestra)' : bs(p.serviceFeeCents)) + '\n' +
        'Total       ' + bs(p.totalCents) + '\n' +
        'Origen      ' + p.source;
    } catch (e) { flash(e.message, true); }
  });
}

// ─── Transferencias ──────────────────────────────────────────────────────────

async function vistaTransferencias() {
  const pagos = await api('/admin/payments/pending-transfers');

  $('#view').innerHTML = '<h2>Transferencias por confirmar (' + pagos.length + ')</h2>' +
    '<p class="muted">Confirmar toma el cupo y emite el dorsal, igual que un cobro normal.</p>' +
    tabla(['Corredor', 'Maratón', 'Importe', 'Solicitado', 'Referencia'], pagos, (p) => [
      esc(p.runner) + '<br><span class="muted">' + esc(p.email) + '</span>',
      esc(p.marathon),
      bs(p.amountCents),
      fecha(p.createdAt),
      '<input data-ref="' + p.id + '" placeholder="Nº de comprobante" style="width:150px"> ' +
        '<button class="act" data-pago="' + p.id + '">Confirmar</button>',
    ]);

  manejadorClic = async (ev) => {
    const b = ev.target.closest('button[data-pago]');
    if (!b) return;
    const id = b.dataset.pago;

    try {
      await api('/admin/payments/' + id + '/confirm-transfer', {
        method: 'POST',
        body: JSON.stringify({ reference: $('[data-ref="' + id + '"]').value || undefined }),
      });
      flash('Pago confirmado y dorsal emitido');
      abrir(actual);
    } catch (e) { flash(e.message, true); }
  };
}

// --- Comprobantes de QR (TEMPORAL, ver docs/pago-qr-manual.md) --------------

async function vistaComprobantes() {
  const proofs = await api('/admin/payment-proofs');

  $('#view').innerHTML = '<h2>Comprobantes por revisar (' + proofs.length + ')</h2>' +
    '<p class="muted">Cuadrá la referencia contra el extracto antes de aprobar. ' +
    'Aprobar toma el cupo y emite el dorsal; rechazar deja el cobro abierto para que ' +
    'el corredor suba otro.</p>' +
    tabla(['Corredor', 'Maratón', 'Importe', 'Referencia', 'Subido', 'Comprobante', ''], proofs, (p) => [
      esc(p.runner) + '<br><span class="muted">' + esc(p.runnerCi ?? p.runnerEmail ?? '—') + '</span>',
      esc(p.marathon),
      bs(p.amountCents),
      esc(p.reference ?? '—'),
      fecha(p.createdAt),
      '<a href="' + esc(p.imageUrl) + '" target="_blank" rel="noopener">' +
        '<img src="' + esc(p.imageUrl) + '" alt="Comprobante" style="height:64px;border-radius:6px">' +
        '</a>',
      '<button class="act" data-aprobar="' + p.id + '">Aprobar</button> ' +
        '<button class="act" data-rechazar="' + p.id + '">Rechazar</button>',
    ]);

  manejadorClic = async (ev) => {
    const aprobar = ev.target.closest('button[data-aprobar]');
    const rechazar = ev.target.closest('button[data-rechazar]');
    if (!aprobar && !rechazar) return;

    try {
      if (aprobar) {
        if (!confirmar('¿Dar por recibido este pago? Se emite el dorsal y no hay vuelta atrás.')) return;
        await api('/admin/payment-proofs/' + aprobar.dataset.aprobar + '/approve', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        flash('Pago acreditado y dorsal emitido');
      } else {
        // El motivo lo lee el corredor: sin él no sabe qué corregir.
        const nota = prompt('¿Por qué se rechaza? (lo va a leer el corredor)');
        if (!nota) return;
        await api('/admin/payment-proofs/' + rechazar.dataset.rechazar + '/reject', {
          method: 'POST',
          body: JSON.stringify({ note: nota }),
        });
        flash('Comprobante rechazado');
      }
      abrir(actual);
    } catch (e) { flash(e.message, true); }
  };
}

// ─── Inscripciones ───────────────────────────────────────────────────────────

async function vistaInscripciones() {
  const registros = await api('/admin/registrations');

  $('#view').innerHTML = '<h2>Últimas inscripciones</h2>' + tabla(
    ['Corredor', 'Maratón', 'Dorsal', 'Estado', 'Total', 'Pago', 'Fecha'],
    registros,
    (r) => [
      esc(r.runner) + '<br><span class="muted">' + esc(r.email) + '</span>',
      esc(r.marathon),
      esc(r.bibNumber ?? '—'),
      esc(r.status),
      bs(r.totalCents),
      r.payment ? esc(r.payment.method) + ' · ' + esc(r.payment.status) : '<span class="muted">—</span>',
      fecha(r.createdAt),
    ],
  );
}

// ─── Resultados ──────────────────────────────────────────────────────────────

async function vistaResultados() {
  const maratones = await api('/admin/marathons');

  $('#view').innerHTML =
    '<h2>Cargar resultados</h2>' +
    '<form class="card" id="resForm">' +
      '<div class="row"><label>Maratón<select id="marathon">' +
        maratones.map((m) => '<option value="' + m.id + '">' + esc(m.name) + '</option>').join('') +
      '</select></label></div>' +
      '<p class="muted">Una línea por corredor: <code>dorsal,segundos[,segundos de chip]</code></p>' +
      '<textarea id="filas" placeholder="MLP-0001,10850&#10;MLP-0002,11230,11190"></textarea>' +
      '<div class="row" style="margin-top:10px"><button class="act" type="submit">Cargar y recalcular puestos</button></div>' +
    '</form><pre id="resOut">—</pre>';

  $('#resForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();

    const results = $('#filas').value.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((linea) => {
        const [bibNumber, tiempo, chip] = linea.split(',').map((c) => c.trim());
        return {
          bibNumber,
          finishTimeSeconds: Number(tiempo),
          ...(chip ? { chipTimeSeconds: Number(chip) } : {}),
        };
      });

    try {
      const r = await api('/admin/marathons/' + $('#marathon').value + '/results', {
        method: 'POST',
        body: JSON.stringify({ results }),
      });
      $('#resOut').textContent =
        'Cargados: ' + r.imported + '\nDescartados: ' + r.skipped +
        (r.unknownBibs.length ? '\nDorsales desconocidos: ' + r.unknownBibs.join(', ') : '');
      flash('Resultados cargados');
    } catch (e) { flash(e.message, true); }
  });
}

// ─── Usuarios ────────────────────────────────────────────────────────────────

const ROLES = ['runner', 'admin'];

/**
 * Usuarios: alta, edicion en la propia fila y baja.
 *
 * Se edita en la tabla y no en una pantalla aparte porque lo que se cambia aqui
 * son cuatro campos: obligar a entrar y salir de un formulario para corregir un
 * nombre mal escrito es mas clics que el trabajo en si.
 */
async function vistaUsuarios(busqueda) {
  const usuarios = await api('/admin/users' + (busqueda ? '?q=' + encodeURIComponent(busqueda) : ''));

  const fila = (u) =>
    '<tr>' +
      '<td><input data-u-email="' + u.id + '" value="' + esc(u.email) + '" style="width:220px"></td>' +
      '<td><input data-u-name="' + u.id + '" value="' + esc(u.name) + '" style="width:180px"></td>' +
      '<td><select data-u-role="' + u.id + '">' +
        ROLES.map((r) => '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>').join('') +
      '</select></td>' +
      '<td><select data-u-verified="' + u.id + '">' +
        '<option value="true"' + (u.verified ? ' selected' : '') + '>sí</option>' +
        '<option value="false"' + (u.verified ? '' : ' selected') + '>no</option>' +
      '</select></td>' +
      '<td>' + u.registrations + '</td>' +
      '<td>' + u.workouts + '</td>' +
      '<td>' + fecha(u.createdAt) + '</td>' +
      '<td>' +
        boton('Guardar', 'guardarUsuario', u.id) +
        boton('Contraseña', 'passwordUsuario', u.id) +
        boton('Borrar', 'borrarUsuario', u.id) +
      '</td>' +
    '</tr>';

  $('#view').innerHTML =
    '<h2>Usuarios (' + usuarios.length + ')</h2>' +
    '<form class="card" id="altaUsuario">' +
      '<div class="row">' +
        '<label>Email<input id="nuEmail" type="email" required style="width:220px"></label>' +
        '<label>Nombre<input id="nuName" required style="width:180px"></label>' +
        '<label>Contraseña<input id="nuPassword" type="password" required minlength="8" style="width:170px"></label>' +
        '<label>Rol<select id="nuRole">' + ROLES.map((r) => '<option>' + r + '</option>').join('') + '</select></label>' +
        '<button class="act" type="submit">Crear usuario</button>' +
      '</div>' +
      '<span class="muted">Mínimo 8 caracteres, con al menos una letra y un número. El email queda verificado.</span>' +
    '</form>' +
    '<div class="row">' +
      '<label>Buscar<input id="q" placeholder="email o nombre" value="' + esc(busqueda || '') + '"></label>' +
      '<button class="act" data-accion="buscar" data-id="-">Buscar</button>' +
    '</div>' +
    (usuarios.length
      ? '<div class="wrap"><table><thead><tr>' +
          '<th>Email</th><th>Nombre</th><th>Rol</th><th>Verificado</th><th>Inscr.</th><th>Entren.</th><th>Alta</th><th></th>' +
        '</tr></thead><tbody>' + usuarios.map(fila).join('') + '</tbody></table></div>'
      : '<p class="muted">No hay nada que mostrar.</p>');

  $('#altaUsuario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const creado = await api('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: $('#nuEmail').value.trim(),
          name: $('#nuName').value.trim(),
          password: $('#nuPassword').value,
          role: $('#nuRole').value,
        }),
      });
      flash('Usuario ' + creado.email + ' creado');
      pintar(vistaUsuarios, busqueda);
    } catch (e) { flash(e.message, true); }
  });

  manejadorClic = async (ev) => {
    const b = ev.target.closest('button[data-accion]');
    if (!b) return;

    const id = b.dataset.id;
    const usuario = usuarios.find((u) => u.id === id);

    try {
      if (b.dataset.accion === 'buscar') { pintar(vistaUsuarios, $('#q').value.trim()); return; }

      if (b.dataset.accion === 'guardarUsuario') {
        await api('/admin/users/' + id, {
          method: 'PUT',
          body: JSON.stringify({
            email: $('[data-u-email="' + id + '"]').value.trim(),
            name: $('[data-u-name="' + id + '"]').value.trim(),
            role: $('[data-u-role="' + id + '"]').value,
            verified: $('[data-u-verified="' + id + '"]').value === 'true',
          }),
        });
        flash('Usuario guardado');
      }

      if (b.dataset.accion === 'passwordUsuario') {
        // Se pide en el momento y no se guarda en ningun campo de la pagina:
        // una contrasena en un input que queda pintado es una contrasena que
        // se lee por encima del hombro.
        const nueva = prompt('Contraseña nueva para ' + usuario.email + ' (mín. 8, con letra y número):');
        if (!nueva) return;

        const r = await api('/admin/users/' + id + '/password', {
          method: 'POST',
          body: JSON.stringify({ password: nueva }),
        });
        flash('Contraseña cambiada · ' + r.sessionsRevoked + ' sesión/es cerradas');
        return;
      }

      if (b.dataset.accion === 'borrarUsuario') {
        if (!confirmar('¿Borrar la cuenta de ' + usuario.email + '? Se cancelan sus inscripciones futuras y no hay vuelta atrás.')) return;
        await api('/admin/users/' + id, { method: 'DELETE' });
        flash('Cuenta borrada');
      }

      pintar(vistaUsuarios, busqueda);
    } catch (e) { flash(e.message, true); }
  };
}

// ─── Arranque ────────────────────────────────────────────────────────────────

function arrancar() {
  $('#login').style.display = 'none';
  $('#app').style.display = 'block';
  abrir(0);
}

$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-i]');
  if (b) abrir(Number(b.dataset.i));
});

$('#logout').addEventListener('click', salir);

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#loginError').textContent = '';
  try { await entrar($('#email').value, $('#password').value); }
  catch (e) { $('#loginError').innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; }
});

// Con un token guardado se entra directo; si ya no vale, api() manda a login.
if (token) { arrancar(); } else { $('#login').style.display = 'block'; }
</script>
</body>
</html>`;
}
