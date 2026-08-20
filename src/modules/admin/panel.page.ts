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
 */
export const PANEL_HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PaceUp · Administración</title>
<style>
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

<script>
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

function tabla(columnas, filas, celda) {
  if (!filas.length) return '<p class="muted">No hay nada que mostrar.</p>';
  const cabecera = columnas.map((c) => '<th>' + esc(c) + '</th>').join('');
  const cuerpo = filas.map((f) => '<tr>' + celda(f).map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('');
  return '<div class="wrap"><table><thead><tr>' + cabecera + '</tr></thead><tbody>' + cuerpo + '</tbody></table></div>';
}

// ─── Sesión ──────────────────────────────────────────────────────────────────

async function entrar(email, password) {
  const res = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, deviceId: 'admin-panel' }),
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
  ['Cargo por servicio', vistaFee],
  ['Transferencias', vistaTransferencias],
  ['Inscripciones', vistaInscripciones],
  ['Resultados', vistaResultados],
  ['Usuarios', vistaUsuarios],
];

let actual = 0;

function pintarTabs() {
  $('#tabs').innerHTML = PESTANAS
    .map(([nombre], i) => '<button class="' + (i === actual ? 'on' : '') + '" data-i="' + i + '">' + nombre + '</button>')
    .join('');
}

async function abrir(i) {
  actual = i;
  pintarTabs();
  $('#view').innerHTML = '<p class="muted">Cargando…</p>';
  try { await PESTANAS[i][1](); } catch (e) { $('#view').innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
}

// ─── Maratones ───────────────────────────────────────────────────────────────

async function vistaMaratones() {
  const maratones = await api('/admin/marathons');

  $('#view').innerHTML = '<h2>Maratones (' + maratones.length + ')</h2>' + tabla(
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
        boton(m.published ? 'Despublicar' : 'Publicar', 'publicar', m.id),
        boton(m.resolved === 'closed' ? 'Reabrir' : 'Cerrar inscr.', 'cerrar', m.id),
        boton('CSV inscritos', 'csv', m.id),
        boton('Recalcular puestos', 'ranks', m.id),
        m.feeOverride ? boton('Quitar cargo propio', 'quitarFee', m.id) : boton('Eximir del cargo', 'eximir', m.id),
      ].join(''),
    ],
  );

  $('#view').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-accion]');
    if (!b) return;

    const id = b.dataset.id;
    const maraton = maratones.find((m) => m.id === id);

    try {
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
  }, { once: true });
}

function boton(texto, accion, id) {
  return '<button class="act" data-accion="' + accion + '" data-id="' + id + '">' + texto + '</button>';
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

  $('#view').addEventListener('click', async (ev) => {
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
  }, { once: true });
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

async function vistaUsuarios() {
  const pintar = (usuarios) => tabla(
    ['Email', 'Nombre', 'Rol', 'Verificado', 'Inscripciones', 'Entrenamientos', 'Alta'],
    usuarios,
    (u) => [
      esc(u.email), esc(u.name), esc(u.role),
      u.verified ? '<span class="ok">sí</span>' : '<span class="muted">no</span>',
      u.registrations, u.workouts, fecha(u.createdAt),
    ],
  );

  const usuarios = await api('/admin/users');
  $('#view').innerHTML =
    '<h2>Usuarios</h2>' +
    '<div class="row"><label>Buscar<input id="q" placeholder="email o nombre"></label>' +
    '<button class="act" id="buscar">Buscar</button></div>' +
    '<div id="lista">' + pintar(usuarios) + '</div>';

  $('#buscar').addEventListener('click', async () => {
    const q = encodeURIComponent($('#q').value);
    $('#lista').innerHTML = pintar(await api('/admin/users?q=' + q));
  });
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
