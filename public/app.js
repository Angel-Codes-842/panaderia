const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmtGs = (n) => '₲\u00a0' + Number(n || 0).toLocaleString('es-PY', { maximumFractionDigits: 0 });
const fmtGs2 = (n) => '₲\u00a0' + Number(n || 0).toLocaleString('es-PY', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtFecha = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const fmtFechaHora = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

document.addEventListener('wheel', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'number') e.preventDefault();
}, { passive: false });

function sanitizarAutocompletado(raiz = document) {
  if (!raiz || !raiz.querySelectorAll) return;
  try {
    const forms = (raiz.matches && raiz.matches('form'))
      ? [raiz, ...raiz.querySelectorAll('form')]
      : (raiz.querySelectorAll ? raiz.querySelectorAll('form') : []);
    forms.forEach((f) => f.setAttribute('autocomplete', 'off'));

    const inputs = (raiz.matches && raiz.matches('input, textarea, select'))
      ? [raiz, ...raiz.querySelectorAll('input, textarea, select')]
      : (raiz.querySelectorAll ? raiz.querySelectorAll('input, textarea, select') : []);

    inputs.forEach((inp) => {
      const id = inp.id || '';
      if (id === 'login-usuario' || id === 'login-password' || inp.type === 'hidden' || inp.type === 'checkbox' || inp.type === 'radio') return;
      if (!inp.hasAttribute('autocomplete') || inp.getAttribute('autocomplete') !== 'off') {
        inp.setAttribute('autocomplete', 'off');
      }
      inp.setAttribute('autocorrect', 'off');
      inp.setAttribute('autocapitalize', 'off');
      inp.setAttribute('spellcheck', 'false');
      inp.setAttribute('data-lpignore', 'true');
      inp.setAttribute('data-1p-ignore', 'true');
    });
  } catch (_) {}
}

let productosGlobal = [];
let clientesGlobal = [];
let configGlobal = null;
const carrito = new Map();
const importesCarrito = new Map();

async function obtenerConfig() {
  if (!configGlobal) {
    try {
      configGlobal = await api('/api/config');
    } catch (_) {
      configGlobal = { permitir_venta_sin_stock: 1 };
    }
  }
  return configGlobal;
}

function permiteVentaSinStock() {
  if (!configGlobal) return true;
  return configGlobal.permitir_venta_sin_stock === undefined || Number(configGlobal.permitir_venta_sin_stock) === 1;
}

// Mantener el carrito entre cambios de pestaña (el flujo rápido pide no
// perderlo al pasar por otros módulos).
function guardarCarrito() {
  try {
    localStorage.setItem('panaderia_carrito', JSON.stringify(
      [...carrito.entries()].map(([id, cantidad]) => [id, cantidad, importesCarrito.get(id) ?? null])
    ));
  } catch (_) {}
}
function cargarCarritoGuardado() {
  try {
    const raw = localStorage.getItem('panaderia_carrito');
    if (!raw) return;
    const items = JSON.parse(raw);
    carrito.clear();
    importesCarrito.clear();
    for (const [id, cant, importe] of items) {
      const pid = Number(id);
      if (!Number.isFinite(pid) || Number(cant) <= 0) continue;
      carrito.set(pid, Number(cant));
      if (importe !== null && importe !== undefined && Number.isFinite(Number(importe)) && Number(importe) >= 0) {
        importesCarrito.set(pid, Number(importe));
      }
    }
  } catch (_) {}
}

// ── Timezone — Paraguay UTC-3 ──────────────────────────────
const TZ_OFFSET_MS = 3 * 3600 * 1000;
const fechaHoy = () => new Date(Date.now() - TZ_OFFSET_MS).toISOString().slice(0, 10);

// ── API helpers ───────────────────────────────────────────
async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    mostrarLogin();
    const e = new Error(data.error || 'Sesión no iniciada');
    e.sinSesion = true;
    throw e;
  }
  if (!r.ok) throw new Error(data.error || 'Error en la petición');
  return data;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put  = (url, body) => api(url, { method: 'PUT',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const del  = (url) => api(url, { method: 'DELETE' });

// ── Autocompletar clientes por CI/RUC ─────────────────────
const soloDigitos = (s) => String(s || '').replace(/\D+/g, '');
function tipoPorDocumento(s) {
  const n = String(s || '').trim();
  return /^\d{5,8}-\d$/.test(n) ? 'RUC' : 'Cédula';
}
function buscarClientesDocumento(norm) {
  const pre = [], cont = [], visto = new Set();
  for (const c of clientesGlobal) {
    const d = soloDigitos(c.documento);
    if (!d || visto.has(d)) continue;
    visto.add(d);
    if (d === norm) return [c];
    if (d.startsWith(norm)) pre.push(c);
    else if (d.includes(norm)) cont.push(c);
  }
  return pre.slice(0, 8).concat(cont.slice(0, 8));
}
const acAbiertos = [];
document.addEventListener('click', (e) => {
  if (!acAbiertos.length) return;
  acAbiertos.forEach((ac) => { if (ac.input.isConnected && !ac.cont.contains(e.target)) ac.ocultar(); });
  for (let i = acAbiertos.length - 1; i >= 0; i--) if (!acAbiertos[i].input.isConnected) acAbiertos.splice(i, 1);
});
function armarAutocompletarCliente(entradaId, contId, alElegir) {
  const input = $(entradaId), cont = $(contId);
  if (!input || !cont) return () => {};
  cont.classList.add('ac-wrap');
  const drop = document.createElement('div');
  drop.className = 'ac-dropdown';
  cont.appendChild(drop);
  let indice = -1, lista = [];
  const ocultar = () => { drop.classList.remove('visible'); drop.innerHTML = ''; indice = -1; };
  const elegir = (i) => { if (lista[i]) { alElegir(lista[i]); ocultar(); input.blur(); } };
  const mostrar = (items) => {
    lista = items; indice = items.length ? 0 : -1;
    drop.innerHTML = items.length
      ? items.map((c, i) => `<button type="button" data-i="${i}">${escapeHtml(c.nombre || (c.tipo_documento + ' ' + c.documento))}<small>${escapeHtml(c.tipo_documento)} ${escapeHtml(c.documento)}</small></button>`).join('')
      : '<div class="ac-vacio">Sin coincidencias</div>';
    drop.classList.add('visible');
    [...drop.querySelectorAll('button')].forEach((b) => {
      b.addEventListener('mouseenter', () => { indice = +b.dataset.i; pintaSel(); });
      b.addEventListener('mousedown', (e) => { e.preventDefault(); elegir(+b.dataset.i); });
    });
    pintaSel();
  };
  const pintaSel = () => {
    [...drop.querySelectorAll('button')].forEach((b, j) => {
      const sel = j === indice;
      b.classList.toggle('sel', sel);
      if (sel) b.scrollIntoView({ block: 'nearest' });
    });
  };
  const analizar = () => {
    const norm = soloDigitos(input.value);
    if (norm.length < 2) { ocultar(); return; }
    const items = buscarClientesDocumento(norm);
    if (norm.length >= 6 && items.length && soloDigitos(items[0].documento) === norm) {
      const c = items[0]; ocultar(); input.value = ''; alElegir(c); return;
    }
    items.length ? mostrar(items) : ocultar();
  };
  input.addEventListener('focus', analizar);
  input.addEventListener('input', analizar);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (lista.length) {
        indice = (indice >= lista.length - 1) ? 0 : indice + 1;
        pintaSel();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (lista.length) {
        indice = (indice <= 0) ? lista.length - 1 : indice - 1;
        pintaSel();
      }
    } else if (e.key === 'Enter') {
      if (drop.classList.contains('visible') && lista.length) {
        e.preventDefault();
        e.stopPropagation();
        if (indice >= 0 && lista[indice]) elegir(indice);
        else elegir(0);
      }
    } else if (e.key === 'Escape') {
      if (drop.classList.contains('visible')) {
        e.preventDefault();
        e.stopPropagation();
        ocultar();
      }
    }
  });
  acAbiertos.push({ input, cont, ocultar });
  return ocultar;
}

// ── Escape HTML ───────────────────────────────────────────
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

// ── Navegación por teclado en tablas ──────────────────────
// Flechas arriba/abajo recorren las filas marcadas con .fila-nav; Enter ejecuta
// el botón principal (el de "Editar", cuando existe) o enfoca la primera acción.
function hacerTablaNavegable(tablaId) {
  const tabla = document.getElementById(tablaId);
  if (!tabla || tabla.dataset.navListo === '1') return;
  tabla.dataset.navListo = '1';
  tabla.addEventListener('keydown', (e) => {
    const fila = e.target.closest('tr.fila-nav');
    if (!fila) return;
    const filas = [...tabla.querySelectorAll('tr.fila-nav')];
    const idx = filas.indexOf(fila);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const destino = e.key === 'ArrowDown'
        ? Math.min(filas.length - 1, idx + 1)
        : Math.max(0, idx - 1);
      filas[destino]?.focus();
    } else if (e.key === 'Enter') {
      const principal = fila.querySelector('[data-accion-principal]');
      const accion = principal || fila.querySelector('button');
      if (!accion || accion.disabled) return;
      e.preventDefault();
      if (principal) accion.click();
      else accion.focus();
    } else if (e.key === 'Escape') {
      fila.blur();
    }
  });
}

function enfocarPrimeraFila(tablaId, e) {
  const fila = document.querySelector(`#${tablaId} tr.fila-nav`);
  if (!fila) return false;
  if (e) e.preventDefault();
  fila.focus();
  return true;
}

// ── Toast System ──────────────────────────────────────────
const TOAST_ICONS = { ok: 'check-circle', err: 'x-circle', warn: 'alert-triangle', info: 'info' };
function toast(texto, tipo = 'info', duracion = 3500) {
  const container = $('#toast-container');
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.innerHTML = `<span class="toast-icon"><i data-lucide="${TOAST_ICONS[tipo] || 'info'}"></i></span><span>${escapeHtml(texto)}</span>`;
  container.appendChild(t);
  reicons();
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 300); }, duracion);
}

let resolverConfirmacion = null;

function confirmarAccion({ titulo, mensaje, aceptar = 'Confirmar', peligro = false }) {
  const fondo = $('#confirm-back');
  const botonAceptar = $('#confirm-accept');
  const botonCancelar = $('#confirm-cancel');
  const cerrar = $('#confirm-close');
  const focoAnterior = document.activeElement;
  return new Promise((resolve) => {
    if (resolverConfirmacion) resolverConfirmacion(false);

    let terminada = false;
    const terminar = (resultado) => {
      if (terminada) return;
      terminada = true;
      resolverConfirmacion = null;
      fondo.classList.add('hidden');
      document.removeEventListener('keydown', alPresionarTecla);
      fondo.removeEventListener('click', alClickFondo);
      botonAceptar.onclick = null;
      botonCancelar.onclick = null;
      cerrar.onclick = null;
      if (focoAnterior && focoAnterior.isConnected) focoAnterior.focus();
      resolve(resultado);
    };
    const alPresionarTecla = (e) => {
      if (e.key === 'Escape') terminar(false);
      if (e.key === 'Tab') {
        const controles = [cerrar, botonCancelar, botonAceptar];
        const indice = controles.indexOf(document.activeElement);
        if (e.shiftKey && indice === 0) {
          e.preventDefault();
          botonAceptar.focus();
        } else if (!e.shiftKey && indice === controles.length - 1) {
          e.preventDefault();
          cerrar.focus();
        }
      }
    };
    const alClickFondo = (e) => {
      if (e.target === fondo) terminar(false);
    };

    resolverConfirmacion = terminar;
    $('#confirm-title').textContent = titulo;
    $('#confirm-message').textContent = mensaje;
    botonAceptar.textContent = aceptar;
    botonAceptar.classList.toggle('danger', peligro);
    fondo.classList.remove('hidden');
    botonAceptar.onclick = () => terminar(true);
    botonCancelar.onclick = () => terminar(false);
    cerrar.onclick = () => terminar(false);
    fondo.addEventListener('click', alClickFondo);
    document.addEventListener('keydown', alPresionarTecla);
    (peligro ? botonCancelar : botonAceptar).focus();
    reicons();
  });
}

// ── Spinner / Empty ───────────────────────────────────────
function spinnerHtml(texto = 'Cargando...') {
  return `<div class="spinner-overlay"><div class="spinner"></div><span>${texto}</span></div>`;
}
function emptyStateHtml(icono, texto, subtexto = '') {
  return `<tr><td colspan="20"><div class="empty-state"><i data-lucide="${icono}"></i><p>${texto}</p>${subtexto ? `<small>${subtexto}</small>` : ''}</div></td></tr>`;
}
function msg(el, texto, tipo) { el.innerHTML = `<span class="msg ${tipo || 'ok'}">${texto}</span>`; }

// ── Lucide Icons ──────────────────────────────────────────
function reicons() {
  if (!window.lucide) return;
  const pendientes = document.querySelectorAll('[data-lucide]');
  if ([...pendientes].some((el) => el.tagName.toLowerCase() !== 'svg')) lucide.createIcons();
}
if (typeof document !== 'undefined' && document.body) {
  let _acTimer = null;
  new MutationObserver(() => {
    reicons();
    clearTimeout(_acTimer);
    _acTimer = setTimeout(() => sanitizarAutocompletado(document.body), 150);
  }).observe(document.body, { childList: true, subtree: true });
  reicons();
  sanitizarAutocompletado(document);
}

// ── Sesión ────────────────────────────────────────────────
let usuarioActual = '';
let sesionSucursalId = null;   // sucursal fija del usuario (null = dueño)
let sesionSucursalNombre = ''; // nombre de la sucursal del usuario
let esDueño = false;
let sucursalesGlobal = [];     // lista de sucursales (para el dueño)
let usuariosGlobal = [];       // lista de usuarios (para el dueño)
let sucursalActiva = null;     // sucursal donde se registra (operación)
let repSucursal = null;        // filtro de reportes (null = todas)

// URL/body con la "sucursal donde se registra" (para el dueño; al usuario
// asignado lo fija el servidor).
function withSucOperativa(url) {
  if (!esDueño || !sucursalActiva) return url;
  return url + (url.includes('?') ? '&' : '?') + 'sucursal_id=' + sucursalActiva;
}
function bodySucOperativa(body) {
  if (!esDueño || !sucursalActiva) return body || {};
  return Object.assign({}, body, { sucursal_id: sucursalActiva });
}
// URL con el filtro de reportes (todas / una sucursal).
function withSucReporte(url) {
  if (!esDueño) return sesionSucursalId ? (url + (url.includes('?') ? '&' : '?') + 'sucursal_id=' + sesionSucursalId) : url;
  if (repSucursal) return url + (url.includes('?') ? '&' : '?') + 'sucursal_id=' + repSucursal;
  return url;
}

function ocultarLogin(usuario, sesion) {
  usuarioActual = usuario || '';
  sesionSucursalId = sesion && sesion.sucursal_id ? sesion.sucursal_id : null;
  sesionSucursalNombre = sesion && sesion.sucursal_nombre ? sesion.sucursal_nombre : '';
  esDueño = !sesionSucursalId;
  $('#login').classList.add('hidden');
  $('.layout').style.display = '';
  if (usuarioActual) $('#usuario-actual').textContent = `(${usuarioActual})`;
  const navAudit = $('#nav-auditoria');
  if (navAudit) navAudit.style.display = esDueño ? '' : 'none';
  const navRecetas = $('#nav-recetas');
  if (navRecetas) navRecetas.style.display = esDueño ? '' : 'none';
}

function mostrarLogin() {
  $('#login').classList.remove('hidden');
  $('.layout').style.display = 'none';
  $('#login-password').value = '';
  const u = $('#login-usuario');
  if (u) setTimeout(() => u.focus(), 50);
  reicons();
}

// Carga la lista de sucursales (dueño) y define la sucursal activa.
async function cargarDatosSesion() {
  if (esDueño) {
    sucursalesGlobal = await api('/api/sucursales').catch(() => []);
    const guardada = parseInt(localStorage.getItem('sucursal-activa') || '', 10) || null;
    const porDefecto = sucursalesGlobal.find((s) => s.activa) || sucursalesGlobal[0];
    sucursalActiva = (sucursalesGlobal.find((s) => s.id === guardada) || porDefecto || {}).id || null;
  } else {
    sucursalActiva = sesionSucursalId;
  }
  pintarSucursalActiva();
  pintarFiltroReportes();
}

// Selector de "sucursal activa" en la barra lateral y filtro de reportes.
function pintarSucursalActiva() {
  const cont = $('#sucursal-side');
  if (!cont) return;
  if (esDueño) {
    cont.innerHTML = `
      <div class="sidebar-label">Sucursal donde se registra</div>
      <select id="sel-sucursal-activa">
        ${sucursalesGlobal.map((s) => `<option value="${s.id}" ${s.id === sucursalActiva ? 'selected' : ''}>${escapeHtml(s.nombre)}</option>`).join('')}
      </select>`;
    $('#sel-sucursal-activa')?.addEventListener('change', (e) => {
      sucursalActiva = parseInt(e.target.value, 10) || null;
      localStorage.setItem('sucursal-activa', sucursalActiva);
      cargarPos();
      cargarCaja();
      cargarProduccion();
      cargarGastos();
    });
  } else {
    cont.innerHTML = `<div class="sidebar-label">Tu sucursal</div><div class="sidebar-sucursal-ok"><i data-lucide="store" style="width:14px;height:14px"></i> ${escapeHtml(sesionSucursalNombre || '')}</div>`;
    reicons();
  }
}

function pintarFiltroReportes() {
  const hosts = $$('.filtro-reporte');
  if (!hosts.length) return;
  const opciones = esDueño
    ? [{ id: null, nombre: 'Todas', extra: 'consolidado' }, ...sucursalesGlobal.map((s) => ({ id: s.id, nombre: s.nombre }))]
    : null;
  for (const host of hosts) {
    if (!opciones) { host.innerHTML = ''; host.classList.add('hidden'); continue; }
    host.classList.remove('hidden');
    host.innerHTML = opciones.map((o) =>
      `<button class="cat-chip ${repSucursal === o.id ? 'activo' : ''}" onclick="setRepSucursal(${o.id === null ? 'null' : o.id})">${escapeHtml(o.nombre)}${o.extra ? `<small class="muted"> · ${o.extra}</small>` : ''}</button>`
    ).join('');
  }
  if (esDueño && window.lucide) lucide.createIcons();
}

function setRepSucursal(id) {
  repSucursal = id;
  pintarFiltroReportes();
  cargarDashboard();
  cargarReportes();
}

// Etiqueta "Sucursal: …" en cabeceras de paneles operativos.
function pintarEtiquetaSucursal(id) {
  const el = $('#' + id);
  if (!el) return;
  const s = esDueño
    ? sucursalesGlobal.find((x) => x.id === sucursalActiva)
    : { nombre: sesionSucursalNombre };
  const txt = s && s.nombre ? 'Sucursal: ' + s.nombre : '';
  el.textContent = txt;
  el.style.display = txt ? '' : 'none';
}

async function entrar() {
  const usuario = $('#login-usuario').value.trim();
  const password = $('#login-password').value;
  const btn = $('#btn-login');
  btn.disabled = true;
  try {
    const r = await post('/api/auth/login', { usuario, password });
    ocultarLogin(r.usuario, r);
    toast(`Bienvenido, ${r.usuario}`, 'ok');
    await cargarDatosSesion();
    cargarLicencia();
    cargarPos();
    cargarCaja();
    chequearTerminos();
  } catch (e) {
    msg($('#login-msg'), escapeHtml(e.message), 'err');
    $('#login-password').value = '';
    $('#login-password').focus();
  } finally {
    btn.disabled = false;
  }
}

async function cerrarSesion() {
  try { await post('/api/auth/logout', {}); } catch (_) {}
  mostrarLogin();
}

$('#login-form').addEventListener('submit', (e) => { e.preventDefault(); entrar(); });

// ── Términos y Condiciones ─────────────────────────────
async function chequearTerminos() {
  try {
    const t = await api('/api/terminos');
    if (t && !t.aceptada) mostrarTerminos(false, t);
  } catch (_) {}
}

function mostrarTerminos(yaAceptados, info) {
  const boton = $('#btn-aceptar-terminos');
  if (yaAceptados) {
    boton.innerHTML = '<i data-lucide="x"></i> Entendido';
    boton.onclick = () => $('#terminos').classList.add('hidden');
  } else {
    boton.innerHTML = '<i data-lucide="check-circle"></i> Acepto y continúo';
    boton.onclick = async () => {
      try { await post('/api/terminos/aceptar', {}); toast('Términos aceptados', 'ok'); } catch (_) {}
      $('#terminos').classList.add('hidden');
    };
  }
  reicons();
  $('#terminos').classList.remove('hidden');
}

async function cambiarPassword() {
  const actual = $('#pw-actual').value;
  const nueva = $('#pw-nueva').value;
  const msgEl = $('#pw-msg');
  if (!actual || !nueva) return msg(msgEl, 'Completá la contraseña actual y la nueva.', 'err');
  try {
    await post('/api/auth/password', { actual, nueva });
    $('#pw-actual').value = '';
    $('#pw-nueva').value = '';
    msg(msgEl, 'Contraseña cambiada. En los otros equipos hay que entrar de nuevo.', 'ok');
  } catch (e) {
    msg(msgEl, escapeHtml(e.message), 'err');
  }
}
$('#btn-cambiar-password').addEventListener('click', cambiarPassword);

// ── Licencia (versión de prueba declarada) ────────────────
let licenciaInfo = null;

async function cargarLicencia() {
  licenciaInfo = await api('/api/licencia');
}

async function descargarExportacion(tipo) {
  const r = await fetch('/api/exportar/' + tipo, { headers: { accept: 'text/csv' } });
  if (r.status === 401) { mostrarLogin(); return; }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    return toast(d.error || 'No se pudo exportar', 'err');
  }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = tipo + '-' + fechaHoy() + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function activarOReiniciarLicencia(accion) {
  const msgEl = $('#lic-msg');
  const campo = accion === 'activar' ? 'lic-codigo-comprado' : 'lic-codigo-prueba';
  const codigo = $('#' + campo).value.trim();
  if (!codigo) return msg(msgEl, 'Ingresá el código correspondiente.', 'err');
  try {
    await post('/api/licencia', { accion, codigo });
    licenciaInfo = await api('/api/licencia');
    await cargarConfig();
    msg($('#lic-msg'), accion === 'activar' ? 'Versión completa activada. ¡Disfrutá el sistema! Todas las funciones quedaron habilitadas.' : 'Prueba reiniciada: 2 meses (60 días) desde hoy.', 'ok');
    cargarDashboard();
  } catch (e) {
    msg(msgEl, escapeHtml(e.message), 'err');
  }
}

// ── Créditos / Fiados ─────────────────────────────────────
async function cargarCreditos() {
  const tabla = $('#tabla-creditos');
  tabla.innerHTML = spinnerHtml();
  let creditos;
  try {
    creditos = await api(withSucOperativa('/api/creditos'));
  } catch (e) {
    tabla.innerHTML = '<tbody>' + emptyStateHtml('alert-triangle', 'No se pudieron cargar los créditos', escapeHtml(e.message)) + '</tbody>';
    toast(e.message, 'err');
    return;
  }
  const encabezado = `<thead><tr>
    <th>Venta</th><th>Fecha</th><th>Cliente</th>${esDueño ? '<th>Sucursal</th>' : ''}
    <th>Total</th><th>Pagado</th><th>Saldo</th><th>Último abono</th><th></th>
  </tr></thead>`;
  if (!creditos.length) {
    tabla.innerHTML = encabezado + `<tbody>${emptyStateHtml('receipt', 'Sin créditos pendientes', 'Las ventas a crédito aparecerán aquí hasta que se paguen por completo')}</tbody>`;
    reicons();
    return;
  }
  tabla.innerHTML = encabezado + '<tbody>' + creditos.map((c) => `<tr>
    <td><button class="btn small ghost" onclick="verCredito(${c.id})">${c.tipo === 'factura' ? 'F-' : ''}${c.numero_comprobante}</button></td>
    <td>${fmtFecha(c.fecha)}</td>
    <td><b>${escapeHtml(c.cliente_nombre || 'Consumidor Final')}</b><br><span class="muted">${escapeHtml(c.cliente_documento || '')}</span></td>
    ${esDueño ? `<td>${escapeHtml(c.sucursal_nombre || '—')}</td>` : ''}
    <td>${fmtGs(c.total)}</td><td>${fmtGs(c.pagado)}</td>
    <td><b>${fmtGs(c.saldo)}</b></td><td>${c.ultimo_abono ? fmtFecha(c.ultimo_abono) : '—'}</td>
    <td><button class="btn small" onclick="abrirAbonoCredito(${c.id}, ${Number(c.saldo)})"><i data-lucide="banknote"></i> Cobrar abono</button></td>
  </tr>`).join('') + '</tbody>';
  reicons();
}

async function verCredito(id) {
  try {
    const credito = await api(`/api/creditos/venta/${id}`);
    const abonos = credito.abonos.map((a) => `<tr>
      <td>${fmtFecha(a.fecha)}</td><td>${fmtGs(a.monto)}</td>
    </tr>`).join('');
    abrirModal(`Detalle de crédito · Venta N° ${credito.numero_comprobante}`, `
      <div class="cards" style="margin-bottom:14px">
        <div class="card"><div class="valor">${fmtGs(credito.total)}</div><div class="etiqueta">Total</div></div>
        <div class="card positivo"><div class="valor">${fmtGs(credito.pagado)}</div><div class="etiqueta">Pagado</div></div>
        <div class="card ambar"><div class="valor">${fmtGs(credito.saldo)}</div><div class="etiqueta">Saldo pendiente</div></div>
      </div>
      <p class="muted" style="margin-bottom:10px"><b>${escapeHtml(credito.cliente_nombre || 'Consumidor Final')}</b> · Venta del ${fmtFecha(credito.fecha)}</p>
      <h3>Abonos registrados</h3>
      <table><thead><tr><th>Fecha</th><th>Monto</th></tr></thead><tbody>${abonos || '<tr><td colspan="2">Todavía no hay abonos</td></tr>'}</tbody></table>
      ${credito.saldo > 0 ? `<button class="btn" style="width:100%;margin-top:16px" onclick="abrirAbonoCredito(${credito.id}, ${Number(credito.saldo)})"><i data-lucide="banknote"></i> Cobrar abono</button>` : ''}
    `);
    reicons();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function abrirAbonoCredito(id, saldo) {
  abrirModal('Cobrar abono', `
    <p class="muted">Saldo pendiente: <b>${fmtGs(saldo)}</b></p>
    <label>Monto del abono
      <input type="number" id="credito-abono-monto" min="0.01" max="${saldo}" step="any" placeholder="0">
    </label>
    <div class="actions" style="margin-top:18px;justify-content:space-between">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" onclick="registrarAbonoCredito(${id}, ${saldo})"><i data-lucide="check-circle"></i> Registrar abono</button>
    </div>`);
  reicons();
}

async function registrarAbonoCredito(id, saldo) {
  const monto = Number($('#credito-abono-monto').value);
  if (!Number.isFinite(monto) || monto <= 0 || monto > saldo) {
    return toast('Ingresá un monto válido que no supere el saldo pendiente', 'warn');
  }
  const boton = $('#modal').querySelector('.actions .btn:last-child');
  boton.disabled = true;
  try {
    const resultado = await post('/api/creditos/abonar', { venta_id: id, monto });
    cerrarModal();
    toast(resultado.saldo > 0 ? `Abono registrado. Saldo pendiente: ${fmtGs(resultado.saldo)}` : 'Crédito pagado por completo', 'ok');
    await cargarCreditos();
    cargarCaja();
    cargarDashboard();
  } catch (e) {
    toast(e.message, 'err');
    boton.disabled = false;
  }
}

// ── Navegación ────────────────────────────────────────────
const cargadores = {
  dashboard: cargarDashboard, ventas: cargarPos, 'historial-ventas': cargarHistorialVentas, productos: cargarProductos,
  clientes: cargarClientes,
  creditos: () => {
    if (typeof cargarCreditos === 'function') cargarCreditos();
  },
  produccion: cargarProduccion,
  reportes: cargarReportes, caja: cargarCaja, gastos: cargarGastos, config: cargarConfig,
  recetas: () => { if (typeof cargarRecetasTab === 'function') cargarRecetasTab(); },
  auditoria: () => { if (typeof cargarAuditoria === 'function') cargarAuditoria(); },
  ayuda: () => {}
};
function irATab(tab) {
  $$('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $$('.panel').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + tab));
  const cargar = cargadores[tab];
  if (typeof cargar === 'function') cargar();
  sanitizarAutocompletado(document.getElementById('tab-' + tab));
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => irATab(b.dataset.tab)));

// ── Dashboard ─────────────────────────────────────────────
async function cargarDashboard() {
  $('#dash-cards').innerHTML = spinnerHtml();
  const [dia, semana] = await Promise.all([api(withSucReporte('/api/reporte/dia')), api(withSucReporte('/api/reporte/semana'))]);
  $('#dash-fecha').textContent = fmtFecha(dia.fecha);

  let totalGastos = 0;
  try { const g = await api(withSucReporte('/api/gastos?fecha=' + dia.fecha)); totalGastos = g.reduce((a, x) => a + x.monto, 0); } catch (_) {}

  $('#dash-cards').innerHTML = `
    <div class="card clickable" onclick="irATab('ventas')"><div class="valor">${fmtGs(dia.total_ventas)}</div><div class="etiqueta">Ventas de hoy</div></div>
    <div class="card clickable" onclick="irATab('ventas')"><div class="valor">${dia.cantidad_ventas}</div><div class="etiqueta">Comprobantes</div></div>
    <div class="card negativo clickable" onclick="irATab('gastos')"><div class="valor">${fmtGs(totalGastos)}</div><div class="etiqueta">Gastos de hoy</div></div>
    <div class="card clickable" onclick="irATab('produccion')"><div class="valor">${dia.lotes.length}</div><div class="etiqueta">Producciones de hoy</div></div>`;

  const max = Math.max(...semana.serie.map((s) => s.ventas), 1);
  $('#dash-chart').innerHTML = semana.serie.map((s) => {
    const h = Math.round((s.ventas / max) * 100);
    const esHoy = s.fecha === dia.fecha;
    return `<div class="bar-wrap ${esHoy ? 'hoy' : ''}">
      <span class="bar-val">${s.ventas >= 1000 ? (s.ventas / 1000).toFixed(0) + 'k' : fmtGs(s.ventas)}</span>
      <div class="bar" style="height:${Math.max(h, 2)}%"></div>
      <span class="bar-label">${esHoy ? 'Hoy' : s.fecha.slice(8)}</span>
      <div class="bar-tooltip">${fmtGs(s.ventas)}</div>
    </div>`;
  }).join('');

  const topRows = semana.top.map((p) => `<tr><td>${escapeHtml(p.nombre)}</td><td>${p.cantidad}${p.unidad === 'kg' ? ' kg' : ''}</td><td>${fmtGs(p.total)}</td></tr>`).join('');
  $('#dash-top').innerHTML = '<tr><th>Producto</th><th>Cant.</th><th>Total</th></tr>' + (topRows || emptyStateHtml('package', 'Sin ventas esta semana'));

  const formaRows = dia.por_forma.map((f) => `<tr><td><span class="tag ${f.forma_pago}">${f.forma_pago}</span></td><td>${f.cantidad}</td><td>${fmtGs(f.total)}</td></tr>`).join('');
  $('#dash-formas').innerHTML = '<tr><th>Forma</th><th>Comprobantes</th><th>Total</th></tr>' + (formaRows || emptyStateHtml('shopping-cart', 'Sin ventas hoy'));

  const prodRows = dia.lotes.map((l) => `<tr><td>${escapeHtml(l.producto_nombre)}</td><td><b>${l.cantidad}${l.producto_unidad === 'kg' ? ' kg' : ''}</b></td></tr>`).join('');
  $('#dash-produccion').innerHTML = '<tr><th>Producto</th><th>Cant.</th></tr>' + (prodRows || '<tr><td colspan="2"><div class="empty-state" style="padding:20px"><i data-lucide="chef-hat"></i><p>Sin producción registrada hoy</p></div></td></tr>');

  if (dia.caja) {
    $('#caja-resumen-lateral').innerHTML = `<strong>Caja de hoy</strong>
      Estado: <span style="color:${dia.caja.estado === 'abierta' ? 'var(--verde)' : 'var(--rojo)'}; font-weight:700">${dia.caja.estado === 'abierta' ? 'Abierta' : 'Cerrada'}</span><br>
      Apertura: ${fmtGs(dia.caja.apertura)}`;
  } else {
    $('#caja-resumen-lateral').innerHTML = '<strong>Caja</strong><br><span style="opacity:.7">No abierta hoy</span>';
  }
}

// ── POS ───────────────────────────────────────────────────
let posClienteSel = null;
let posTipoComprobante = 'ticket';
let posFiscalEstado = null;
let posRecibidoManual = false; // El operador editó el importe (billete de mayor denominación)

async function cargarPos() {
  posRecibidoManual = false;
  [productosGlobal, clientesGlobal, configGlobal] = await Promise.all([api('/api/productos'), api('/api/clientes'), obtenerConfig()]);
  posFiscalEstado = await api(withSucOperativa('/api/config/fiscal/estado')).catch(() => null);
  cargarCarritoGuardado();
  const fpago = $('#pos-forma-pago');
  if (fpago) {
    fpago.value = 'efectivo';
    fpago.onchange = () => {
      posRecibidoManual = false;
      const rec = $('#pos-recibido');
      // El importe precargado corresponde al efectivo; en crédito es un abono opcional.
      if (rec && fpago.value !== 'efectivo') rec.value = '';
      calcularVuelto();
    };
  }
  const recibido = $('#pos-recibido');
  if (recibido) {
    recibido.value = '';
    posRecibidoManual = false;
    recibido.oninput = () => {
      // Si cambian el importe a mano, conservarlo aunque cambie el total.
      posRecibidoManual = true;
      calcularVuelto();
    };
    recibido.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const { total } = calcularTotalNumerico();
        if (!Number(recibido.value || 0) && total > 0) autocompletarRecibido(total, true);
        const btn = $('#btn-vender');
        if (btn && !btn.disabled) btn.click();
      }
    };
  }
  ['efectivo', 'transferencia', 'tarjeta'].forEach((medio) => {
    const input = $(`#pos-pago-${medio}`);
    if (input) {
      input.value = '';
      input.oninput = calcularVuelto;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const btn = $('#btn-vender');
          if (btn && !btn.disabled) btn.click();
        }
      };
    }
  });
  const desc = $('#pos-descuento');
  if (desc) {
    desc.value = 0;
    desc.oninput = calcularTotalBoutique;
    desc.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const rec = $('#pos-recibido');
        if (rec) {
          rec.focus();
          rec.select();
        }
      }
    };
  }
  const tipo = $('#pos-tipo-comprobante');
  if (tipo) {
    tipo.value = posTipoComprobante;
    tipo.onchange = () => {
      posTipoComprobante = tipo.value === 'factura' ? 'factura' : 'ticket';
      actualizarComprobantePOS();
      actualizarBotonCobrar();
      if (posTipoComprobante === 'factura' && !posClienteSel) abrirSelectorClientePOS();
    };
  }
  // No vaciar el carrito ni el cliente al recargar el POS entre pestañas.
  pintarCarrito();
  actualizarClientePOS();
  actualizarComprobantePOS();
  actualizarBotonCobrar();
  calcularVuelto();
  calcularTotalBoutique();
  cargarComprobantes();
  $('#pos-fecha').textContent = fmtFecha(fechaHoy());
  pintarEtiquetaSucursal('pos-sucursal');
  try {
    const caja = await api(withSucOperativa('/api/caja'));
    const sinCaja = !caja || caja.estado !== 'abierta';
    const aviso = $('#pos-caja-aviso');
    if (aviso) aviso.style.display = sinCaja ? 'flex' : 'none';
    const btn = $('#btn-vender');
    if (btn) btn.disabled = sinCaja;
  } catch (_) {
    const aviso = $('#pos-caja-aviso');
    if (aviso) aviso.style.display = 'flex';
    const btn = $('#btn-vender');
    if (btn) btn.disabled = true;
  }
}

let posBuscarIndice = 0;

function abrirBuscarProductoPOS(consulta = '') {
  abrirModal('Buscar producto', `
    <div class="pos-product-search">
      <label class="sr-only" for="pos-buscar-modal">Buscar por nombre, código o categoría</label>
      <div class="buscar-wrap">
        <i data-lucide="search" class="buscar-ico"></i>
        <input id="pos-buscar-modal" type="search" class="buscar" placeholder="Nombre, código o categoría..." autocomplete="off">
      </div>
      <div id="pos-buscar-resultados" class="pos-product-results"></div>
    </div>`);
  const input = $('#pos-buscar-modal');
  const cont = $('#pos-buscar-resultados');
  input.value = consulta;
  input.oninput = () => pintarResultadosBuscarPOS(input.value);

  input.addEventListener('keydown', (e) => {
    const items = cont ? [...cont.querySelectorAll('.pos-search-result:not(:disabled)')] : [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) {
        posBuscarIndice = (posBuscarIndice >= items.length - 1) ? 0 : posBuscarIndice + 1;
        actualizarSeleccionBusquedaPOS();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) {
        posBuscarIndice = (posBuscarIndice <= 0) ? items.length - 1 : posBuscarIndice - 1;
        actualizarSeleccionBusquedaPOS();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) {
        if (posBuscarIndice >= 0 && items[posBuscarIndice]) {
          items[posBuscarIndice].click();
        } else {
          items[0].click();
        }
      }
    }
  });

  if (cont) {
    cont.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('.pos-search-result:not(:disabled)');
      if (!btn) return;
      const items = [...cont.querySelectorAll('.pos-search-result:not(:disabled)')];
      const idx = items.indexOf(btn);
      if (idx !== -1 && idx !== posBuscarIndice) {
        posBuscarIndice = idx;
        items.forEach((b, i) => b.classList.toggle('activo', i === idx));
      }
    });
  }

  pintarResultadosBuscarPOS(consulta);
  setTimeout(() => {
    input.focus();
    input.select();
  }, 40);
  reicons();
}

function pintarResultadosBuscarPOS(consulta) {
  const cont = $('#pos-buscar-resultados');
  if (!cont) return;
  const q = String(consulta || '').trim().toLowerCase();
  const lista = productosGlobal.filter((p) => p.activo && (
    !q ||
    (p.nombre || '').toLowerCase().includes(q) ||
    (p.codigo || p.code || '').toLowerCase().includes(q) ||
    (p.categoria || '').toLowerCase().includes(q)
  ));
  if (!lista.length) {
    posBuscarIndice = -1;
    cont.innerHTML = '<div class="pos-search-empty">No se encontraron productos</div>';
    return;
  }
  cont.innerHTML = lista.slice(0, 100).map((p) => {
    const agotado = p.stock <= 0;
    const sinStockPermitido = agotado && permiteVentaSinStock();
    const deshabilitado = agotado && !permiteVentaSinStock();
    const esKg = p.unidad === 'kg';
    const codigo = p.codigo || p.code || 'Sin código';
    const stockEtiqueta = agotado
      ? (p.stock < 0 ? `${unidadLabel(p.unidad, p.stock)}` : 'Sin stock')
      : unidadLabel(p.unidad, p.stock);
    const stockHtml = agotado
      ? `<span style="color:${sinStockPermitido ? 'var(--ambar)' : 'var(--rojo)'};font-weight:600">${escapeHtml(stockEtiqueta)}${sinStockPermitido ? ' (venta habilitada)' : ''}</span>`
      : escapeHtml(stockEtiqueta);
    return `<button type="button" class="pos-search-result" ${deshabilitado ? 'disabled' : ''} onclick="seleccionarProductoBuscarPOS(${p.id})">
      <span class="pos-search-result-info">
        <strong>${escapeHtml(p.nombre)}</strong>
        <small>${escapeHtml(codigo)} · ${stockHtml}</small>
      </span>
      <span class="pos-search-result-price">${fmtGs(p.precio_venta)}${esKg ? '/kg' : ''}</span>
    </button>`;
  }).join('');

  posBuscarIndice = 0;
  actualizarSeleccionBusquedaPOS();
}

function actualizarSeleccionBusquedaPOS() {
  const cont = $('#pos-buscar-resultados');
  if (!cont) return;
  const items = [...cont.querySelectorAll('.pos-search-result:not(:disabled)')];
  if (!items.length) {
    posBuscarIndice = -1;
    return;
  }
  if (posBuscarIndice < 0) posBuscarIndice = 0;
  if (posBuscarIndice >= items.length) posBuscarIndice = items.length - 1;

  items.forEach((item, i) => {
    const activo = (i === posBuscarIndice);
    item.classList.toggle('activo', activo);
    if (activo) {
      item.scrollIntoView({ block: 'nearest' });
    }
  });
}

function seleccionarProductoBuscarPOS(id) {
  cerrarModal();
  agregarAlTicket(id);
}

function agregarAlTicket(id) {
  const p = productosGlobal.find((x) => x.id === id);
  if (!p || !p.activo) return toast('El producto no está disponible', 'warn');
  pedirCantidadProducto(id);
}

function pedirCantidadProducto(id) {
  const p = productosGlobal.find((x) => x.id === id);
  if (!p) return;
  const unidad = p.unidad === 'kg' ? 'kg' : p.unidad === 'docena' ? 'docena' : 'unidad';
  const cantidadActual = carrito.get(id) || 0;
  const stockDisponible = Math.max(0, p.stock - cantidadActual);
  const sinStock = stockDisponible <= 0;
  if (!permiteVentaSinStock() && sinStock) return toast(`Stock insuficiente de ${p.nombre}`, 'warn');
  const cantidadInicial = permiteVentaSinStock() && sinStock
    ? (p.unidad === 'kg' ? 0.5 : 1)
    : Math.min(p.unidad === 'kg' ? 0.5 : 1, Math.max(0.001, stockDisponible));
  const maxAttr = permiteVentaSinStock() ? '' : `max="${stockDisponible}"`;
  const infoDisponible = sinStock
    ? (permiteVentaSinStock() ? '<b style="color:var(--ambar)">Sin stock (permitido)</b>' : '<b>0 ' + unidad + '</b>')
    : `<b>${stockDisponible.toLocaleString('es-PY', { maximumFractionDigits: 3 })} ${unidad}</b>`;

  abrirModal(`Agregar ${p.nombre}`, `
    <p class="muted">Precio por ${unidad}: <b>${fmtGs(p.precio_venta)}</b> · Disponible: ${infoDisponible}</p>
    <div class="form-row">
      <div><label>Cantidad (${unidad})<input type="number" id="producto-cantidad" min="0.001" ${maxAttr} step="0.001" value="${cantidadInicial || ''}" placeholder="Ej: 0,500"></label></div>
      <div><label>Importe (₲)<input type="number" id="producto-importe" min="0" step="any" placeholder="Ingresá cantidad o importe"></label></div>
    </div>
    <p id="producto-prev" class="prev-box muted" style="display:none"></p>
    <button class="btn" style="width:100%;margin-top:12px" onclick="confirmarCantidadProducto(${id})">Agregar al ticket</button>`);
  const cantidadInput = $('#producto-cantidad');
  const importeInput = $('#producto-importe');
  const actualizarVistaPrevia = (importeIngresado = null) => {
    const cantidad = Number(cantidadInput.value);
    const importeCalculado = cantidad * p.precio_venta;
    const prev = $('#producto-prev');
    if (!cantidad || !Number.isFinite(cantidad) || cantidad <= 0) {
      prev.style.display = 'none';
      return;
    }
    const cantidadTexto = cantidad.toLocaleString('es-PY', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
    prev.style.display = 'block';
    prev.textContent = importeIngresado === null
      ? `${cantidadTexto} ${unidad} × ${fmtGs(p.precio_venta)} = ${fmtGs(importeCalculado)}`
      : `Importe ingresado: ${fmtGs(importeIngresado)} · Se cobrarán ${fmtGs(importeCalculado)} por ${cantidadTexto} ${unidad}`;
  };
  cantidadInput.oninput = () => {
    cantidadInput.dataset.origen = 'cantidad';
    cantidadInput.step = '0.001';
    const cantidad = Number(cantidadInput.value);
    if (Number.isFinite(cantidad) && cantidad >= 0) {
      importeInput.value = cantidad > 0 ? String(cantidad * p.precio_venta) : '';
    } else {
      importeInput.value = '';
    }
    actualizarVistaPrevia();
  };
  importeInput.oninput = () => {
    cantidadInput.dataset.origen = 'importe';
    cantidadInput.step = 'any';
    if (importeInput.value === '') {
      cantidadInput.value = '';
      actualizarVistaPrevia();
      return;
    }
    const importe = Number(importeInput.value);
    if (!Number.isFinite(importe) || importe < 0 || p.precio_venta <= 0) {
      cantidadInput.value = '';
      actualizarVistaPrevia();
      return;
    }
    const cantidad = Math.round((importe / p.precio_venta) * 1000) / 1000;
    cantidadInput.value = cantidad > 0 ? String(cantidad) : '';
    actualizarVistaPrevia(importe);
    if (importe > 0 && p.precio_venta > 0 && Number(cantidadInput.value) === 0) {
      const prev = $('#producto-prev');
      prev.style.display = 'block';
      prev.textContent = `El importe no alcanza para una cantidad mínima de 0,001 ${unidad}.`;
    }
  };
  const onEnterConfirmar = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmarCantidadProducto(id);
    }
  };
  cantidadInput.addEventListener('keydown', onEnterConfirmar);
  importeInput.addEventListener('keydown', onEnterConfirmar);

  cantidadInput.dispatchEvent(new Event('input'));
  setTimeout(() => {
    cantidadInput.focus();
    cantidadInput.select();
  }, 40);
}

function confirmarCantidadProducto(id) {
  const p = productosGlobal.find((x) => x.id === id);
  const ingresada = Number($('#producto-cantidad')?.value);
  if (!p || !Number.isFinite(ingresada) || ingresada <= 0) return toast('Ingresá una cantidad válida', 'warn');
  const desdeImporte = $('#producto-cantidad')?.dataset.origen === 'importe';
  const cantidad = Math.round(ingresada * 1000) / 1000;
  if (Math.abs(cantidad - ingresada) > 0.00000001) return toast('La cantidad admite hasta tres decimales', 'warn');
  const cantidadAnterior = carrito.get(id) || 0;
  const total = cantidadAnterior + cantidad;
  if (!permiteVentaSinStock() && total > p.stock + 0.000001) {
    const unidad = p.unidad === 'kg' ? 'kg' : 'unidades';
    return toast(`Stock insuficiente: quedan ${(p.stock - (carrito.get(id) || 0)).toLocaleString('es-PY', { maximumFractionDigits: 3 })} ${unidad}`, 'err');
  }
  carrito.set(id, Math.round(total * 1000) / 1000);
  if (desdeImporte) {
    const importeAnterior = importesCarrito.has(id) ? importesCarrito.get(id) : cantidadAnterior * p.precio_venta;
    importesCarrito.set(id, importeAnterior + Number($('#producto-importe').value));
  } else {
    importesCarrito.delete(id);
  }
  modal.classList.add('hidden');
  guardarCarrito();
  pintarTicket();
}

function cambiarCant(id, delta) {
  const p = productosGlobal.find((x) => x.id === id);
  const paso = p.unidad === 'kg' ? 0.1 : 1;
  const nueva = Math.round(((carrito.get(id) || 0) + delta * paso) * 1000) / 1000;
  if (nueva <= 0) { carrito.delete(id); importesCarrito.delete(id); guardarCarrito(); return pintarTicket(); }
  if (!permiteVentaSinStock() && nueva > p.stock) return toast(`Stock insuficiente de ${p.nombre}`, 'warn');
  carrito.set(id, nueva);
  importesCarrito.delete(id);
  guardarCarrito();
  pintarTicket();
}

function pintarCarrito() {
  const body = $('#pos-cart-body');
  const vacio = $('#pos-cart-vacio');
  const count = $('#pos-carrito-count');
  const subtotalEl = $('#pos-subtotal');
  const totalEl = $('#pos-total-pagar');
  if (!body) return;

  if (count) count.textContent = carrito.size;

  if (!carrito.size) {
    body.innerHTML = '';
    if (vacio) vacio.style.display = 'flex';
    if (subtotalEl) subtotalEl.textContent = fmtGs(0);
    if (totalEl) totalEl.textContent = fmtGs(0);
    const desc = $('#pos-descuento');
    if (desc) desc.value = 0;
    calcularVuelto();
    guardarCarrito();
    return;
  }

  if (vacio) vacio.style.display = 'none';
  let subtotal = 0;
  body.innerHTML = [...carrito.entries()].map(([id, cant]) => {
    const p = productosGlobal.find((x) => x.id === id);
    if (!p) return '';
    const esKg = p.unidad === 'kg';
    const linea = importesCarrito.get(id) ?? p.precio_venta * cant;
    subtotal += linea;
    const cantShow = cant.toLocaleString('es-PY', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
    return `<tr class="fila-carrito" tabindex="0" data-id="${id}" title="Flechas: cambiar cantidad · Enter: ir a cobrar">
      <td>${escapeHtml(p.nombre)}</td>
      <td class="center">
        <div class="qty-control">
          <button onclick="cambiarCant(${id}, -1)"><i data-lucide="minus"></i></button>
          <span>${cantShow}${esKg ? ' kg' : ''}</span>
          <button onclick="cambiarCant(${id}, 1)"><i data-lucide="plus"></i></button>
        </div>
      </td>
      <td class="right">${fmtGs(p.precio_venta)}${esKg ? '/kg' : ''}</td>
      <td class="right"><strong>${fmtGs(linea)}</strong></td>
      <td class="right"><button class="icon-btn" onclick="quitarDelTicket(${id})"><i data-lucide="x"></i></button></td>
    </tr>`;
  }).join('');

  if (subtotalEl) subtotalEl.textContent = fmtGs(subtotal);
  calcularTotalBoutique();
  calcularVuelto();
  guardarCarrito();
  reicons();
}

function calcularTotalBoutique() {
  const { subtotal, descuento, total } = calcularTotalNumerico();
  const subEl = $('#pos-subtotal');
  if (subEl) subEl.textContent = fmtGs(subtotal);
  const totalEl = $('#pos-total-pagar');
  if (totalEl) totalEl.textContent = fmtGs(total);
  calcularVuelto();
  if (!carrito.size) guardarCarrito();
}

$('#pos-descuento')?.addEventListener('input', calcularTotalBoutique);

const pintarTicket = pintarCarrito;

// El carrito se vuelve a dibujar al cambiar cantidades: devolver el foco a la
// fila correspondiente para poder seguir navegando sin tocar el mouse.
function enfocarFilaCarrito(id) {
  $(`#pos-cart-body tr.fila-carrito[data-id="${id}"]`)?.focus();
}

function instalarNavegacionCarrito() {
  const body = $('#pos-cart-body');
  if (!body || body.dataset.navListo === '1') return;
  body.dataset.navListo = '1';
  body.addEventListener('keydown', (e) => {
    const fila = e.target.closest('tr.fila-carrito');
    if (!fila) return;
    const id = Number(fila.dataset.id);
    const filas = [...body.querySelectorAll('tr.fila-carrito')];
    const idx = filas.indexOf(fila);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const destino = e.key === 'ArrowDown' ? Math.min(filas.length - 1, idx + 1) : Math.max(0, idx - 1);
      filas[destino]?.focus();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      cambiarCant(id, e.key === 'ArrowRight' ? 1 : -1);
      requestAnimationFrame(() => {
        if (carrito.has(id)) {
          enfocarFilaCarrito(id);
        } else {
          const restantes = [...body.querySelectorAll('tr.fila-carrito')];
          restantes[Math.min(idx, restantes.length - 1)]?.focus();
        }
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const rec = $('#pos-recibido');
      if (rec) { rec.focus(); rec.select(); }
    } else if (e.key === 'Escape') {
      fila.blur();
    }
  });
}

function quitarDelTicket(id) {
  carrito.delete(id);
  importesCarrito.delete(id);
  guardarCarrito();
  pintarCarrito();
}

function vaciarCarrito() {
  if (!carrito.size) return;
  carrito.clear();
  importesCarrito.clear();
  guardarCarrito();
  pintarCarrito();
}

function nuevaVentaPOS() {
  carrito.clear();
  importesCarrito.clear();
  try { localStorage.removeItem('panaderia_carrito'); } catch (_) {}
  posClienteSel = null;
  actualizarClientePOS();
  const rec = $('#pos-recibido');
  if (rec) rec.value = '';
  posRecibidoManual = false;
  const fp = $('#pos-forma-pago');
  if (fp) fp.value = 'efectivo';
  ['efectivo', 'transferencia', 'tarjeta'].forEach((medio) => {
    const input = $(`#pos-pago-${medio}`);
    if (input) input.value = '';
  });
  const tipo = $('#pos-tipo-comprobante');
  posTipoComprobante = 'ticket';
  if (tipo) tipo.value = 'ticket';
  actualizarComprobantePOS();
  actualizarBotonCobrar();
  const desc = $('#pos-descuento');
  if (desc) desc.value = 0;
  calcularVuelto();
  calcularTotalBoutique();
  pintarCarrito();
  toast('Nueva venta iniciada', 'info');
}

function setShowBuscarPOS(v) {
  // Compatibilidad con el botón del header boutique-style.
}

function agregarPorCodigoPOS(e) {
  if (e && e.preventDefault) e.preventDefault();
  const input = $('#pos-buscar');
  const val = (input && input.value ? input.value : '').trim().toLowerCase();
  if (!val) return;
  const codigoBuscado = val.replace(/\s+/g, '');
  let p = productosGlobal.find((x) => (x.codigo || x.code || '').toLowerCase() === codigoBuscado && x.activo);
  if (!p) p = productosGlobal.find((x) => (x.nombre || '').toLowerCase() === val && x.activo);
  if (!p) return abrirBuscarProductoPOS(val);
  agregarAlTicket(p.id);
  if (input) {
    input.value = '';
    pintarGridProductos();
  }
  if (!$('#peso-input')) input.focus();
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    const modal = $('#modal');
    const modalAbierto = modal && !modal.classList.contains('hidden');
    const confirmBack = $('#confirm-back');
    const confirmAbierto = confirmBack && !confirmBack.classList.contains('hidden');

    // 1. Si el diálogo de confirmación está abierto, confirm-back maneja sus teclas
    if (confirmAbierto) return;

    const key = e.key;
    const code = e.code;
    const ctrl = e.ctrlKey || e.metaKey;

    // 2. Atajos de función y navegación (F2, F4, F8, F9 y alternativas Ctrl+B, Ctrl+U, Ctrl+N, Ctrl+Enter)
    const esF2 = key === 'F2' || code === 'F2' || (ctrl && (key === 'b' || key === 'B'));
    const esF4 = key === 'F4' || code === 'F4' || (ctrl && (key === 'u' || key === 'U'));
    const esF8 = key === 'F8' || code === 'F8' || (ctrl && (key === 'n' || key === 'N'));
    const esF9 = key === 'F9' || code === 'F9' || (ctrl && key === 'Enter');

    if (esF2) {
      e.preventDefault();
      if (modalAbierto && $('#pos-buscar-modal')) {
        $('#pos-buscar-modal').focus();
        $('#pos-buscar-modal').select();
        return;
      }
      if (modalAbierto) cerrarModal();
      if (!$('#tab-ventas')?.classList.contains('active')) irATab('ventas');
      abrirBuscarProductoPOS();
      return;
    }

    if (esF4) {
      e.preventDefault();
      if (modalAbierto) cerrarModal();
      if (!$('#tab-ventas')?.classList.contains('active')) irATab('ventas');
      abrirSelectorClientePOS();
      return;
    }

    if (esF8) {
      e.preventDefault();
      if (modalAbierto) cerrarModal();
      if (!$('#tab-ventas')?.classList.contains('active')) irATab('ventas');
      nuevaVentaPOS();
      return;
    }

    if (esF9) {
      e.preventDefault();
      if (modalAbierto) cerrarModal();
      if (!$('#tab-ventas')?.classList.contains('active')) {
        irATab('ventas');
        return;
      }
      const fp = $('#pos-forma-pago')?.value || 'efectivo';
      if (fp === 'efectivo') {
        const { total } = calcularTotalNumerico();
        const rec = $('#pos-recibido');
        if (rec && !Number(rec.value || 0) && total > 0) autocompletarRecibido(total, true);
      }
      $('#btn-vender')?.click();
      return;
    }

    // 3. Comportamiento dentro de un modal abierto
    if (modalAbierto) {
      // Escape cierra el modal
      if (key === 'Escape') {
        if (modal.querySelector('.ac-dropdown.visible')) return;
        e.preventDefault();
        cerrarModal();
        return;
      }

      // Tab trap
      if (key === 'Tab') {
        const modalEl = modal.querySelector('.modal');
        if (!modalEl) return;
        const focusables = [...modalEl.querySelectorAll(
          'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )].filter((el) => el.offsetParent !== null);
        if (!focusables.length) return;
        const primero = focusables[0];
        const ultimo = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === primero) {
          e.preventDefault();
          ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
          e.preventDefault();
          primero.focus();
        }
        return;
      }

      // Enter en input normal para confirmar modal (salvo inputs que gestionan su propio Enter)
      if (key === 'Enter' && !e.shiftKey) {
        const target = document.activeElement;
        if (!target || target.tagName !== 'INPUT') return;
        if (target.id === 'pos-buscar-modal' || target.id === 'cli-buscar-pos') return;
        if (modal.querySelector('.ac-dropdown.visible')) return;

        const botonPrimario = $('#modal-body')?.querySelector('.actions .btn:not(.ghost):not(.danger), button.btn:not(.ghost):not(.danger)');
        if (botonPrimario) {
          e.preventDefault();
          botonPrimario.click();
        }
        return;
      }
    }
  });
}

function actualizarClientePOS() {
  const nom = $('#pos-cliente-nombre');
  const nomTop = $('#pos-cliente-nombre-top');
  const doc = $('#pos-cliente-doc');
  if (nom) {
    if (!posClienteSel) { nom.textContent = 'Sin cliente'; if (doc) doc.textContent = 'Seleccionar cliente'; }
    else { nom.textContent = posClienteSel.nombre || posClienteSel.name || 'Cliente'; if (doc) doc.textContent = posClienteSel.documento || posClienteSel.document || posClienteSel.telefono || posClienteSel.phone || 'Sin documento'; }
  }
  if (nomTop) nomTop.textContent = posClienteSel ? (posClienteSel.nombre || posClienteSel.name || 'Cliente') : 'Sin cliente';
  actualizarComprobantePOS();
}

function textoBotonCobrar() {
  const tipo = $('#pos-tipo-comprobante')?.value === 'factura' ? 'Factura' : 'Ticket';
  return `<i data-lucide="check-circle"></i> Cobrar ${tipo} <kbd class="pos-kbd">F9</kbd>`;
}

function actualizarBotonCobrar() {
  const btn = $('#btn-vender');
  if (btn && !btn.disabled) { btn.innerHTML = textoBotonCobrar(); reicons(); }
}

function validarComprobantePOS(tipo) {
  if (tipo !== 'factura') return null;
  if (!posClienteSel) return 'Para emitir factura debe seleccionar un cliente';
  if (!(posClienteSel.nombre || posClienteSel.name) || !posClienteSel.documento) {
    return 'El cliente debe tener nombre y documento para emitir la factura';
  }
  const estado = posFiscalEstado || {};
  if (estado.emisorCompleto === false) return 'Completá nombre, RUC y actividad económica del emisor en Configuración';
  if (estado.timbradoVigente === false) return 'Configurá un timbrado vigente y los datos de establecimiento para esta sucursal';
  if (estado.rangoDisponible === false) return 'Se agotó el rango de numeración autorizado. Configurá el siguiente timbrado';
  return null;
}

function actualizarComprobantePOS() {
  const aviso = $('#pos-comprobante-aviso');
  if (!aviso) return;
  const esFactura = posTipoComprobante === 'factura';
  let clase = 'ok', icono = 'receipt';
  let texto = 'Ticket interno · se emite a Consumidor Final';
  let accion = '';
  if (esFactura) {
    if (!posClienteSel) {
      clase = 'warn'; icono = 'alert-triangle';
      texto = 'Factura: elegí un cliente con nombre y documento.';
      accion = '<button class="btn small ghost" onclick="abrirSelectorClientePOS()"><i data-lucide="user"></i> Elegir cliente</button>';
    } else {
      const error = validarComprobantePOS('factura');
      const nombre = escapeHtml(posClienteSel.nombre || posClienteSel.name || 'Cliente');
      const doc = posClienteSel.documento ? ' · ' + escapeHtml(posClienteSel.documento) : '';
      if (error) {
        clase = 'warn'; icono = 'alert-triangle';
        texto = `Factura para ${nombre}${doc}: ${error}`;
        accion = '<button class="btn small ghost" onclick="irATab(\'config\')"><i data-lucide="settings"></i> Configuración</button>';
      } else {
        icono = 'badge-check';
        texto = `Factura lista para ${nombre}${doc}`;
      }
    }
  }
  aviso.className = `pos-comprobante-aviso ${clase}`;
  aviso.innerHTML = `<i data-lucide="${icono}"></i><span style="flex:1">${texto}</span>${accion}`;
  reicons();
}

function abrirSelectorClientePOS() {
  const opts = '<option value="">Consumidor Final</option>' + clientesGlobal.map((c) => `<option value="${c.id}" ${posClienteSel && posClienteSel.id == c.id ? 'selected' : ''}>${escapeHtml(c.nombre || c.name || (c.tipo_documento + ' ' + c.documento))}</option>`).join('');
  abrirModal('Seleccionar cliente', `
    <div id="cli-wrap" class="ac-wrap"><label>Buscar por nombre o documento
      <input id="cli-buscar-pos" placeholder="Tipeá para buscar..." autocomplete="off"></label></div>
    <label>Cliente
      <select id="cli-select-pos">${opts}</select></label>
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
      <button class="btn small ghost" onclick="cerrarModal(); abrirClienteModal(null)"><i data-lucide="user-plus"></i> Nuevo cliente</button>
    </div>
    <div class="actions" style="margin-top:18px;justify-content:space-between">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" onclick="aplicarClientePOS()">Aplicar</button>
    </div>`);
  armarAutocompletarCliente('#cli-buscar-pos', '#cli-wrap', (c) => {
    $('#cli-select-pos').value = c.id;
  });
  reicons();
}

function aplicarClientePOS() {
  const sel = $('#cli-select-pos').value;
  if (!sel) {
    posClienteSel = null;
  } else {
    posClienteSel = clientesGlobal.find((c) => c.id == sel) || null;
  }
  actualizarClientePOS();
  cerrarModal();
}

// Precarga el importe recibido con el total a cobrar. Si el operador ya lo
// editó (porque entregan un billete mayor), respeta su valor; `forzar` se usa
// para volver al total exacto desde el botón "Usar total" o los atajos.
function autocompletarRecibido(total, forzar = false) {
  const rec = $('#pos-recibido');
  if (!rec || (posRecibidoManual && !forzar)) return;
  const valor = Math.round(Number(total || 0) * 100) / 100;
  const texto = valor ? String(valor) : '';
  if (rec.value !== texto) rec.value = texto;
  if (forzar) posRecibidoManual = false;
}

function usarTotalRecibido() {
  const { total } = calcularTotalNumerico();
  autocompletarRecibido(total, true);
  $('#pos-recibido')?.focus();
}

function calcularVuelto() {
  const fp = $('#pos-forma-pago')?.value || 'efectivo';
  const mixtos = $('#pos-pagos-mixtos');
  const recEl = $('#pos-recibido');
  const grp = $('#pos-recibido-group');
  const label = $('#pos-recibido-label');
  const btnTotal = $('#btn-recibido-total');
  const wrap = $('#pos-vuelto-wrap');
  const val = $('#pos-vuelto');
  const swrap = $('#pos-saldo-wrap');
  const sval = $('#pos-saldo');
  const { totalNum } = (function () { const t = $('#pos-total-pagar')?.textContent || '₲ 0'; return { totalNum: Number(String(t).replace(/[^0-9]/g, '')) }; })();
  if (mixtos) mixtos.style.display = fp === 'mixto' ? 'block' : 'none';
  if (btnTotal) btnTotal.style.display = fp === 'efectivo' ? '' : 'none';
  if (fp === 'efectivo') autocompletarRecibido(totalNum);
  if (swrap) swrap.style.display = 'none';
  if (fp === 'mixto') {
    if (grp) grp.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    const pagado = ['efectivo', 'transferencia', 'tarjeta'].reduce(
      (total, medio) => total + Math.max(0, Number($(`#pos-pago-${medio}`)?.value || 0)), 0
    );
    const resumen = $('#pos-pagos-mixtos-resumen');
    if (resumen) {
      const diferencia = totalNum - pagado;
      resumen.textContent = Math.abs(diferencia) < 0.01
        ? `Desglose completo: ${fmtGs(pagado)}`
        : diferencia > 0
          ? `Falta asignar ${fmtGs(diferencia)}`
          : `El desglose excede el total por ${fmtGs(Math.abs(diferencia))}`;
    }
    return;
  }
  if (fp === 'efectivo') {
    if (grp) grp.style.display = 'flex';
    if (label) label.textContent = 'Monto recibido (editable)';
    const recibido = Number(recEl?.value || 0);
    if (recibido >= totalNum && totalNum > 0) {
      if (wrap) wrap.style.display = 'flex';
      if (val) val.textContent = fmtGs(recibido - totalNum);
    } else {
      if (wrap) wrap.style.display = 'none';
    }
    return;
  }
  if (fp === 'credito') {
    if (grp) grp.style.display = 'flex';
    if (label) label.textContent = 'Abono inicial (opcional)';
    if (wrap) wrap.style.display = 'none';
    const recibido = Number(recEl?.value || 0);
    const saldo = Math.max(0, totalNum - recibido);
    if (saldo > 0 && swrap) { swrap.style.display = 'flex'; if (sval) sval.textContent = fmtGs(saldo); }
    else if (swrap) swrap.style.display = 'none';
    return;
  }
  if (grp) grp.style.display = 'none';
  if (wrap) wrap.style.display = 'none';
}

// ── Checkout ──────────────────────────────────────────────
function abrirCheckout(clientePreseleccionado) {
  if (!carrito.size) return toast('El ticket está vacío', 'warn');
  let total = 0;
  for (const [id, cant] of carrito) {
    const producto = productosGlobal.find((x) => x.id === id);
    if (producto) total += importesCarrito.get(id) ?? producto.precio_venta * cant;
  }
  const clienteOpts = '<option value="">Consumidor Final</option>' + clientesGlobal.map((c) => `<option value="${c.id}">${escapeHtml(c.nombre || (c.tipo_documento + ' ' + c.documento))}</option>`).join('');
  abrirModal('Cobrar', `
    <div class="checkout-total">
      <div class="monto">${fmtGs(total)}</div>
      <div class="etiqueta">Total a cobrar</div>
    </div>
    <div class="form-row">
      <div><label>Comprobante
        <select id="co-tipo">
          <option value="ticket">Ticket interno</option>
          <option value="factura">Factura con timbrado</option>
        </select></label></div>
      <div><label>Forma de pago
        <select id="co-pago">
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="mixto">Pago combinado</option>
        </select></label></div>
    </div>
    <div id="co-pagos-mixtos" style="display:none">
      <div class="form-row">
        <div><label>Efectivo<input type="number" id="co-pago-efectivo" min="0" placeholder="0"></label></div>
        <div><label>Transferencia<input type="number" id="co-pago-transferencia" min="0" placeholder="0"></label></div>
        <div><label>Tarjeta<input type="number" id="co-pago-tarjeta" min="0" placeholder="0"></label></div>
      </div>
      <p class="muted" id="co-pagos-resumen">Los importes deben sumar el total de la venta.</p>
    </div>
    <div id="co-doc-wrap" class="ac-wrap"><label>Buscar cliente por documento (CI o RUC)
      <input id="co-doc" placeholder="Tipeá la cédula o el RUC..." autocomplete="off"></label></div>
    <label>Cliente
      <select id="co-cliente">${clienteOpts}</select></label>
    <div style="display:flex;gap:8px;align-items:center;margin:6px 0 2px">
      <button class="btn small ghost" onclick="nuevoClienteDesdeCheckout()"><i data-lucide="user-plus"></i> Nuevo cliente</button>
      <p class="muted" id="co-aviso" style="margin:0;display:none">La factura requiere timbrado vigente, datos fiscales y cliente identificado.</p>
    </div>
    <label id="co-recibido-wrap" style="display:none">Efectivo recibido
      <input type="number" id="co-recibido" placeholder="0" min="0"></label>
    <div class="vuelto" id="co-vuelto"></div>
    <div class="actions" style="margin-top:18px;justify-content:space-between">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" style="margin-top:0;padding:12px 24px" onclick="confirmarVenta()"><i data-lucide="check-circle"></i> Confirmar pago</button>
    </div>`);
  if (clientePreseleccionado) $('#co-cliente').value = clientePreseleccionado;
  $('#modal').classList.add('compact');
  const tipo = $('#co-tipo'), pago = $('#co-pago'), recibido = $('#co-recibido'), vuelto = $('#co-vuelto'), aviso = $('#co-aviso'), wrap = $('#co-recibido-wrap');
  armarAutocompletarCliente('#co-doc', '#co-doc-wrap', (c) => {
    $('#co-cliente').value = c.id;
    if (tipo.value === 'factura') aviso.style.display = 'none';
  });
  const recalcular = () => {
    const ef = pago.value === 'efectivo';
    wrap.style.display = ef ? 'block' : 'none';
    const mixtos = pago.value === 'mixto';
    $('#co-pagos-mixtos').style.display = mixtos ? 'block' : 'none';
    const r = parseFloat(recibido.value) || 0;
    vuelto.classList.toggle('visible', ef && r > total);
    vuelto.textContent = r > total ? `Vuelto: ${fmtGs(r - total)}` : '';
    if (mixtos) {
      const suma = ['efectivo', 'transferencia', 'tarjeta'].reduce(
        (a, medio) => a + Number($(`#co-pago-${medio}`).value || 0), 0
      );
      const diferencia = total - suma;
      $('#co-pagos-resumen').textContent = Math.abs(diferencia) < 0.01
        ? `Desglose completo: ${fmtGs(suma)}`
        : diferencia > 0
          ? `Falta asignar ${fmtGs(diferencia)}`
          : `El desglose excede el total por ${fmtGs(Math.abs(diferencia))}`;
    }
  };
  tipo.addEventListener('change', () => { aviso.style.display = tipo.value === 'factura' ? 'block' : 'none'; });
  pago.addEventListener('change', () => {
    if (pago.value === 'efectivo' && !recibido.value) recibido.value = total;
    recalcular();
  });
  recibido.addEventListener('input', recalcular);
  ['efectivo', 'transferencia', 'tarjeta'].forEach((medio) => {
    $(`#co-pago-${medio}`).addEventListener('input', recalcular);
  });
  if (pago.value === 'efectivo') recibido.value = total;
  recalcular();
  reicons();
}

async function nuevoClienteDesdeCheckout() {
  checkoutReabrir = true;
  const doc = $('#co-doc') ? $('#co-doc').value.trim() : '';
  abrirClienteModal(null, doc);
}
let checkoutReabrir = false;

async function confirmarVenta() {
  const tipo = $('#co-tipo').value;
  const clienteId = parseInt($('#co-cliente').value) || null;
  if (tipo === 'factura' && !clienteId) return toast('La factura requiere un cliente identificado.', 'warn');
  const pago = $('#co-pago').value;
  const recibido = parseFloat($('#co-recibido').value) || 0;
  const total = [...carrito.entries()].reduce((suma, [id, cantidad]) => {
    const producto = productosGlobal.find((p) => p.id === id);
    return suma + (producto ? importesCarrito.get(id) ?? producto.precio_venta * cantidad : 0);
  }, 0);
  if (pago === 'efectivo' && recibido < total) return toast('El monto recibido es menor al total', 'warn');
  let pagos;
  if (pago === 'mixto') {
    pagos = Object.fromEntries(['efectivo', 'transferencia', 'tarjeta'].map((medio) => [
      medio, Number($(`#co-pago-${medio}`).value || 0),
    ]));
    const suma = Object.values(pagos).reduce((a, b) => a + b, 0);
    if (Object.values(pagos).some((monto) => !Number.isFinite(monto) || monto < 0) || Math.abs(suma - total) > 0.009) {
      return toast('Los medios de pago deben sumar exactamente el total de la venta', 'warn');
    }
  }
  const btn = $('#modal').querySelector('.actions .btn:last-child');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto"></div>';
  const items = [...carrito.entries()].map(([id, cantidad]) => ({
    producto_id: id, cantidad,
    ...(importesCarrito.has(id) ? { importe: importesCarrito.get(id) } : {}),
  }));
  try {
    const r = await post('/api/ventas', bodySucOperativa({ items, forma_pago: pago, cliente_id: clienteId, tipo, pagos }));
    imprimirTicket(r.venta_id);
    carrito.clear();
    importesCarrito.clear();
    pintarTicket();
    cargarComprobantes();
    cargarCaja();
    const vuelto = (pago === 'efectivo' && recibido > r.total) ? recibido - r.total : 0;
    const cliente = clientesGlobal.find((c) => c.id === clienteId);
    abrirModal(`${r.tipo === 'factura' ? 'Factura' : 'Comprobante'} N° ${r.numero_comprobante}`, `
      <div class="checkout-total" style="margin:0 0 6px">
        <div class="monto" style="color:var(--verde)">${fmtGs(r.total)}</div>
        <div class="etiqueta">${cliente ? escapeHtml(cliente.nombre) : 'Consumidor Final'} · ${r.tipo === 'factura' ? 'Factura' : 'Ticket interno'} · ${pago}</div>
      </div>
      ${vuelto > 0 ? `<div class="vuelto visible" style="margin:0 0 6px">Vuelto: ${fmtGs(vuelto)}</div>` : ''}
      <p class="msg ok" style="text-align:center">Venta cobrada correctamente</p>
      <button class="btn" style="width:100%;margin-top:14px" onclick="cerrarModal(); cargarPos();"><i data-lucide="shopping-cart"></i> Nueva venta</button>`);
    $('#modal').classList.add('compact');
    reicons();
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="check-circle"></i> Confirmar pago';
    reicons();
  }
}

async function imprimirTicket(ventaId, ventana = null, esReimpresion = false) {
  let ventanaImpresion = ventana;
  try {
    const [v, cfg] = await Promise.all([api('/api/ventas/' + ventaId), api('/api/config')]);
    const esFactura = v.tipo === 'factura';
    const fiscalCompleto = esFactura && v.fiscal_timbrado && v.fiscal_vigencia &&
      v.fiscal_establecimiento && v.fiscal_punto_expedicion && v.emisor_ruc &&
      v.detalles.every((d) => d.iva_tasa !== null && d.iva_tasa !== undefined);
    const nroFormateado = fiscalCompleto
      ? `${v.fiscal_establecimiento}-${v.fiscal_punto_expedicion}-${String(v.numero_comprobante).padStart(7, '0')}`
      : String(v.numero_comprobante).padStart(4, '0');
    const cant = (n) => Number(n || 0).toLocaleString('es-PY', { maximumFractionDigits: 3 });
    const sumasIva = { exenta: 0, base5: 0, iva5: 0, base10: 0, iva10: 0 };
    if (fiscalCompleto) {
      for (const d of v.detalles) {
        const base = Number(d.iva_base || 0);
        const iva = Number(d.iva_monto || 0);
        if (Number(d.iva_tasa) === 0) sumasIva.exenta += base;
        if (Number(d.iva_tasa) === 5) { sumasIva.base5 += base; sumasIva.iva5 += iva; }
        if (Number(d.iva_tasa) === 10) { sumasIva.base10 += base; sumasIva.iva10 += iva; }
      }
    }
    const lineas = v.detalles.map((d) => {
      const importe = (d.importe ?? (d.precio || 0) * (d.cantidad || 0)) - (d.descuento || 0);
      if (!fiscalCompleto) {
        return `<tr class="producto-ticket">
          <td><strong>${escapeHtml(d.nombre)}</strong><small>${cant(d.cantidad)} × ${fmtGs2(d.precio)}${d.unidad === 'kg' ? '/kg' : ''}</small></td>
          <td class="num">${fmtGs2(importe)}</td>
        </tr>`;
      }
      const exenta = Number(d.iva_tasa) === 0 ? Number(d.iva_base || 0) : 0;
      const gravada5 = Number(d.iva_tasa) === 5 ? Number(d.iva_base || 0) : 0;
      const gravada10 = Number(d.iva_tasa) === 10 ? Number(d.iva_base || 0) : 0;
      const categoriaIva = Number(d.iva_tasa) === 0 ? `Exenta ${fmtGs2(exenta)}`
        : Number(d.iva_tasa) === 5 ? `Gravada 5% ${fmtGs2(gravada5)}`
          : `Gravada 10% ${fmtGs2(gravada10)}`;
      return `<tr class="producto-fiscal">
        <td class="cantidad">${cant(d.cantidad)}</td>
        <td><strong>${escapeHtml(d.nombre)}</strong><small>${categoriaIva} · ${fmtGs2(d.precio)}${d.unidad === 'kg' ? '/kg' : ''}</small></td>
        <td class="num">${fmtGs2(importe)}</td>
      </tr>`;
    }).join('');
    const contenido = cfg.logo
      ? `<img class="c-logo" src="${cfg.logo}" alt="Logo">`
      : '';
    const clienteNombre = v.cliente_nombre_snapshot || v.cliente_nombre || 'Consumidor Final';
    const clienteDocumento = v.cliente_documento_snapshot || v.cliente_documento || '';
    const cabeceraFiscal = fiscalCompleto ? `
      <div class="fiscal-head">
        <div><b>RUC:</b> ${escapeHtml(v.emisor_ruc)}</div>
        <div><b>${escapeHtml(v.emisor_nombre || cfg.nombre_negocio)}</b></div>
        <div>${escapeHtml(v.emisor_actividad || '')}</div>
        <div>${escapeHtml(v.emisor_direccion || '')}${v.emisor_ciudad ? ' · ' + escapeHtml(v.emisor_ciudad) : ''}</div>
        ${v.emisor_telefono ? `<div>Tel.: ${escapeHtml(v.emisor_telefono)}</div>` : ''}
        <div class="tipo">FACTURA</div>
        <div><b>Timbrado N°:</b> ${escapeHtml(v.fiscal_timbrado)}</div>
        <div><b>Vigencia:</b> ${fmtFecha(v.fiscal_vigencia)}</div>
        <div class="numero"><b>${escapeHtml(nroFormateado)}</b></div>
        <div><b>Fecha de emisión:</b> ${fmtFecha(v.fecha)}</div>
      </div>
      <div class="cliente"><b>Señor(es):</b> ${escapeHtml(clienteNombre)}<br>
        <b>${escapeHtml(v.cliente_tipo_documento_snapshot || 'Documento')}:</b> ${escapeHtml(clienteDocumento)}
        <span class="condicion"><b>Condición:</b> ${v.forma_pago === 'credito' ? 'Crédito' : 'Contado'}</span>
      </div>` : '';
    const tabla = fiscalCompleto
      ? `<table class="tabla-fiscal"><thead><tr><th class="cantidad">Cant.</th><th>Descripción</th><th class="num">Importe</th></tr></thead><tbody>${lineas}</tbody></table>`
      : `<table class="tabla-ticket"><thead><tr><th>Producto</th><th class="num">Importe</th></tr></thead><tbody>${lineas}</tbody></table>`;
    const resumenIva = fiscalCompleto ? `
      <div class="iva-resumen">
        <div>Exentas: <b>${fmtGs2(sumasIva.exenta)}</b></div>
        <div>Gravadas 5%: <b>${fmtGs2(sumasIva.base5)}</b> · IVA 5%: <b>${fmtGs2(sumasIva.iva5)}</b></div>
        <div>Gravadas 10%: <b>${fmtGs2(sumasIva.base10)}</b> · IVA 10%: <b>${fmtGs2(sumasIva.iva10)}</b></div>
        <div class="tot">Total IVA incluido: ${fmtGs2(v.total || 0)}</div>
      </div>` : '';
    const w = ventanaImpresion || window.open('', '_blank', 'width=400,height=800');
    if (!w) return toast('El navegador bloqueó la ventana de impresión. Permití ventanas emergentes para este sitio.', 'warn');
    ventanaImpresion = w;
    w.document.write(`<html><head><title>${fiscalCompleto ? 'Factura' : esFactura ? 'Copia informativa' : 'Ticket'} ${nroFormateado}</title>
      <style>
        *{box-sizing:border-box}html,body{width:80mm;max-width:80mm;margin:0;padding:0;color:#111}
        body{padding:3mm;font-family:Arial,sans-serif;font-size:9pt;overflow-wrap:anywhere}
        body.ticket{font-family:'Courier New',monospace;font-size:8.5pt}
        .logo{display:flex;flex-direction:column;align-items:center;margin-bottom:5px}.c-logo{display:block;margin:0 auto 4px;max-width:68mm;max-height:22mm;object-fit:contain}
        h2{text-align:center;margin:0;font-size:14pt}.tc{text-align:center;font-size:8pt;line-height:1.4}.tipo{border:1px solid #111;padding:4px;text-align:center;font-weight:bold;margin:6px 0}
        table{width:100%;table-layout:fixed;border-collapse:collapse;margin:7px 0;font-size:8pt}th,td{border-bottom:1px solid #777;padding:3px 2px;vertical-align:top;overflow-wrap:anywhere}th{font-size:7.5pt;text-align:left;border-top:1px solid #333;border-bottom:1px solid #333}.num{text-align:right;white-space:nowrap}
        .cantidad{width:12%;text-align:center}.tabla-fiscal th:nth-child(2){width:53%}.tabla-fiscal th:nth-child(3){width:35%}
        .tabla-ticket th:first-child{width:68%}.tabla-ticket th:last-child{width:32%}
        .producto-ticket td small,.producto-fiscal td small{display:block;margin-top:2px;font-size:7pt;line-height:1.25}
        .linea{border-top:1px dashed #333;margin:7px 0}.tot{font-size:10pt;font-weight:bold;text-align:right;margin-top:6px}.fp{margin-top:5px;font-size:8pt;line-height:1.4}
        .fiscal-head{text-align:center;line-height:1.4;overflow-wrap:anywhere}.fiscal-head .tipo{width:100%;margin:6px auto}.numero{font-size:11pt;margin:4px}
        .cliente{border:1px solid #333;padding:5px;margin:7px 0;line-height:1.4;overflow-wrap:anywhere}.condicion{display:block}
        .iva-resumen{width:100%;margin:7px 0 0;line-height:1.45;font-size:8pt}.aviso{border:1px solid #111;padding:5px;margin:7px 0;font-weight:bold;text-align:center;font-size:8pt}
        .marca-estado{border:2px solid #111;padding:5px;margin:7px 0;text-align:center;font-weight:bold}
        .centro{text-align:center;margin-top:9px;font-size:7pt}
        @page{size:80mm auto;margin:0}
        @media print{html,body{width:80mm;max-width:80mm;margin:0;padding:0}body{padding:3mm}}
      </style></head><body class="${fiscalCompleto ? 'factura' : 'ticket'}">
      ${contenido ? `<div class="logo">${contenido}</div>` : ''}
      ${fiscalCompleto ? cabeceraFiscal : `
        <div class="logo"><h2>${escapeHtml(cfg.nombre_negocio || 'Panadería')}</h2></div>
        <div class="tc">${escapeHtml(cfg.ciudad || '')}${cfg.telefono ? ' · ' + escapeHtml(cfg.telefono) : ''}</div>
        <div class="tipo">${esFactura ? 'COPIA INFORMATIVA — NO VÁLIDA COMO FACTURA' : 'COMPROBANTE INTERNO'}</div>
        <div class="tc">Fecha: ${fmtFecha(v.fecha)}<br>N° interno: ${nroFormateado}</div>
        <div class="fp"><b>Cliente:</b> ${escapeHtml(clienteNombre)}${clienteDocumento ? `<br><b>Documento:</b> ${escapeHtml(clienteDocumento)}` : ''}</div>`}
      ${v.anulada ? '<div class="marca-estado">VENTA ANULADA</div>' : esReimpresion ? '<div class="marca-estado">COPIA · REIMPRESIÓN</div>' : ''}
      ${tabla}
      ${v.descuento > 0 ? `<div class="fp">Descuento: -${fmtGs2(v.descuento)}</div>` : ''}
      ${fiscalCompleto ? resumenIva : `<div class="tot">TOTAL: ${fmtGs2(v.total || 0)}</div>`}
      <div class="fp">Forma de pago: <b>${escapeHtml(v.forma_pago === 'mixto' && v.pagos?.length ? `Combinado (${v.pagos.map((p) => `${p.forma_pago}: ${fmtGs2(p.monto)}`).join(' · ')})` : v.forma_pago)}</b></div>
      ${v.forma_pago === 'credito' ? `<div class="fp">Pagado: <b>${fmtGs2(v.pagado || 0)}</b> · Saldo: <b>${fmtGs2(Math.max(0, (v.total || 0) - (v.pagado || 0)))}</b></div>` : ''}
      <div class="centro">${fiscalCompleto ? 'Documento impreso por el sistema de gestión.' : '¡Gracias por su compra!'}</div>
      <script>window.onload=function(){window.print()}<\/script>
    </body></html>`);
    w.document.close();
  } catch (e) {
    if (ventanaImpresion && !ventanaImpresion.closed) ventanaImpresion.close();
    console.error(e);
    toast('No se pudo preparar la impresión del comprobante.', 'err');
  }
}

function labelCliente(v) {
  const doc = v.cliente_documento || v.documento || '';
  if (v.cliente_nombre) return v.cliente_nombre + (doc ? ` · ${doc}` : '');
  if (doc) return doc;
  return 'Consumidor Final';
}

async function cargarComprobantes() {
  const ventas = await api(withSucOperativa('/api/ventas'));
  if (!ventas.length) {
    $('#tabla-ventas').innerHTML = '<tr><th>N°</th><th>Tipo</th><th>Fecha</th><th>Cliente</th><th>Forma</th><th>Total</th><th></th></tr>' + emptyStateHtml('receipt', 'Sin comprobantes hoy', 'Las ventas de hoy aparecerán aquí');
    return;
  }
  $('#tabla-ventas').innerHTML = '<tr><th>N°</th><th>Tipo</th><th>Fecha</th><th>Cliente</th><th>Forma</th><th>Total</th><th></th></tr>' +
    ventas.map((v) => `<tr class="${v.anulada ? 'anulada' : ''}">
      <td>${v.tipo === 'factura' ? 'F-' : ''}${v.numero_comprobante}</td>
      <td><span class="tag ${v.tipo === 'factura' ? 'factura' : 'ticket'}">${v.tipo === 'factura' ? 'Factura' : 'Ticket'}</span></td>
      <td>${fmtFecha(v.fecha)}</td>
      <td>${escapeHtml(labelCliente(v))}</td>
      <td><span class="tag ${v.forma_pago}">${v.forma_pago}</span></td>
      <td><b>${fmtGs(v.total)}</b></td>
      <td>${v.anulada ? '<span class="tag ambar">Anulada</span>' : `<button class="btn small danger" onclick="anularVenta(${v.id})"><i data-lucide="ban"></i> Anular</button>`}</td>
    </tr>`).join('');
}

let ventasPaginaActual = 1;
const ventasLimite = 50;

async function cargarHistorialVentas(resetPagina = false) {
  if (resetPagina) ventasPaginaActual = 1;
  const desde = $('#ventas-desde');
  const hasta = $('#ventas-hasta');
  if (!desde || !hasta) return;
  if (!desde.value) desde.value = fechaHoy();
  if (!hasta.value) hasta.value = fechaHoy();

  const tabla = $('#tabla-control-ventas');
  tabla.innerHTML = '<tbody>' + emptyStateHtml('loader-circle', 'Cargando ventas...') + '</tbody>';
  const filtro = new URLSearchParams({
    desde: desde.value,
    hasta: hasta.value,
    tipo: $('#ventas-tipo').value,
    estado: $('#ventas-estado').value,
    forma_pago: $('#ventas-forma-pago').value,
    q: $('#ventas-buscar').value.trim(),
    pagina: String(ventasPaginaActual),
    limite: String(ventasLimite),
  });
  try {
    const resultado = await api(withSucOperativa('/api/ventas/consulta?' + filtro.toString()));
    const total = Number(resultado.total || 0);
    const paginas = Math.max(1, Math.ceil(total / ventasLimite));
    if (ventasPaginaActual > paginas) {
      ventasPaginaActual = paginas;
      return cargarHistorialVentas();
    }

    $('#ventas-cantidad').textContent = total.toLocaleString('es-PY');
    $('#ventas-total-vigente').textContent = fmtGs(resultado.total_vigente);
    $('#ventas-cantidad-anulada').textContent = Number(resultado.anuladas || 0).toLocaleString('es-PY');
    $('#ventas-pagina').textContent = `Página ${ventasPaginaActual} de ${paginas}`;
    $('#ventas-anterior').disabled = ventasPaginaActual <= 1;
    $('#ventas-siguiente').disabled = ventasPaginaActual >= paginas;

    if (!resultado.ventas.length) {
      tabla.innerHTML = '<thead><tr><th>N.º</th><th>Fecha</th><th>Comprobante</th><th>Cliente</th><th>Pago</th><th>Total</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' +
        emptyStateHtml('receipt', 'No hay ventas para estos filtros') + '</tbody>';
      return;
    }
    tabla.innerHTML = '<thead><tr><th>N.º</th><th>Fecha</th><th>Comprobante</th><th>Cliente</th><th>Sucursal</th><th>Pago</th><th>Total</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' +
      resultado.ventas.map((v) => `<tr class="${v.anulada ? 'anulada' : ''}">
        <td>${v.tipo === 'factura' && v.fiscal_establecimiento && v.fiscal_punto_expedicion
          ? `${escapeHtml(v.fiscal_establecimiento)}-${escapeHtml(v.fiscal_punto_expedicion)}-`
          : v.tipo === 'factura' ? 'F-' : ''}${String(v.numero_comprobante).padStart(v.tipo === 'factura' ? 7 : 4, '0')}</td>
        <td>${fmtFecha(v.fecha)}</td>
        <td><span class="tag ${v.tipo === 'factura' ? 'factura' : 'ticket'}">${v.tipo === 'factura' ? 'Factura' : 'Ticket'}</span></td>
        <td>${escapeHtml(labelCliente(v))}</td>
        <td>${escapeHtml(v.sucursal_nombre || '—')}</td>
        <td><span class="tag ${escapeAttr(v.forma_pago)}">${escapeHtml(v.forma_pago)}</span></td>
        <td><b>${fmtGs(v.total)}</b>${Number(v.saldo) > 0 ? `<small class="ventas-saldo">Saldo: ${fmtGs(v.saldo)}</small>` : ''}</td>
        <td>${v.anulada ? '<span class="tag ambar">Anulada</span>' : `<span class="tag ${v.estado_pago === 'pendiente' ? 'ambar' : 'ok'}">${v.estado_pago === 'pendiente' ? 'Pendiente' : 'Pagada'}</span>`}</td>
        <td><div class="actions ventas-acciones">
          <button type="button" class="btn small ghost" onclick="verDetalleVenta(${v.id})" aria-label="Ver detalle"><i data-lucide="eye"></i></button>
          <button type="button" class="btn small ghost" onclick="reimprimirVenta(${v.id})" aria-label="Reimprimir"><i data-lucide="printer"></i></button>
          ${v.anulada
            ? '<button type="button" class="btn small ghost" disabled aria-label="Venta ya anulada" title="Venta ya anulada"><i data-lucide="ban"></i></button>'
            : `<button type="button" class="btn small danger" onclick="anularVenta(${v.id}, true)" aria-label="Anular venta" title="Anular venta"><i data-lucide="ban"></i></button>`}
        </div></td>
      </tr>`).join('') + '</tbody>';
    reicons();
  } catch (e) {
    tabla.innerHTML = '<tbody>' + emptyStateHtml('circle-alert', 'No se pudieron cargar las ventas') + '</tbody>';
    toast(e.message, 'err');
  }
}

$('#ventas-filtros')?.addEventListener('submit', (e) => {
  e.preventDefault();
  cargarHistorialVentas(true);
});
$('#ventas-anterior')?.addEventListener('click', () => {
  if (ventasPaginaActual > 1) { ventasPaginaActual--; cargarHistorialVentas(); }
});
$('#ventas-siguiente')?.addEventListener('click', () => {
  ventasPaginaActual++;
  cargarHistorialVentas();
});

async function verDetalleVenta(id) {
  try {
    const v = await api('/api/ventas/' + id);
    const productos = v.detalles.map((d) => `<tr>
      <td>${escapeHtml(d.nombre)}</td>
      <td class="right">${Number(d.cantidad).toLocaleString('es-PY', { maximumFractionDigits: 3 })}${d.unidad === 'kg' ? ' kg' : ''}</td>
      <td class="right">${fmtGs(d.precio)}</td>
      <td class="right"><b>${fmtGs(Number(d.importe ?? Number(d.precio) * Number(d.cantidad)) - Number(d.descuento || 0))}</b></td>
    </tr>`).join('');
    const textoPago = v.forma_pago === 'mixto' && v.pagos?.length
      ? `Combinado (${v.pagos.map((p) => `${p.forma_pago} ${fmtGs(p.monto)}`).join(' + ')})`
      : v.forma_pago;
    abrirModal(`Detalle de ${v.tipo === 'factura' ? 'factura' : 'ticket'} N.º ${v.numero_comprobante}`, `
      <div class="venta-detalle-meta">
        <div><span>Fecha</span><b>${fmtFecha(v.fecha)}</b></div>
        <div><span>Cliente</span><b>${escapeHtml(labelCliente(v))}</b></div>
        <div><span>Sucursal</span><b>${escapeHtml(v.sucursal_nombre || '—')}</b></div>
        <div><span>Pago</span><b>${escapeHtml(textoPago)}</b></div>
        <div><span>Estado</span><b>${v.anulada ? 'Anulada' : v.estado_pago === 'pendiente' ? 'Pendiente' : 'Pagada'}</b></div>
      </div>
      <div class="pos-table-wrap"><table class="venta-detalle-tabla">
        <thead><tr><th>Producto</th><th class="right">Cant.</th><th class="right">Precio</th><th class="right">Importe</th></tr></thead>
        <tbody>${productos}</tbody>
      </table></div>
      ${v.descuento > 0 ? `<p class="venta-detalle-total">Descuento: −${fmtGs(v.descuento)}</p>` : ''}
      <p class="venta-detalle-total">Total: <b>${fmtGs(v.total)}</b></p>
      ${Number(v.saldo) > 0 ? `<p class="venta-detalle-total">Pagado: ${fmtGs(v.pagado)} · Saldo: <b>${fmtGs(v.saldo)}</b></p>` : ''}
      ${v.anulada ? `
        <div class="msg err" style="margin:12px 0;padding:10px;border-radius:8px">
          <b>Venta anulada</b>${v.anulado_en ? ` el ${fmtFechaHora(v.anulado_en)}` : ''}${v.anulado_por_usuario ? ` por <b>${escapeHtml(v.anulado_por_usuario)}</b>` : ''}.
          ${v.motivo_anulacion ? `<br><b>Motivo:</b> ${escapeHtml(v.motivo_anulacion)}` : ''}
        </div>` : ''}
      <div class="actions venta-detalle-acciones">
        <button type="button" class="btn ghost" onclick="reimprimirVenta(${v.id})"><i data-lucide="printer"></i> Reimprimir</button>
        ${v.anulada ? '' : `<button type="button" class="btn danger" onclick="anularVenta(${v.id}, true)"><i data-lucide="ban"></i> Anular venta</button>`}
      </div>`);
    reicons();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function reimprimirVenta(id) {
  const ventana = window.open('', '_blank', 'width=400,height=800');
  if (!ventana) return toast('El navegador bloqueó la ventana de impresión. Permití ventanas emergentes para este sitio.', 'warn');
  imprimirTicket(id, ventana, true);
}

async function anularVenta(id, desdeControl = false) {
  abrirModal('Anular venta', `
    <p class="msg err" style="background:var(--rojo-bg);padding:10px;border-radius:8px">
      <b>Se devolverá el stock y se registrará el egreso correspondiente en caja si está abierta.</b><br>
      Esta acción queda registrada en la auditoría del sistema.
    </p>
    <label style="margin-top:14px;display:block"><b>Motivo de la anulación:</b>
      <select id="anul-motivo-sel" class="pos-select full" style="margin-top:6px" onchange="const otro=$('#anul-motivo-otro');if(this.value==='otro'){otro.style.display='block';otro.focus();}else{otro.style.display='none';}">
        <option value="Error en comprobante / importe">Error en comprobante / importe</option>
        <option value="Cliente desistió de la compra">Cliente desistió de la compra</option>
        <option value="Comprobante duplicado">Comprobante duplicado</option>
        <option value="Producto o peso equivocado">Producto o peso equivocado</option>
        <option value="otro">Otro motivo (especificar)...</option>
      </select>
    </label>
    <input id="anul-motivo-otro" placeholder="Escribí el motivo detallado..." style="display:none;margin-top:8px;width:100%">
    <div class="actions" style="margin-top:16px;justify-content:space-between">
      <button type="button" class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button type="button" class="btn danger" id="btn-confirmar-anulacion"><i data-lucide="ban"></i> Confirmar anulación</button>
    </div>
  `);
  reicons();
  $('#btn-confirmar-anulacion')?.addEventListener('click', async () => {
    const sel = $('#anul-motivo-sel')?.value || '';
    const otro = $('#anul-motivo-otro')?.value?.trim() || '';
    const motivo = sel === 'otro' ? (otro || 'Otro motivo no especificado') : sel;
    try {
      await post(`/api/ventas/${id}/anular`, { motivo });
      toast('Venta anulada. El stock fue devuelto.', 'warn');
      cerrarModal();
      if (desdeControl) await cargarHistorialVentas();
      if ($('#tab-ventas').classList.contains('active')) cargarComprobantes();
      cargarDashboard();
      cargarCaja();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

// ── Modal helper ──────────────────────────────────────────
const modal = $('#modal');
let elementoPrevioModal = null;

function abrirModal(titulo, html) {
  elementoPrevioModal = document.activeElement;
  $('#modal-title').textContent = titulo;
  $('#modal-body').innerHTML = html;
  modal.classList.remove('compact');
  modal.classList.remove('hidden');

  // Sanitizar autocomplete de los inputs del modal
  sanitizarAutocompletado($('#modal-body'));

  // Autofocus al primer input visible (con delay para render)
  setTimeout(() => {
    const primerInput = $('#modal-body')?.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)');
    if (primerInput) {
      primerInput.focus();
      if (primerInput.type !== 'select-one' && primerInput.select) primerInput.select();
    } else {
      const primerBoton = $('#modal-body')?.querySelector('button:not(:disabled)');
      if (primerBoton) primerBoton.focus();
    }
  }, 50);
}

function cerrarModal() {
  modal.classList.add('hidden');
  checkoutReabrir = false;
  if (elementoPrevioModal && elementoPrevioModal.focus && elementoPrevioModal.isConnected) {
    try { elementoPrevioModal.focus(); } catch (_) {}
  }
}
$('#modal-close').addEventListener('click', () => cerrarModal());
modal.addEventListener('click', (e) => { if (e.target === modal) cerrarModal(); });

// ── Productos ─────────────────────────────────────────────
function unidadLabel(u, n) {
  const cantidad = Number(n).toLocaleString('es-PY', {
    minimumFractionDigits: 0, maximumFractionDigits: 3,
  });
  if (u === 'kg') return cantidad + ' kg';
  return cantidad + (u === 'docena' ? ' doc' : ' und');
}

function pintarTablaProductos(lista) {
  if (!lista.length) {
    $('#tabla-productos').innerHTML = '<thead><tr><th>Código (opcional)</th><th>Producto</th><th>Categoría</th><th>Stock</th><th>Precio</th><th>Acciones</th></tr></thead><tbody>' + emptyStateHtml('package', 'Sin resultados', 'Intentá con otro término') + '</tbody>';
    return;
  }
  $('#tabla-productos').innerHTML = '<thead><tr><th>Código (opcional)</th><th>Producto</th><th>Categoría</th><th>Stock</th><th>Precio</th><th>Acciones</th></tr></thead><tbody>' +
    lista.map((p) => `<tr class="fila-nav" tabindex="0" title="Flechas: recorrer · Enter: editar">
      <td>${p.codigo ? `<code>${escapeHtml(p.codigo)}</code>` : '<span class="muted">—</span>'}</td>
      <td><b>${escapeHtml(p.nombre)}</b></td><td>${escapeHtml(p.categoria)}</td>
      <td>${unidadLabel(p.unidad, p.stock)}</td>
      <td><b>${fmtGs(p.precio_venta)}${p.unidad === 'kg' ? '/kg' : p.unidad === 'docena' ? '/doc' : ''}</b></td>
      <td><div class="actions">
        ${esDueño ? `<button class="btn small ghost" onclick="costearProductoDirecto(${p.id})" title="Costear receta y fijar precio"><i data-lucide="calculator"></i> Costeo</button>` : ''}
        <button class="btn small ghost" data-accion-principal onclick="abrirProductoModal(${p.id})"><i data-lucide="pencil"></i> Editar</button>
        <button class="btn small ghost" onclick="ajustarStockProducto(${p.id})"><i data-lucide="package-plus"></i> Ajustar stock</button>
        <button class="btn small danger" onclick="eliminarProducto(${p.id})"><i data-lucide="trash-2"></i></button>
      </div></td></tr>`).join('') + '</tbody>';
  reicons();
}

window.costearProductoDirecto = (id) => {
  irATab('recetas');
  const sel = $('#receta-producto');
  if (sel) {
    sel.value = id;
    cargarReceta();
  }
};

async function cargarProductos() {
  $('#tabla-productos').innerHTML = spinnerHtml();
  productosGlobal = await api('/api/productos');
  if (!productosGlobal.length) {
    $('#tabla-productos').innerHTML = '<thead><tr><th>Código (opcional)</th><th>Producto</th><th>Categoría</th><th>Stock</th><th>Precio</th><th>Acciones</th></tr></thead><tbody>' + emptyStateHtml('cake', 'Sin productos aún', 'Creá tu primer producto con el botón +') + '</tbody>';
    return;
  }
  pintarTablaProductos(productosGlobal);
  const input = $('#productos-buscar');
  input.value = '';
  input.oninput = () => {
    const q = input.value.toLowerCase();
    pintarTablaProductos(q ? productosGlobal.filter((p) => (p.nombre || '').toLowerCase().includes(q) || (p.categoria || '').toLowerCase().includes(q) || (p.codigo || '').toLowerCase().includes(q)) : productosGlobal);
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') enfocarPrimeraFila('tabla-productos', e);
  };
}

$('#btn-nuevo-producto').addEventListener('click', () => abrirProductoModal(null));

async function abrirProductoModal(id) {
  let p = { nombre: '', categoria: '', unidad: 'unidad', precio_venta: 0, stock: 0, codigo: '' };
  if (id) p = productosGlobal.find((x) => x.id === id) || p;

  abrirModal(id ? `Editar: ${p.nombre}` : 'Nuevo producto', `
    <div class="form-row">
      <div class="full"><label>Nombre<input id="pf-nombre" value="${escapeHtml(p.nombre)}"></label></div>
    </div>
    <div class="form-row">
      <div><label>Código (opcional)<input id="pf-codigo" value="${escapeHtml(p.codigo || '')}" placeholder="Solo si usás lector"></label></div>
      <div><label>Categoría (opcional)<input id="pf-categoria" value="${escapeHtml(p.categoria)}" placeholder="Ej: Panes"></label></div>
    </div>
    <div class="form-row">
      <div><label>Unidad de venta
        <select id="pf-unidad">
          <option value="unidad" ${p.unidad === 'unidad' ? 'selected' : ''}>Unidad</option>
          <option value="docena" ${p.unidad === 'docena' ? 'selected' : ''}>Docena</option>
          <option value="kg" ${p.unidad === 'kg' ? 'selected' : ''}>Kilo (por peso)</option>
        </select></label></div>
      <div><label>Precio de venta<input type="number" id="pf-precio" value="${p.precio_venta}"></label></div>
    </div>
    <div class="form-row">
      <div class="full"><label>Stock actual<input type="number" step="any" id="pf-stock" value="${p.stock}"></label></div>
    </div>
    <p class="muted" style="margin-top:4px"><i data-lucide="info" style="width:13px;height:13px;vertical-align:-2px"></i> El código es opcional: podés vender buscando por nombre. Si usás lector de barras, cargá el código acá. El stock se ajusta por separado.</p>
    <button class="btn" style="width:100%;margin-top:16px" onclick="guardarProducto(${id || 'null'})"><i data-lucide="save"></i> Guardar producto</button>`);
}

async function guardarProducto(id) {
  const body = {
    nombre: $('#pf-nombre').value, categoria: $('#pf-categoria').value, unidad: $('#pf-unidad').value,
    precio_venta: parseFloat($('#pf-precio').value), stock: parseFloat($('#pf-stock').value),
    codigo: $('#pf-codigo').value
  };
  try {
    if (id) await put('/api/productos/' + id, body);
    else await post('/api/productos', body);
    modal.classList.add('hidden');
    toast(id ? 'Producto actualizado' : 'Producto creado', 'ok');
    cargarProductos();
  } catch (e) { toast(e.message, 'err'); }
}

function ajustarStockProducto(id) {
  const p = productosGlobal.find((x) => x.id === id);
  abrirModal(`Ajustar stock — ${p.nombre}`, `
    <p class="muted">Stock actual: <b>${unidadLabel(p.unidad, p.stock)}</b></p>
    <label>Nuevo stock<input type="number" step="any" id="st-stock" value="${p.stock}"></label>
    <p class="muted" style="margin-top:4px">Usalo para corregir sobrantes, faltantes o el resultado de un encargo. Vendés vos las cantidades que aparecen acá.</p>
    <button class="btn" style="width:100%;margin-top:16px" onclick="confirmarAjusteStock(${id})"><i data-lucide="save"></i> Guardar stock</button>`);
}

async function confirmarAjusteStock(id) {
  const p = productosGlobal.find((x) => x.id === id);
  const stock = parseFloat($('#st-stock').value);
  if (!Number.isFinite(stock) || stock < 0) return toast('Ingresá un stock válido', 'warn');
  try {
    await put('/api/productos/' + id, { nombre: p.nombre, categoria: p.categoria, unidad: p.unidad, precio_venta: p.precio_venta, stock });
    modal.classList.add('hidden');
    toast('Stock actualizado', 'ok');
    cargarProductos();
  } catch (e) { toast(e.message, 'err'); }
}

async function eliminarProducto(id) {
  const p = productosGlobal.find((x) => x.id === id);
  if (!await confirmarAccion({
    titulo: 'Eliminar producto',
    mensaje: `¿Eliminar ${p ? p.nombre : 'este producto'}? Dejará de aparecer en el punto de venta.`,
    aceptar: 'Eliminar',
    peligro: true,
  })) return;
  try {
    await del('/api/productos/' + id);
    toast('Producto eliminado', 'warn');
    await cargarProductos();
  } catch (e) {
    toast(e.message, 'err');
  }
}

$('#btn-vender').addEventListener('click', () => {
  if (!carrito.size) return toast('No hay productos en el carrito', 'warn');
  const fp = $('#pos-forma-pago')?.value || 'efectivo';
  const tipo = posTipoComprobante;
  const { total } = calcularTotalNumerico();
  const errorComprobante = validarComprobantePOS(tipo);
  if (errorComprobante) return toast(errorComprobante, 'warn');
  if (fp === 'credito' && !posClienteSel) return toast('Debe seleccionar un cliente para venta a crédito', 'warn');
  if (fp === 'efectivo') {
    const recibido = Number($('#pos-recibido')?.value || 0);
    if (recibido < total) return toast('El monto recibido es menor al total', 'warn');
  }
  let pagos;
  if (fp === 'mixto') {
    pagos = Object.fromEntries(['efectivo', 'transferencia', 'tarjeta'].map((medio) => [
      medio, Number($(`#pos-pago-${medio}`)?.value || 0),
    ]));
    const suma = Object.values(pagos).reduce((a, b) => a + b, 0);
    if (Object.values(pagos).some((monto) => !Number.isFinite(monto) || monto < 0)) {
      return toast('Ingresá importes válidos para cada medio de pago', 'warn');
    }
    if (Math.abs(suma - total) > 0.009) {
      return toast('Los medios de pago deben sumar exactamente el total de la venta', 'warn');
    }
  }
  cobrarBoutique(tipo, fp, pagos);
});

function calcularTotalNumerico() {
  let subtotal = 0;
  for (const [id, cant] of carrito) {
    const p = productosGlobal.find((x) => x.id === id);
    if (p) subtotal += importesCarrito.get(id) ?? p.precio_venta * cant;
  }
  const desc = Number($('#pos-descuento')?.value || 0);
  const total = Math.max(0, subtotal - desc);
  return { subtotal, descuento: desc, total };
}

async function cobrarBoutique(tipo, fp, pagos) {
  const { subtotal, descuento, total } = calcularTotalNumerico();
  if (!carrito.size) return toast('No hay productos en el carrito', 'warn');
  const errorComprobante = validarComprobantePOS(tipo);
  if (errorComprobante) return toast(errorComprobante, 'warn');
  if (fp === 'credito' && !posClienteSel) return toast('Debe seleccionar un cliente para venta a crédito', 'warn');
  if (fp === 'efectivo') {
    const recibido = Number($('#pos-recibido')?.value || 0);
    if (recibido < total) return toast('El monto recibido es menor al total', 'warn');
  }
  if (fp === 'mixto' && (!pagos || Math.abs(Object.values(pagos).reduce((a, b) => a + b, 0) - total) > 0.009)) {
    return toast('Los medios de pago deben sumar exactamente el total de la venta', 'warn');
  }
  const btn = $('#btn-vender');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto"></div>'; }
  const items = [...carrito.entries()].map(([id, cantidad]) => ({
    producto_id: id, cantidad,
    ...(importesCarrito.has(id) ? { importe: importesCarrito.get(id) } : {}),
  }));
  const recibido = Number($('#pos-recibido')?.value || 0);
  try {
    const r = await post('/api/ventas', bodySucOperativa({
      items, forma_pago: fp, cliente_id: posClienteSel ? posClienteSel.id : null, tipo,
      descuento, abono: fp === 'credito' ? recibido : undefined, pagos
    }));
    imprimirTicket(r.venta_id);
    carrito.clear();
    importesCarrito.clear();
    try { localStorage.removeItem('panaderia_carrito'); } catch (_) {}
    posClienteSel = null;
    actualizarClientePOS();
    const rec = $('#pos-recibido');
    if (rec) rec.value = '';
    posRecibidoManual = false;
    ['efectivo', 'transferencia', 'tarjeta'].forEach((medio) => {
      const input = $(`#pos-pago-${medio}`);
      if (input) input.value = '';
    });
    const desc = $('#pos-descuento');
    if (desc) desc.value = 0;
    posTipoComprobante = 'ticket';
    const tipoSel = $('#pos-tipo-comprobante');
    if (tipoSel) tipoSel.value = 'ticket';
    actualizarComprobantePOS();
    pintarCarrito();
    cargarComprobantes();
    cargarCaja();
    cargarDashboard();
    const vuelto = fp === 'efectivo' && recibido > total ? recibido - total : 0;
    if (vuelto > 0) toast(`Venta registrada. Vuelto: ${fmtGs(vuelto)}`, 'ok');
    else toast('Venta registrada correctamente', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoBotonCobrar(); reicons(); }
  }
}

function abrirCheckoutBoutique(opts) {
  const cliente = posClienteSel;
  const recibido = Number($('#pos-recibido')?.value || 0);
  const vuelto = opts.forma_pago === 'efectivo' ? Math.max(0, recibido - opts.total) : 0;
  const saldo = opts.forma_pago === 'credito' ? Math.max(0, opts.total - recibido) : 0;
  abrirModal('Cobrar', `
    <div class="checkout-total">
      <div class="monto">${fmtGs(opts.total)}</div>
      <div class="etiqueta">${cliente ? escapeHtml(cliente.nombre || cliente.name) : 'Sin cliente'} · ${opts.tipo === 'factura' ? 'Factura' : 'Ticket'} · ${opts.forma_pago}</div>
    </div>
    ${vuelto > 0 ? `<div class="vuelto visible" style="margin:0 0 6px">Vuelto: ${fmtGs(vuelto)}</div>` : ''}
    ${saldo > 0 ? `<div class="vuelto visible" style="margin:0 0 6px;background:var(--ambar-bg);color:var(--ambar)">Saldo a crédito: ${fmtGs(saldo)}</div>` : ''}
    <div class="actions" style="margin-top:18px;justify-content:space-between">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" style="margin-top:0;padding:12px 24px" onclick="confirmarVentaBoutique(${opts.total}, '${opts.forma_pago}', '${opts.tipo}', ${cliente ? cliente.id : 'null'})"><i data-lucide="check-circle"></i> Cobrar</button>
    </div>`);
  $('#modal').classList.add('compact');
  reicons();
}

async function confirmarVentaBoutique(total, formaPago, tipo, clienteId) {
  const btns = $('#modal').querySelectorAll('.actions .btn');
  const btn = btns[btns.length - 1];
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto"></div>'; }
  const items = [...carrito.entries()].map(([id, cantidad]) => ({
    producto_id: id, cantidad,
    ...(importesCarrito.has(id) ? { importe: importesCarrito.get(id) } : {}),
  }));
  const recibido = Number($('#pos-recibido')?.value || 0);
  const desc = Number($('#pos-descuento')?.value || 0);
  try {
    const r = await post('/api/ventas', bodySucOperativa({ items, forma_pago: formaPago, cliente_id: clienteId, tipo, descuento: desc, abono: formaPago === 'credito' ? recibido : undefined }));
    imprimirTicket(r.venta_id);
    carrito.clear();
    importesCarrito.clear();
    try { localStorage.removeItem('panaderia_carrito'); } catch (_) {}
    posClienteSel = null;
    actualizarClientePOS();
    const rec = $('#pos-recibido');
    if (rec) rec.value = '';
    posRecibidoManual = false;
    const descEl = $('#pos-descuento');
    if (descEl) descEl.value = 0;
    posTipoComprobante = 'ticket';
    const tipoSel = $('#pos-tipo-comprobante');
    if (tipoSel) tipoSel.value = 'ticket';
    actualizarComprobantePOS();
    pintarCarrito();
    cargarComprobantes();
    cargarCaja();
    cargarDashboard();
    cerrarModal();
    toast('Venta registrada correctamente', 'ok');
  } catch (e) {
    toast(e.message, 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = textoBotonCobrar(); reicons(); }
  }
}

// ── Clientes ──────────────────────────────────────────────
function pintarTablaClientes(lista) {
  if (!lista.length) {
    $('#tabla-clientes').innerHTML = '<thead><tr><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Compras</th><th>Total comprado</th><th>Acciones</th></tr></thead><tbody>' + emptyStateHtml('users', 'Sin resultados', 'Intentá con otro término') + '</tbody>';
    return;
  }
  $('#tabla-clientes').innerHTML = '<thead><tr><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Compras</th><th>Total comprado</th><th>Acciones</th></tr></thead><tbody>' +
    lista.map((c) => `<tr class="fila-nav" tabindex="0" title="Flechas: recorrer · Enter: editar">
      <td><b>${escapeHtml(c.nombre) || '<i>Consumidor Final</i>'}</b></td>
      <td>${escapeHtml(c.tipo_documento)} ${escapeHtml(c.documento) || '—'}</td>
      <td>${escapeHtml(c.telefono) || '—'}</td>
      <td>${c.ventas}</td><td><b>${fmtGs(c.total_compras)}</b></td>
      <td><div class="actions">
        <button class="btn small ghost" data-accion-principal onclick="abrirClienteModal(${c.id})"><i data-lucide="pencil"></i> Editar</button>
        <button class="btn small danger" onclick="eliminarCliente(${c.id})"><i data-lucide="trash-2"></i></button>
      </div></td></tr>`).join('') + '</tbody>';
}

async function cargarClientes() {
  $('#tabla-clientes').innerHTML = spinnerHtml();
  clientesGlobal = await api('/api/clientes');
  if (!clientesGlobal.length) {
    $('#tabla-clientes').innerHTML = '<thead><tr><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Compras</th><th>Total comprado</th><th>Acciones</th></tr></thead><tbody>' + emptyStateHtml('users', 'Sin clientes registrados', 'Los clientes para facturas legales aparecen aquí') + '</tbody>';
    return;
  }
  pintarTablaClientes(clientesGlobal);
  const input = $('#clientes-buscar');
  input.value = '';
  input.oninput = () => {
    const q = input.value.toLowerCase();
    pintarTablaClientes(q ? clientesGlobal.filter((c) =>
      (c.nombre || '').toLowerCase().includes(q) ||
      (c.documento || '').toLowerCase().includes(q) ||
      (c.telefono || '').toLowerCase().includes(q)
    ) : clientesGlobal);
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') enfocarPrimeraFila('tabla-clientes', e);
  };
}

$('#btn-nuevo-cliente').addEventListener('click', () => abrirClienteModal(null));

function abrirClienteModal(id, docPreescrito) {
  const docDef = String(docPreescrito || '').trim();
  const tipoDef = docDef && !/^\d{5,8}-\d$/.test(docDef) ? 'Cédula' : 'RUC';
  const c = id ? clientesGlobal.find((x) => x.id === id) : { nombre: '', tipo_documento: tipoDef, documento: docDef, telefono: '' };
  abrirModal(id ? 'Editar cliente' : 'Nuevo cliente', `
    <div class="form-row">
      <div class="full"><label>Nombre (dejá vacío para Consumidor Final)
        <input id="cli-nombre" value="${escapeHtml(c ? c.nombre : '')}" placeholder="Ej: Doña Carmen"></label></div>
    </div>
    <div class="form-row">
      <div><label>Tipo de documento
        <select id="cli-tipo">
          <option value="RUC" ${c && c.tipo_documento === 'RUC' ? 'selected' : ''}>RUC</option>
          <option value="Cédula" ${c && c.tipo_documento === 'Cédula' ? 'selected' : ''}>Cédula</option>
        </select></label></div>
      <div id="cli-doc-wrap" class="ac-wrap"><label>Número
        <input id="cli-doc" value="${escapeHtml(c ? c.documento : '')}" placeholder="Ej: 80012345-6" autocomplete="off"></label></div>
    </div>
    <div class="form-row">
      <div class="full"><label>Teléfono (opcional)
        <input id="cli-tel" value="${escapeHtml(c ? c.telefono : '')}" placeholder="Ej: 0981-123456"></label></div>
    </div>
    <button class="btn" style="width:100%;margin-top:16px" onclick="guardarCliente(${id || 'null'})"><i data-lucide="save"></i> Guardar cliente</button>`);
  const cliDoc = $('#cli-doc');
  cliDoc.addEventListener('blur', () => {
    if (cliDoc.value.trim()) $('#cli-tipo').value = tipoPorDocumento(cliDoc.value.trim());
  });
  armarAutocompletarCliente('#cli-doc', '#cli-doc-wrap', (cc) => {
    $('#cli-nombre').value = cc.nombre || '';
    $('#cli-tipo').value = cc.tipo_documento === 'Cédula' ? 'Cédula' : 'RUC';
    $('#cli-doc').value = cc.documento || '';
    $('#cli-tel').value = cc.telefono || '';
  });
}

async function guardarCliente(id) {
  const body = {
    nombre: $('#cli-nombre').value.trim(), tipo_documento: $('#cli-tipo').value,
    documento: $('#cli-doc').value.trim(), telefono: $('#cli-tel').value.trim()
  };
  if (!id && soloDigitos(body.documento)) {
    const existente = clientesGlobal.find((c) => soloDigitos(c.documento) === soloDigitos(body.documento));
    if (existente) {
      if (checkoutReabrir) {
        checkoutReabrir = false;
        modal.classList.add('hidden');
        abrirCheckout(existente.id);
        toast('Ya existe una ficha con ese documento. Usando: ' + existente.nombre, 'info');
        return;
      }
      if (await confirmarAccion({
        titulo: 'Cliente ya registrado',
        mensaje: `Ya existe una ficha con ese documento: ${existente.nombre}. ¿Querés abrirla para editar en lugar de crear un duplicado?`,
        aceptar: 'Abrir ficha',
      })) {
        abrirClienteModal(existente.id);
      }
      return;
    }
  }
  try {
    const r = id ? await put('/api/clientes/' + id, body) : await post('/api/clientes', body);
    clientesGlobal = await api('/api/clientes');
    if (checkoutReabrir) {
      checkoutReabrir = false;
      abrirCheckout(r.id);
      return;
    }
    modal.classList.add('hidden');
    toast(id ? 'Cliente actualizado' : 'Cliente creado', 'ok');
    cargarClientes();
  } catch (e) { toast(e.message, 'err'); }
}

async function eliminarCliente(id) {
  const cliente = clientesGlobal.find((c) => c.id === id);
  if (!await confirmarAccion({
    titulo: 'Eliminar cliente',
    mensaje: `¿Eliminar a ${cliente ? cliente.nombre : 'este cliente'}?`,
    aceptar: 'Eliminar',
    peligro: true,
  })) return;
  try {
    await del('/api/clientes/' + id);
    toast('Cliente eliminado', 'warn');
    await cargarClientes();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ── Producción ────────────────────────────────────────────
let insumosGlobal = [];
let productoRecetaActual = null;

function textoUnidadInsumo(unidad) {
  return unidad === 'kg' ? 'kg' : unidad === 'l' ? 'litro' : 'unidad';
}

function opcionesUnidadReceta(unidadBase, elegida) {
  const unidades = unidadBase === 'kg' ? ['g', 'kg']
    : unidadBase === 'l' ? ['ml', 'l']
      : unidadBase === 'unidad' ? ['unidad'] : [];
  return unidades.map((unidad) => `<option value="${unidad}" ${unidad === elegida ? 'selected' : ''}>${unidad}</option>`).join('');
}

function actualizarUnidadesFilaReceta(fila, conservar = true) {
  const insumo = insumosGlobal.find((item) => String(item.id) === fila.querySelector('.receta-insumo-select').value);
  const selectUnidad = fila.querySelector('.receta-unidad-select');
  const anterior = conservar ? selectUnidad.value : '';
  selectUnidad.innerHTML = opcionesUnidadReceta(insumo ? insumo.unidad_base : '', anterior);
  if (!selectUnidad.value && insumo) selectUnidad.value = insumo.unidad_base === 'kg' ? 'g' : insumo.unidad_base === 'l' ? 'ml' : 'unidad';
}

function agregarFilaReceta(linea = {}) {
  const contenedor = $('#receta-insumos');
  const fila = document.createElement('div');
  fila.className = 'receta-insumo-fila';
  fila.innerHTML = `
    <div class="campo-insumo">
      <label>Insumo
        <select class="receta-insumo-select">
          <option value="">Elegí un insumo</option>
          ${insumosGlobal.map((i) => `<option value="${i.id}">${escapeHtml(i.nombre)} (${textoUnidadInsumo(i.unidad_base)})</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="campo-cantidad">
      <label>Cantidad
        <input type="number" class="receta-cantidad" min="0.001" step="0.001" placeholder="Ej: 2.5" value="${linea.cantidad ?? ''}">
      </label>
    </div>
    <div class="campo-unidad">
      <label>Unidad
        <select class="receta-unidad-select"></select>
      </label>
    </div>
    <div class="campo-quitar">
      <button type="button" class="receta-quitar-insumo" title="Eliminar este ingrediente" aria-label="Eliminar ingrediente">
        <i data-lucide="trash-2"></i>
      </button>
    </div>`;
  contenedor.appendChild(fila);
  fila.querySelector('.receta-insumo-select').value = linea.insumo_id ? String(linea.insumo_id) : '';
  fila.querySelector('.receta-insumo-select').addEventListener('change', () => actualizarUnidadesFilaReceta(fila, false));
  fila.querySelector('.receta-quitar-insumo').addEventListener('click', () => fila.remove());
  actualizarUnidadesFilaReceta(fila, false);
  if (linea.unidad) fila.querySelector('.receta-unidad-select').value = linea.unidad;
  reicons();
}

function actualizarOpcionesFilasReceta() {
  $$('#receta-insumos .receta-insumo-fila').forEach((fila) => {
    const select = fila.querySelector('.receta-insumo-select');
    const anterior = select.value;
    select.innerHTML = `<option value="">Elegí un insumo</option>${insumosGlobal.map((i) => `<option value="${i.id}">${escapeHtml(i.nombre)} (${textoUnidadInsumo(i.unidad_base)})</option>`).join('')}`;
    select.value = anterior;
    actualizarUnidadesFilaReceta(fila);
  });
}

function pintarTablaInsumos() {
  const tabla = $('#tabla-insumos');
  if (!insumosGlobal.length) {
    tabla.innerHTML = '<thead><tr><th>Insumo</th><th>Unidad base</th><th>Costo</th><th>Acciones</th></tr></thead><tbody>' +
      emptyStateHtml('wheat', 'Todavía no hay insumos', 'Agregá materias primas para calcular las fórmulas') + '</tbody>';
    return;
  }
  tabla.innerHTML = '<thead><tr><th>Insumo</th><th>Unidad base</th><th>Costo por unidad</th><th>Acciones</th></tr></thead><tbody>' +
    insumosGlobal.map((i) => `<tr>
      <td><b>${escapeHtml(i.nombre)}</b></td><td>${textoUnidadInsumo(i.unidad_base)}</td>
      <td>${fmtGs2(i.costo_unitario)} / ${i.unidad_base}</td>
      <td><button type="button" class="btn small ghost editar-insumo" data-id="${i.id}"><i data-lucide="pencil"></i> Editar</button></td>
    </tr>`).join('') + '</tbody>';
  tabla.querySelectorAll('.editar-insumo').forEach((boton) => {
    boton.addEventListener('click', () => abrirInsumoModal(Number(boton.dataset.id)));
  });
  if (window.lucide) lucide.createIcons();
}

async function cargarInsumos() {
  insumosGlobal = await api('/api/insumos');
  pintarTablaInsumos();
  actualizarOpcionesFilasReceta();
}

function abrirInsumoModal(id = null) {
  const insumo = insumosGlobal.find((i) => Number(i.id) === id);
  abrirModal(id ? `Editar insumo: ${insumo.nombre}` : 'Nuevo insumo', `
    <label>Nombre
      <input id="insumo-nombre" maxlength="100" value="${escapeHtml(insumo ? insumo.nombre : '')}">
    </label>
    ${id ? `<p class="muted">Unidad base: <b>${textoUnidadInsumo(insumo.unidad_base)}</b> (no se puede cambiar después de crear el insumo).</p>` : `
    <label>Unidad base
      <select id="insumo-unidad">
        <option value="kg">Kilogramo (kg)</option>
        <option value="l">Litro (L)</option>
        <option value="unidad">Unidad</option>
      </select>
    </label>`}
    <label>Costo por ${id ? insumo.unidad_base : '<span id="insumo-unidad-costo">kg</span>'} (₲)
      <input type="number" id="insumo-costo" min="0" step="any" value="${insumo ? insumo.costo_unitario : ''}">
    </label>
    <p class="msg" id="insumo-msg"></p>
    <button type="button" class="btn" style="width:100%;margin-top:16px" id="btn-guardar-insumo">Guardar insumo</button>`);
  if (!id) {
    $('#insumo-unidad').addEventListener('change', () => {
      $('#insumo-unidad-costo').textContent = $('#insumo-unidad').value;
    });
  }
  $('#btn-guardar-insumo').addEventListener('click', () => guardarInsumo(id));
}

async function guardarInsumo(id) {
  const mensaje = $('#insumo-msg');
  mensaje.textContent = '';
  const datos = {
    nombre: $('#insumo-nombre').value,
    costo_unitario: $('#insumo-costo').value,
  };
  if (!id) datos.unidad_base = $('#insumo-unidad').value;
  try {
    if (id) await put(`/api/insumos/${id}`, datos);
    else await post('/api/insumos', datos);
    modal.classList.add('hidden');
    toast(id ? 'Insumo actualizado' : 'Insumo creado', 'ok');
    await cargarInsumos();
  } catch (e) {
    msg(mensaje, escapeHtml(e.message), 'err');
  }
}

function pintarCosteoReceta(costeo) {
  const contenedor = $('#receta-costeo');
  if (!costeo) {
    contenedor.innerHTML = '';
    return;
  }
  const producto = productosGlobal.find((p) => Number(p.id) === productoRecetaActual);
  const u = producto ? producto.unidad : 'unidad';
  const uLabel = u === 'kg' ? 'kilo' : u === 'docena' ? 'docena' : 'unidad';
  const precioActual = producto ? producto.precio_venta : 0;

  let desgloseDocena = '';
  if (u === 'docena') {
    const costoUnit = costeo.costo_unitario / 12;
    const sugeridoUnit = costeo.precio_sugerido / 12;
    desgloseDocena = `<p class="muted" style="margin-top:6px;font-size:.9em">
      Equivale por unidad suelta a: <b>Costo ${fmtGs(costoUnit)}</b> · <b>Venta sugerida ${fmtGs(sugeridoUnit)}</b>
    </p>`;
  }

  contenedor.innerHTML = `
    <div class="cards" style="margin-bottom:12px">
      <div class="card"><div class="valor">${fmtGs(costeo.costo_lote)}</div><div class="etiqueta">Costo de la tanda</div></div>
      <div class="card"><div class="valor">${fmtGs(costeo.costo_unitario)}</div><div class="etiqueta">Costo por ${uLabel}</div></div>
      <div class="card"><div class="valor">${fmtGs(precioActual)}</div><div class="etiqueta">Precio actual en venta</div></div>
      <div class="card ambar"><div class="valor">${fmtGs(costeo.precio_sugerido)}</div><div class="etiqueta">Sugerido (${costeo.margen}% margen)</div></div>
    </div>
    ${desgloseDocena}
    <div style="margin:14px 0">
      <button type="button" class="btn" id="btn-aplicar-precio" style="width:100%;font-size:1.02em;padding:11px">
        <i data-lucide="check"></i> Fijar ${fmtGs(costeo.precio_sugerido)} como precio de venta por ${uLabel}
      </button>
    </div>
    <p class="muted" style="margin-top:10px">Rendimiento: <b>${costeo.rendimiento} ${uLabel}${costeo.rendimiento > 1 && u !== 'kg' ? 's' : ''}</b></p>
    <details style="margin-top:8px">
      <summary class="muted" style="cursor:pointer;font-weight:600">Ver desglose de ingredientes usados</summary>
      <table style="margin-top:8px"><thead><tr><th>Insumo</th><th>Cantidad</th><th>Costo</th></tr></thead><tbody>
        ${costeo.insumos.map((i) => `<tr><td>${escapeHtml(i.nombre)}</td><td>${i.cantidad} ${i.unidad}</td><td>${fmtGs(i.costo)}</td></tr>`).join('')}
      </tbody></table>
    </details>`;
  reicons();
  $('#btn-aplicar-precio').addEventListener('click', aplicarPrecioReceta);
}

async function cargarReceta() {
  const mensaje = $('#receta-msg');
  mensaje.textContent = '';
  $('#receta-costeo').innerHTML = '';
  productoRecetaActual = Number($('#receta-producto').value);
  if (!productoRecetaActual) {
    $('#receta-editor').classList.add('hidden');
    return;
  }
  const producto = productosGlobal.find((p) => Number(p.id) === productoRecetaActual);
  const uLabel = $('#receta-rendimiento-label');
  const uHelp = $('#receta-rendimiento-help');
  const uInfo = $('#receta-producto-info');
  if (producto) {
    if (producto.unidad === 'kg') {
      if (uLabel) uLabel.textContent = 'Rendimiento en kilos (kg)';
      if (uHelp) uHelp.textContent = 'Kilos de producto obtenidos de esta tanda.';
      if (uInfo) uInfo.innerHTML = `Venta por <b>KILO</b> · Precio actual en mostrador: <b>${fmtGs(producto.precio_venta)}/kg</b>`;
    } else if (producto.unidad === 'docena') {
      if (uLabel) uLabel.textContent = 'Rendimiento en docenas';
      if (uHelp) uHelp.textContent = 'Docenas de producto obtenidas de esta tanda.';
      if (uInfo) uInfo.innerHTML = `Venta por <b>DOCENA</b> · Precio actual en mostrador: <b>${fmtGs(producto.precio_venta)}/docena</b>`;
    } else {
      if (uLabel) uLabel.textContent = 'Rendimiento en unidades';
      if (uHelp) uHelp.textContent = 'Cantidad de unidades obtenidas de esta tanda.';
      if (uInfo) uInfo.innerHTML = `Venta por <b>UNIDAD</b> · Precio actual en mostrador: <b>${fmtGs(producto.precio_venta)} c/u</b>`;
    }
  }
  try {
    const datos = await api(`/api/recetas/${productoRecetaActual}`);
    $('#receta-editor').classList.remove('hidden');
    $('#receta-rendimiento').value = datos.receta ? datos.receta.rendimiento : '';
    $('#receta-margen').value = datos.receta ? datos.receta.margen : 40;
    $('#receta-insumos').innerHTML = '';
    if (datos.insumos.length) datos.insumos.forEach(agregarFilaReceta);
    else agregarFilaReceta();
    pintarCosteoReceta(datos.costo);
  } catch (e) {
    msg(mensaje, escapeHtml(e.message), 'err');
  }
}

async function guardarReceta() {
  const mensaje = $('#receta-msg');
  mensaje.textContent = '';
  const filas = $$('#receta-insumos .receta-insumo-fila');
  const datos = {
    rendimiento: Number($('#receta-rendimiento').value),
    margen: $('#receta-margen').value,
    insumos: filas.map((fila) => ({
      insumo_id: Number(fila.querySelector('.receta-insumo-select').value),
      cantidad: Number(fila.querySelector('.receta-cantidad').value),
      unidad: fila.querySelector('.receta-unidad-select').value,
    })),
  };
  try {
    const costeo = await put(`/api/recetas/${productoRecetaActual}`, datos);
    pintarCosteoReceta(costeo);
    msg(mensaje, 'Fórmula guardada y costo calculado. Tocá "Fijar precio" para aplicarlo al mostrador.', 'ok');
    toast('Fórmula guardada', 'ok');
  } catch (e) {
    msg(mensaje, escapeHtml(e.message), 'err');
  }
}

async function aplicarPrecioReceta() {
  const producto = productosGlobal.find((p) => Number(p.id) === productoRecetaActual);
  if (!producto) return;
  const u = producto.unidad === 'kg' ? 'kg' : producto.unidad === 'docena' ? 'docena' : 'unidad';
  if (!await confirmarAccion({
    titulo: 'Fijar precio de venta',
    mensaje: `¿Querés cambiar el precio de venta de "${producto.nombre}" al precio sugerido? Este será el nuevo precio en el mostrador.`,
    aceptar: 'Fijar precio',
  })) return;
  try {
    const resultado = await post(`/api/recetas/${productoRecetaActual}/aplicar-precio`, {});
    producto.precio_venta = resultado.precio_sugerido;
    toast(`Precio de venta fijado en ${fmtGs(resultado.precio_sugerido)}/${u}`, 'ok');
    pintarCosteoReceta(resultado);
    cargarRecetasTab();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function cargarRecetasTab() {
  if (!esDueño) return;
  productosGlobal = await api('/api/productos');
  const sel = $('#receta-producto');
  if (sel) {
    const anterior = productoRecetaActual || sel.value;
    sel.innerHTML = '<option value="">-- Seleccioná un producto para costear --</option>' +
      productosGlobal.map((p) => {
        const u = p.unidad === 'kg' ? 'Kilo' : p.unidad === 'docena' ? 'Docena' : 'Unidad';
        return `<option value="${p.id}">${escapeHtml(p.nombre)} (${u} · Actual: ${fmtGs(p.precio_venta)})</option>`;
      }).join('');
    if (anterior && productosGlobal.some((p) => String(p.id) === String(anterior))) {
      sel.value = anterior;
    }
  }
  await cargarInsumos();
  if (sel && sel.value) {
    cargarReceta();
  } else {
    $('#receta-editor')?.classList.add('hidden');
  }
}

async function cargarProduccion() {
  if (!$('#tabla-lotes')) return;
  $('#tabla-lotes').innerHTML = spinnerHtml();
  productosGlobal = await api('/api/productos');
  const sel = $('#select-prod');
  if (sel) sel.innerHTML = productosGlobal.map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)} (${unidadLabel(p.unidad, p.stock)} en stock)</option>`).join('');
  if ($('#prod-cantidad')) $('#prod-cantidad').value = '';
  const lotes = await api(withSucOperativa('/api/lotes'));
  if (!lotes.length) {
    $('#tabla-lotes').innerHTML = '<thead><tr><th>#</th><th>Producto</th><th>Cantidad</th><th>Fecha</th><th>Sucursal</th></tr></thead><tbody>' + emptyStateHtml('chef-hat', 'Sin producción registrada', 'Registrá tu primera producción') + '</tbody>';
    return;
  }
  $('#tabla-lotes').innerHTML = '<thead><tr><th>#</th><th>Producto</th><th>Cantidad</th><th>Fecha</th><th>Sucursal</th></tr></thead><tbody>' +
    lotes.map((l) => `<tr><td>${l.id}</td><td>${escapeHtml(l.producto_nombre)}</td><td><b>${unidadLabel(l.producto_unidad, l.cantidad)}</b></td><td>${fmtFecha(l.fecha)}</td><td class="muted">${l.sucursal_nombre || '—'}</td></tr>`).join('') + '</tbody>';
}

$('#btn-nuevo-insumo')?.addEventListener('click', () => abrirInsumoModal());
$('#btn-editar-receta')?.addEventListener('click', cargarReceta);
$('#btn-agregar-ingrediente')?.addEventListener('click', () => agregarFilaReceta());
$('#btn-guardar-receta')?.addEventListener('click', guardarReceta);
$('#receta-producto')?.addEventListener('change', () => {
  if ($('#receta-producto').value) cargarReceta();
  else {
    productoRecetaActual = null;
    $('#receta-editor')?.classList.add('hidden');
  }
});
$('#btn-producir')?.addEventListener('click', async () => {
  const btn = $('#btn-producir');
  btn.disabled = true;
  try {
    const cantidad = parseFloat($('#prod-cantidad').value);
    const r = await post('/api/produccion', bodySucOperativa({ producto_id: parseInt($('#select-prod').value), cantidad }));
    toast(`Producción registrada: ${unidadLabel(r.unidad, r.cantidad)} de ${r.producto_nombre}`, 'ok');
    msg($('#prod-msg'), `Producción registrada: <b>${unidadLabel(r.unidad, r.cantidad)}</b> de ${escapeHtml(r.producto_nombre)}. Stock actualizado.`);
    cargarProduccion();
    cargarDashboard();
  } catch (e) {
    toast(e.message, 'err');
    msg($('#prod-msg'), escapeHtml(e.message), 'err');
  } finally {
    btn.disabled = false;
  }
});

// ── Reportes ──────────────────────────────────────────────
let repFecha = fechaHoy();
let repRangoDesde = '';
let repRangoHasta = '';
async function cargarReportes() {
  repFecha = fechaHoy();
  $('#rep-fecha').value = repFecha;
  const inicioMes = `${repFecha.slice(0, 8)}01`;
  const minimo = licenciaInfo && licenciaInfo.limite_reporte ? licenciaInfo.limite_reporte.desde : '';
  repRangoDesde = minimo && inicioMes < minimo ? minimo : inicioMes;
  repRangoHasta = repFecha;
  $('#rep-rango-desde').value = repRangoDesde;
  $('#rep-rango-hasta').value = repRangoHasta;
  $('#rep-rango-desde').min = minimo;
  $('#rep-rango-hasta').min = minimo;
  $('#rep-rango-hasta').max = repFecha;
  pintarReporte();
}
$('#rep-fecha').addEventListener('change', (e) => { repFecha = e.target.value; pintarReporte(); });

$$('#rep-vistas button').forEach((boton) => boton.addEventListener('click', () => {
  const rango = boton.dataset.reporte === 'rango';
  $$('#rep-vistas button').forEach((item) => item.classList.toggle('activo', item === boton));
  $('#rep-dia-vista').classList.toggle('hidden', rango);
  $('#rep-rango-vista').classList.toggle('hidden', !rango);
  if (rango) pintarReporteRango();
}));

$('#rep-rango-form').addEventListener('submit', (e) => {
  e.preventDefault();
  repRangoDesde = $('#rep-rango-desde').value;
  repRangoHasta = $('#rep-rango-hasta').value;
  pintarReporteRango();
});

function pintarTablaReporteRango(id, encabezados, filas, vacio) {
  const head = `<thead><tr>${encabezados.map((titulo) => `<th>${titulo}</th>`).join('')}</tr></thead>`;
  const body = filas.length ? filas.join('') : `<tbody>${emptyStateHtml('file-search', vacio)}</tbody>`;
  $(`#${id}`).innerHTML = filas.length ? `${head}<tbody>${body}</tbody>` : `${head}${body}`;
}

function limpiarTablasReporteRango() {
  [
    'rep-rango-ventas', 'rep-rango-pagos', 'rep-rango-productos-total',
    'rep-rango-productos-dia', 'rep-rango-produccion',
    'rep-rango-gastos-categoria', 'rep-rango-gastos', 'rep-rango-cajas',
  ].forEach((id) => { $(`#${id}`).innerHTML = ''; });
}

async function pintarReporteRango() {
  const boton = $('#rep-rango-form button[type="submit"]');
  const msgReporte = $('#rep-rango-msg');
  msgReporte.textContent = '';
  limpiarTablasReporteRango();
  $('#rep-rango-cards').innerHTML = spinnerHtml();
  if (!repRangoDesde || !repRangoHasta || repRangoDesde > repRangoHasta) {
    $('#rep-rango-cards').innerHTML = '';
    msg(msgReporte, 'Elegí un rango de fechas válido.', 'err');
    return;
  }
  if (boton) boton.disabled = true;
  const query = `desde=${encodeURIComponent(repRangoDesde)}&hasta=${encodeURIComponent(repRangoHasta)}`;
  try {
    const reporte = await api(withSucReporte(`/api/reporte/rango?${query}`));
    if (reporte.limitado) {
      $('#rep-rango-cards').innerHTML = '';
      msg(msgReporte, escapeHtml(reporte.mensaje), 'err');
      reicons();
      return;
    }

    $('#rep-rango-cards').innerHTML = `
      <div class="card"><div class="valor">${fmtGs(reporte.total_ventas)}</div><div class="etiqueta">Ventas del período</div></div>
      <div class="card"><div class="valor">${reporte.cantidad_ventas}</div><div class="etiqueta">Comprobantes</div></div>
      <div class="card"><div class="valor">${reporte.ventas_por_dia.length}</div><div class="etiqueta">Días con ventas</div></div>
      <div class="card"><div class="valor">${reporte.productos_total.length}</div><div class="etiqueta">Productos vendidos</div></div>`;

    pintarTablaReporteRango('rep-rango-ventas', ['Fecha', 'Comprobantes', 'Total vendido'],
      reporte.ventas_por_dia.map((dia) => `<tr><td>${fmtFecha(dia.fecha)}</td><td>${dia.comprobantes}</td><td>${fmtGs(dia.total)}</td></tr>`),
      'Sin ventas en este período');

    const etiquetasPago = {
      efectivo: 'Efectivo (incluye abonos)',
      transferencia: 'Transferencia',
      tarjeta: 'Tarjeta',
      credito: 'Crédito',
    };
    pintarTablaReporteRango('rep-rango-pagos', ['Medio', 'Recaudado'],
      reporte.pagos_total.map((pago) => `<tr><td>${etiquetasPago[pago.forma_pago] || escapeHtml(pago.forma_pago)}</td><td>${fmtGs(pago.total)}</td></tr>`),
      'Sin cobros registrados');

    pintarTablaReporteRango('rep-rango-productos-total', ['Producto', 'Cantidad', 'Importe vendido'],
      reporte.productos_total.map((producto) => `<tr><td>${escapeHtml(producto.nombre)}</td><td>${unidadLabel(producto.unidad, producto.cantidad)}</td><td>${fmtGs(producto.total)}</td></tr>`),
      'Sin productos vendidos');

    pintarTablaReporteRango('rep-rango-productos-dia', ['Fecha', 'Producto', 'Cantidad', 'Importe vendido'],
      reporte.productos_por_dia.map((producto) => `<tr><td>${fmtFecha(producto.fecha)}</td><td>${escapeHtml(producto.nombre)}</td><td>${unidadLabel(producto.unidad, producto.cantidad)}</td><td>${fmtGs(producto.total)}</td></tr>`),
      'Sin detalle de productos');

    pintarTablaReporteRango('rep-rango-produccion', ['Fecha', 'Producto', 'Cantidad producida'],
      reporte.produccion_por_dia.map((lote) => `<tr><td>${fmtFecha(lote.fecha)}</td><td>${escapeHtml(lote.nombre)}</td><td>${unidadLabel(lote.unidad, lote.cantidad)}</td></tr>`),
      'Sin producción registrada');

    pintarTablaReporteRango('rep-rango-gastos-categoria', ['Categoría', 'Total'],
      reporte.gastos_por_categoria.map((gasto) => `<tr><td>${escapeHtml(gasto.categoria)}</td><td>${fmtGs(gasto.total)}</td></tr>`),
      'Sin gastos registrados');

    pintarTablaReporteRango('rep-rango-gastos', ['Fecha', 'Total de gastos'],
      reporte.gastos_por_dia.map((gasto) => `<tr><td>${fmtFecha(gasto.fecha)}</td><td>${fmtGs(gasto.total)}</td></tr>`),
      'Sin gastos registrados');

    pintarTablaReporteRango('rep-rango-cajas', ['Fecha', 'Apertura', 'Esperado', 'Real', 'Diferencia', 'Estado'],
      reporte.cajas_por_dia.map((caja) => `<tr>
        <td>${fmtFecha(caja.fecha)}</td><td>${fmtGs(caja.apertura)}</td>
        <td>${fmtGs(caja.esperado)}</td><td>${caja.real == null ? '—' : fmtGs(caja.real)}</td>
        <td>${caja.diferencia == null ? '—' : fmtGs(caja.diferencia)}</td>
        <td>${caja.estado === 'cerrada' ? '<span class="tag ticket">Cerrada</span>' : '<span class="tag ok">Abierta</span>'}</td>
      </tr>`),
      'Sin cajas registradas');
    reicons();
  } catch (e) {
    $('#rep-rango-cards').innerHTML = '';
    limpiarTablasReporteRango();
    msg(msgReporte, escapeHtml(e.message), 'err');
  } finally {
    if (boton) boton.disabled = false;
  }
}

async function pintarReporte() {
  $('#rep-cards').innerHTML = spinnerHtml();
  if (licenciaInfo && licenciaInfo.limite_reporte) {
    $('#rep-fecha').min = licenciaInfo.limite_reporte.desde;
  }
  const [dia, cajas] = await Promise.all([api(withSucReporte('/api/reporte/dia?fecha=' + repFecha)), api(withSucReporte('/api/cajas'))]);
  if (dia.limitado) {
    $('#rep-cards').innerHTML = `<div class="msg err" style="grid-column:1/-1;padding:14px"><i data-lucide="lock" style="width:15px;height:15px;vertical-align:-2px"></i> ${escapeHtml(dia.mensaje)}</div>`;
    $('#rep-ventas').innerHTML = $('#rep-lotes').innerHTML = $('#rep-cajas').innerHTML = '';
    reicons();
    return;
  }
  const produccionTotal = dia.lotes.reduce((a, l) => a + l.cantidad, 0);
  $('#rep-cards').innerHTML = `
    <div class="card"><div class="valor">${fmtGs(dia.total_ventas)}</div><div class="etiqueta">Ventas ${fmtFecha(repFecha)}</div></div>
    <div class="card"><div class="valor">${dia.cantidad_ventas}</div><div class="etiqueta">Comprobantes</div></div>
    <div class="card"><div class="valor">${dia.lotes.length}</div><div class="etiqueta">Producciones</div></div>
    <div class="card"><div class="valor">${produccionTotal.toLocaleString('es-PY')}</div><div class="etiqueta">Cantidad producida</div></div>`;

  const repVentasRows = dia.productos_vendidos.map((p) => `<tr><td>${escapeHtml(p.nombre)}</td><td>${p.cantidad}${p.unidad === 'kg' ? ' kg' : ''}</td><td>${fmtGs(p.total)}</td></tr>`).join('');
  $('#rep-ventas').innerHTML = '<thead><tr><th>Producto</th><th>Cantidad</th><th>Total</th></tr></thead><tbody>' + (repVentasRows || emptyStateHtml('shopping-cart', 'Sin ventas este día')) + '</tbody>';

  const repLotesRows = dia.lotes.map((l) => `<tr><td>${escapeHtml(l.producto_nombre)}</td><td><b>${unidadLabel(l.producto_unidad, l.cantidad)}</b></td></tr>`).join('');
  $('#rep-lotes').innerHTML = '<thead><tr><th>Producto</th><th>Cantidad</th></tr></thead><tbody>' + (repLotesRows || emptyStateHtml('chef-hat', 'Sin producción este día')) + '</tbody>';

  if (!cajas.length) {
    $('#rep-cajas').innerHTML = '<thead><tr><th>Fecha</th><th>Apertura</th><th>Esperado</th><th>Real</th><th>Diferencia</th><th>Estado</th></tr></thead><tbody>' + emptyStateHtml('wallet', 'Sin cajas registradas') + '</tbody>';
    return;
  }
  $('#rep-cajas').innerHTML = '<thead><tr><th>Fecha</th><th>Apertura</th><th>Esperado</th><th>Real</th><th>Diferencia</th><th>Estado</th></tr></thead><tbody>' +
    cajas.map((c) => `<tr>
      <td>${fmtFecha(c.fecha)}</td><td>${fmtGs(c.apertura)}</td>
      <td>${c.cierre_esperado != null ? fmtGs(c.cierre_esperado) : '—'}</td>
      <td>${c.cierre_real != null ? fmtGs(c.cierre_real) : '—'}</td>
      <td class="${c.diferencia > 0 ? 'msg ok' : c.diferencia < 0 ? 'msg err' : ''}">${c.diferencia != null ? fmtGs(c.diferencia) : '—'}</td>
      <td>${c.estado === 'abierta' ? '<span class="tag ok">Abierta</span>' : '<span class="tag ticket">Cerrada</span>'}</td>
    </tr>`).join('') + '</tbody>';
}

// ── Caja ──────────────────────────────────────────────────
// Cajas viejas que quedaron abiertas: se muestran siempre (no solo un aviso
// pasajero) para poder cerrarlas con el dinero contado de ese día.
const denominacionesGs = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50];

function htmlArqueoCaja(prefijo) {
  const campos = denominacionesGs.map((denominacion) => `
    <label>₲ ${denominacion.toLocaleString('es-PY')}
      <input type="number" min="0" step="1" id="${prefijo}-${denominacion}" value="0">
    </label>`).join('');
  return `<div class="denominaciones-grid">${campos}</div>
    <p class="muted" id="${prefijo}-resumen"></p>`;
}

function leerArqueoCaja(prefijo) {
  return Object.fromEntries(denominacionesGs.map((denominacion) => [
    denominacion, Number($(`#${prefijo}-${denominacion}`)?.value || 0),
  ]));
}

function conectarArqueoCaja(prefijo, esperado) {
  const actualizar = () => {
    const conteo = leerArqueoCaja(prefijo);
    const total = denominacionesGs.reduce((suma, denominacion) => suma + denominacion * conteo[denominacion], 0);
    const diferencia = total - esperado;
    const resumen = $(`#${prefijo}-resumen`);
    if (resumen) resumen.textContent = `Contado: ${fmtGs(total)} · ${
      diferencia === 0 ? 'Sin diferencia' : `${diferencia > 0 ? 'Sobra' : 'Falta'} ${fmtGs(Math.abs(diferencia))}`
    }`;
  };
  denominacionesGs.forEach((denominacion) => {
    $(`#${prefijo}-${denominacion}`)?.addEventListener('input', actualizar);
  });
  actualizar();
}

function pintarCajasPendientes(lista) {
  const cont = $('#caja-pendientes');
  if (!cont) return;
  if (!lista.length) { cont.innerHTML = ''; return; }
  const filas = lista.map((c) => {
    const esperado = c.apertura + c.ingresos - c.egresos;
    return `<tr>
      <td><b>${fmtFecha(c.fecha)}</b></td>
      <td>${fmtGs(c.apertura)}</td>
      <td style="color:var(--verde)">${fmtGs(c.ingresos)}</td>
      <td>${fmtGs(c.transferencias || 0)}</td>
      <td>${fmtGs(c.tarjetas || 0)}</td>
      <td style="color:var(--rojo)">${fmtGs(c.egresos)}</td>
      <td><b>${fmtGs(esperado)}</b></td>
      <td><div class="actions"><button class="btn small" onclick="verCaja(${c.id})"><i data-lucide="lock"></i> Cerrar</button></div></td>
    </tr>`;
  }).join('');
  cont.innerHTML = `<div class="box" style="border-color:var(--ambar)">
    <h3><i data-lucide="alert-triangle" style="width:15px;height:15px;vertical-align:-2px;color:var(--ambar)"></i> Cajas de días anteriores sin cerrar</h3>
    <p class="muted" style="margin-bottom:10px">Si un día no se cerró la caja, queda abierta y su cierre real nunca queda registrado. Cerrala con el dinero contado de ese día: las ventas y los movimientos no se modifican.</p>
    <table><thead><tr><th>Fecha</th><th>Apertura</th><th>Efectivo</th><th>Transferencia</th><th>Tarjeta</th><th>Egresos</th><th>Esperado</th><th></th></tr></thead><tbody>${filas}</tbody></table>
  </div>`;
  reicons();
}

async function cargarCaja() {
  const [caja, historial, pendientes] = await Promise.all([
    api(withSucOperativa('/api/caja')),
    api(withSucOperativa('/api/cajas')),
    api(withSucOperativa('/api/caja/pendientes')),
  ]);
  pintarEtiquetaSucursal('caja-sucursal');
  pintarCajasPendientes(pendientes);
  if (!caja) {
    $('#caja-abrir').classList.remove('hidden');
    $('#caja-info').classList.add('hidden');
  } else {
    $('#caja-abrir').classList.add('hidden');
    $('#caja-info').classList.remove('hidden');
    const efectivo = caja.total_efectivo ?? caja.total_ingresos;
    const esperado = caja.apertura + efectivo - caja.total_egresos;
    $('#caja-cards').innerHTML = `
      <div class="card">
        <div class="valor">${fmtGs(caja.apertura)}</div>
        <div class="etiqueta" style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <span>Apertura</span>
          ${caja.estado === 'abierta' ? `<button type="button" class="btn ghost small" style="padding:2px 7px;font-size:11px;height:auto;line-height:1.2;margin:0" onclick="abrirModalEditarApertura(${caja.id}, ${caja.apertura})"><i data-lucide="edit-2" style="width:11px;height:11px"></i> Editar</button>` : ''}
        </div>
      </div>
      <div class="card positivo"><div class="valor">${fmtGs(efectivo)}</div><div class="etiqueta">Efectivo</div></div>
      <div class="card"><div class="valor">${fmtGs(caja.total_transferencia || 0)}</div><div class="etiqueta">Transferencias</div></div>
      <div class="card"><div class="valor">${fmtGs(caja.total_tarjeta || 0)}</div><div class="etiqueta">Tarjetas</div></div>
      <div class="card negativo"><div class="valor">${fmtGs(caja.total_egresos)}</div><div class="etiqueta">Egresos</div></div>
      <div class="card ${caja.estado === 'abierta' ? 'ambar' : ''}"><div class="valor">${fmtGs(esperado)}</div><div class="etiqueta">${caja.estado === 'abierta' ? 'Esperado en caja' : 'Cierre esperado'}</div></div>`;

    const movRows = caja.movimientos.map((m) => `<tr>
      <td>${m.tipo === 'ingreso' ? '<i data-lucide="arrow-up-right"></i> Ingreso' : '<i data-lucide="arrow-down-right"></i> Egreso'}</td>
      <td>${escapeHtml(m.concepto)}</td>
      <td style="font-weight:600">${fmtGs(m.monto)}</td>
    </tr>`).join('');
    $('#tabla-caja-movs').innerHTML = '<thead><tr><th>Tipo</th><th>Concepto</th><th>Monto</th></tr></thead><tbody>' + (movRows || emptyStateHtml('receipt', 'Sin movimientos aún')) + '</tbody>';

    $('#caja-controles').innerHTML = caja.estado === 'abierta' ? `
      <div class="box">
        <h3>Cerrar caja</h3>
        <p class="muted" style="margin-bottom:8px">Esperado: <b>${fmtGs(esperado)}</b></p>
        <p class="muted">Contá los billetes y monedas; el total y la diferencia se calculan automáticamente.</p>
        ${htmlArqueoCaja('cierre-denom')}
        <button class="btn" id="btn-cerrar-caja"><i data-lucide="lock"></i> Cerrar caja</button>
        <p class="msg" id="cierre-msg"></p>
      </div>` : `
      <div class="box">
        <h3>Caja cerrada</h3>
        <p class="muted" style="margin-bottom:8px">
          Cierre esperado: <b>${fmtGs(caja.cierre_esperado)}</b><br>
          Cierre real: <b>${fmtGs(caja.cierre_real)}</b><br>
          Transferencias: <b>${fmtGs(caja.total_transferencia || 0)}</b> · Tarjetas: <b>${fmtGs(caja.total_tarjeta || 0)}</b><br>
          Diferencia: <b class="${caja.diferencia < 0 ? 'msg err' : ''}">${fmtGs(caja.diferencia)}</b>
        </p>
        <div class="actions" style="margin-top:12px">
          <button class="btn ghost" onclick="verCaja(${caja.id})"><i data-lucide="eye"></i> Ver detalle</button>
          <button class="btn" onclick="reabrirCaja(${caja.id})"><i data-lucide="unlock"></i> Reabrir caja</button>
        </div>
      </div>`;

    if (caja.estado === 'abierta') {
      conectarArqueoCaja('cierre-denom', esperado);
      $('#btn-cerrar-caja').addEventListener('click', async () => {
        try {
          const r = await post('/api/caja/cerrar', bodySucOperativa({ denominaciones: leerArqueoCaja('cierre-denom') }));
          toast(`Caja cerrada. Diferencia: ${fmtGs(r.diferencia)}`, r.diferencia < 0 ? 'warn' : 'ok');
          msg($('#cierre-msg'), `Caja cerrada. Esperado: ${fmtGs(r.esperado)} — Diferencia: ${fmtGs(r.diferencia)}`);
          cargarCaja();
          cargarDashboard();
        } catch (e) { toast(e.message, 'err'); }
      });
    }
  }
  pintarHistorialCajas(historial);
  reicons();
}

function abrirModalEditarApertura(cajaId, aperturaActual) {
  abrirModal('Modificar monto de apertura', `
    <p class="muted">Apertura registrada actualmente: <b>${fmtGs(aperturaActual)}</b></p>
    <p class="muted" style="margin-bottom:12px">Si la caja se abrió sin dinero o con un monto equivocado, ingresá el monto real de fondo de caja para corregir el arqueo del día.</p>
    <div class="form-row">
      <div class="full">
        <label>Nuevo monto de apertura (₲)
          <input type="number" id="mod-apertura-monto" min="0" step="any" value="${aperturaActual || ''}" placeholder="Ej: 150000">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div class="full">
        <label>Motivo de la corrección
          <input type="text" id="mod-apertura-motivo" placeholder="Ej: Se abrió con 0 por error / Conteo inicial rectificado">
        </label>
      </div>
    </div>
    <div class="actions" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" onclick="confirmarEditarApertura(${cajaId})"><i data-lucide="check"></i> Guardar cambio</button>
    </div>
  `);
  reicons();
  setTimeout(() => $('#mod-apertura-monto')?.focus(), 50);
}

async function confirmarEditarApertura(cajaId) {
  const inputMonto = $('#mod-apertura-monto');
  const monto = parseFloat(inputMonto?.value);
  if (!Number.isFinite(monto) || monto < 0) {
    return toast('Ingresá un monto de apertura válido (0 o mayor)', 'warn');
  }
  const motivo = ($('#mod-apertura-motivo')?.value || '').trim() || 'Corrección de monto inicial';
  try {
    const r = await put('/api/caja/apertura', bodySucOperativa({ caja_id: cajaId, apertura: monto, motivo }));
    toast(`Apertura actualizada a ${fmtGs(r.apertura_nueva)}`, 'ok');
    cerrarModal();
    cargarCaja();
    cargarDashboard();
  } catch (e) {
    toast(e.message || 'Error al actualizar apertura', 'err');
  }
}

$('#btn-abrir-caja').addEventListener('click', async () => {
  try {
    const r = await post('/api/caja/abrir', bodySucOperativa({ apertura: parseFloat($('#caja-apertura').value) || 0 }));
    if (r.previas_abiertas && r.previas_abiertas.length) {
      const fechas = r.previas_abiertas.map((f) => fmtFecha(f)).join(', ');
      toast(`Ojo: ${r.previas_abiertas.length === 1 ? 'quedó una caja' : `quedaron ${r.previas_abiertas.length} cajas`} sin cerrar (${fechas}).`, 'warn');
    }
    toast('Caja abierta', 'ok');
    cargarCaja();
  } catch (e) { toast(e.message, 'err'); }
});

// ── Pestañas de caja (día actual / historial) ─────────────
$$('#caja-seg button').forEach((b) => b.addEventListener('click', () => {
  $$('#caja-seg button').forEach((x) => x.classList.toggle('activo', x === b));
  const seg = b.dataset.seg;
  $('#caja-dia').classList.toggle('hidden', seg !== 'dia');
  $('#caja-historial').classList.toggle('hidden', seg !== 'historial');
}));

function pintarHistorialCajas(lista) {
  if (!lista.length) {
    $('#tabla-historial-cajas').innerHTML = '<thead><tr><th>Fecha</th><th>Sucursal</th><th>Apertura</th><th>Efectivo</th><th>Transferencia</th><th>Tarjeta</th><th>Egresos</th><th>Esperado</th><th>Real</th><th>Diferencia</th><th>Estado</th><th></th></tr></thead><tbody>' + emptyStateHtml('wallet', 'Sin cajas registradas') + '</tbody>';
    return;
  }
  $('#tabla-historial-cajas').innerHTML = '<thead><tr><th>Fecha</th><th>Sucursal</th><th>Apertura</th><th>Efectivo</th><th>Transferencia</th><th>Tarjeta</th><th>Egresos</th><th>Esperado</th><th>Real</th><th>Diferencia</th><th>Estado</th><th></th></tr></thead><tbody>' +
    lista.map((c) => {
      const esperado = c.cierre_esperado != null ? c.cierre_esperado : c.apertura + c.ingresos - c.egresos;
      const diff = c.diferencia;
      return `<tr>
        <td><b>${fmtFecha(c.fecha)}</b></td>
        <td class="muted">${escapeHtml(c.sucursal_nombre || '—')}</td>
        <td>${fmtGs(c.apertura)}</td>
        <td style="color:var(--verde)">${fmtGs(c.ingresos || 0)}</td>
        <td>${fmtGs(c.transferencias || 0)}</td>
        <td>${fmtGs(c.tarjetas || 0)}</td>
        <td style="color:var(--rojo)">${fmtGs(c.egresos || 0)}</td>
        <td>${fmtGs(esperado)}</td>
        <td>${c.cierre_real != null ? fmtGs(c.cierre_real) : '—'}</td>
        <td class="${diff > 0 ? 'msg ok' : diff < 0 ? 'msg err' : ''}">${diff != null ? fmtGs(diff) : '—'}</td>
        <td>${c.estado === 'abierta' ? '<span class="tag ok">Abierta</span>' : '<span class="tag ticket">Cerrada</span>'}</td>
        <td><div class="actions">
          <button class="btn small ghost" onclick="verCaja(${c.id})"><i data-lucide="eye"></i></button>
          ${c.estado === 'cerrada' ? `<button class="btn small ghost" onclick="reabrirCaja(${c.id})"><i data-lucide="unlock"></i></button>` : ''}
        </div></td></tr>`;
    }).join('') + '</tbody>';
}

async function verCaja(id) {
  const c = await api('/api/cajas/' + id);
  const efectivo = c.total_efectivo ?? c.total_ingresos;
  const esperado = c.apertura + efectivo - c.total_egresos;
  const movs = c.movimientos.map((m) => `<tr>
    <td>${m.tipo === 'ingreso' ? '<i data-lucide="arrow-up-right"></i> Ingreso' : '<i data-lucide="arrow-down-right"></i> Egreso'}</td>
    <td>${escapeHtml(m.concepto)}</td><td>${fmtGs(m.monto)}</td>
  </tr>`).join('');
  const abierta = c.estado === 'abierta';
  abrirModal(`Caja del ${fmtFecha(c.fecha)}`, `
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="valor">${fmtGs(c.apertura)}</div><div class="etiqueta">Apertura</div></div>
      <div class="card positivo"><div class="valor">${fmtGs(efectivo)}</div><div class="etiqueta">Efectivo</div></div>
      <div class="card"><div class="valor">${fmtGs(c.total_transferencia || 0)}</div><div class="etiqueta">Transferencias</div></div>
      <div class="card"><div class="valor">${fmtGs(c.total_tarjeta || 0)}</div><div class="etiqueta">Tarjetas</div></div>
      <div class="card negativo"><div class="valor">${fmtGs(c.total_egresos)}</div><div class="etiqueta">Egresos</div></div>
      <div class="card ambar"><div class="valor">${fmtGs(esperado)}</div><div class="etiqueta">${c.estado === 'abierta' ? 'Esperado' : 'Cierre esperado'}</div></div>
    </div>
    ${c.cierre_real != null ? `<p class="muted" style="margin-bottom:10px">Cierre real: <b>${fmtGs(c.cierre_real)}</b> — Diferencia: <b class="${c.diferencia >= 0 ? '' : 'msg err'}">${fmtGs(c.diferencia)}</b></p>` : ''}
    <table><thead><tr><th>Tipo</th><th>Concepto</th><th>Monto</th></tr></thead><tbody>${movs || emptyStateHtml('receipt', 'Sin movimientos')}</tbody></table>
    ${abierta ? `
      <hr>
      <h3 style="margin-top:12px">Cerrar esta caja</h3>
      <p class="muted">Contá los billetes y monedas; el total y la diferencia se calculan automáticamente.</p>
      ${htmlArqueoCaja('vecaja-cierre-denom')}
      <p class="msg" id="vecaja-cierre-msg"></p>
      <button class="btn" style="width:100%" onclick="cerrarCajaModal(${c.id})">Cerrar caja</button>` : ''}
  `);
  reicons();
  if (abierta) conectarArqueoCaja('vecaja-cierre-denom', esperado);
}

async function cerrarCajaModal(cajaId) {
  try {
    const r = await post('/api/caja/cerrar', { caja_id: cajaId, denominaciones: leerArqueoCaja('vecaja-cierre-denom') });
    toast(`Caja cerrada. Diferencia: ${fmtGs(r.diferencia)}`, 'ok');
    msg($('#vecaja-cierre-msg'), `Caja cerrada. Esperado: ${fmtGs(r.esperado)} — Diferencia: ${fmtGs(r.diferencia)}`);
    cargarCaja();
    cargarDashboard();
    setTimeout(() => { modal.classList.add('hidden'); }, 1500);
  } catch (e) { msg($('#vecaja-cierre-msg'), escapeHtml(e.message), 'err'); }
}

async function reabrirCaja(id) {
  const c = await api('/api/cajas/' + id);
  const esperado = c.cierre_esperado != null ? c.cierre_esperado : c.apertura + c.total_ingresos - c.total_egresos;
  abrirModal(`Reabrir caja del ${fmtFecha(c.fecha)}`, `
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="valor">${fmtGs(c.apertura)}</div><div class="etiqueta">Apertura</div></div>
      <div class="card ambar"><div class="valor">${fmtGs(esperado)}</div><div class="etiqueta">Cierre esperado</div></div>
      <div class="card"><div class="valor">${c.cierre_real != null ? fmtGs(c.cierre_real) : '—'}</div><div class="etiqueta">Cierre real</div></div>
      <div class="card ${c.diferencia != null && c.diferencia < 0 ? 'negativo' : 'positivo'}"><div class="valor">${c.diferencia != null ? fmtGs(c.diferencia) : '—'}</div><div class="etiqueta">Diferencia</div></div>
    </div>
    <p class="msg err" style="padding:10px 12px;border-radius:8px;background:var(--rojo-bg)">
      <b>Al reabrir se eliminan el cierre y la diferencia registrados.</b><br>
      La caja vuelve a estado abierto para agregar o corregir movimientos.
    </p>
    <label style="display:block;margin-top:14px;font-weight:600">
      Motivo de la reapertura
      <input id="reabrir-motivo" placeholder="Ej: Error en el cierre, faltó registrar venta…"
             style="margin-top:6px;width:100%;box-sizing:border-box">
    </label>
    <div class="actions" style="margin-top:16px;justify-content:space-between">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" onclick="confirmarReabrir(${c.id})"><i data-lucide="unlock"></i> Reabrir caja</button>
    </div>`);
  reicons();
}

async function confirmarReabrir(id) {
  try {
    const motivo = ($('#reabrir-motivo')?.value || '').trim() || 'Reapertura de caja';
    await post('/api/cajas/' + id + '/reabrir', { motivo });
    toast('Caja reabierta', 'ok');
    cerrarModal();
    cargarCaja();
    cargarDashboard();
  } catch (e) { toast(e.message, 'err'); }
}

// ── Auditoría ─────────────────────────────────────────────
let _auditSucursales = null;

async function cargarAuditoria(pagina = 1) {
  const wrap = $('#tab-auditoria');
  if (!wrap) return;

  // Cargar sucursales la primera vez para el filtro
  if (!_auditSucursales) {
    try {
      _auditSucursales = await api('/api/sucursales');
      const sel = $('#audit-filtro-sucursal');
      if (sel) {
        sel.innerHTML = '<option value="">Todas las sucursales</option>' +
          _auditSucursales.map((s) => `<option value="${s.id}">${escapeHtml(s.nombre)}</option>`).join('');
      }
    } catch (_) { _auditSucursales = []; }
  }

  const tabla = $('#tabla-auditoria');
  const paginacion = $('#audit-paginacion');
  if (tabla) tabla.innerHTML = `<tbody>${spinnerHtml()}</tbody>`;

  const accion     = $('#audit-filtro-accion')?.value    || '';
  const sucursal   = $('#audit-filtro-sucursal')?.value  || '';
  const desde      = $('#audit-filtro-desde')?.value     || '';
  const hasta      = $('#audit-filtro-hasta')?.value     || '';
  const limite     = 25;

  let url = `/api/auditoria?pagina=${pagina}&limite=${limite}`;
  if (accion)   url += `&accion=${encodeURIComponent(accion)}`;
  if (sucursal) url += `&sucursal_id=${encodeURIComponent(sucursal)}`;
  if (desde)    url += `&desde=${encodeURIComponent(desde)}`;
  if (hasta)    url += `&hasta=${encodeURIComponent(hasta)}`;

  try {
    const { registros, total, pagina: pag, paginas } = await api(url);

    const etiquetaAccion = (a) => ({
      anular_venta:  'Anulación de venta',
      reabrir_caja:  'Reapertura de caja',
      cambio_precio: 'Cambio de precio',
    }[a] || a);

    const filas = (registros || []).map((r) => {
      let entidad = '';
      if (r.entidad_tipo === 'venta')    entidad = `Venta #${r.entidad_id}`;
      else if (r.entidad_tipo === 'caja') entidad = `Caja #${r.entidad_id}`;
      else if (r.entidad_tipo === 'producto') entidad = `Producto #${r.entidad_id}`;
      else if (r.entidad_id)             entidad = `${r.entidad_tipo} #${r.entidad_id}`;

      let detalles = '';
      if (r.detalles && Object.keys(r.detalles).length) {
        const d = r.detalles;
        if (r.accion === 'cambio_precio') {
          detalles = `${d.nombre ? escapeHtml(d.nombre) + ' — ' : ''}${fmtGs(d.precio_anterior)} → ${fmtGs(d.precio_nuevo)}`;
        } else {
          detalles = `<details><summary class="muted" style="cursor:pointer;font-size:.82em">Ver datos</summary><pre style="font-size:.78em;white-space:pre-wrap;max-width:280px">${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>`;
        }
      }

      return `<tr>
        <td style="white-space:nowrap">${fmtFechaHora(r.fecha)}</td>
        <td>${escapeHtml(r.usuario_nombre || '—')}</td>
        <td class="muted">${escapeHtml(r.sucursal_nombre || '—')}</td>
        <td><span class="tag ${r.accion === 'anular_venta' ? 'danger' : r.accion === 'reabrir_caja' ? 'azul' : ''}">${etiquetaAccion(r.accion)}</span></td>
        <td class="muted">${escapeHtml(entidad)}</td>
        <td>${escapeHtml(r.motivo || '—')}</td>
        <td style="font-size:.85em">${detalles}</td>
      </tr>`;
    }).join('');

    if (tabla) {
      tabla.innerHTML = `
        <thead><tr>
          <th>Fecha/hora</th><th>Usuario</th><th>Sucursal</th>
          <th>Operación</th><th>Entidad</th><th>Motivo</th><th>Detalles</th>
        </tr></thead>
        <tbody>${filas || emptyStateHtml('shield-check', 'Sin registros de auditoría')}</tbody>`;
    }

    // Paginación
    if (paginacion) {
      if (paginas <= 1) {
        paginacion.innerHTML = '';
      } else {
        paginacion.innerHTML = `
          <button class="btn small ghost" ${pag <= 1 ? 'disabled' : `onclick="cargarAuditoria(${pag - 1})"`}>
            <i data-lucide="chevron-left"></i> Anterior
          </button>
          <span class="muted" style="padding:0 12px">Página ${pag} de ${paginas} (${total} registros)</span>
          <button class="btn small ghost" ${pag >= paginas ? 'disabled' : `onclick="cargarAuditoria(${pag + 1})"`}>
            Siguiente <i data-lucide="chevron-right"></i>
          </button>`;
        reicons();
      }
    }
  } catch (e) {
    if (tabla) tabla.innerHTML = `<tbody><tr><td colspan="7" class="msg err">${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

// ── Gastos & Proveedores ─────────────────────────────────
let subtabGastosActual = 'varios';
let proveedoresGlobal = [];
let gastosFechaFiltroVarios = fechaHoy();
let gastosFechaFiltroProveedores = fechaHoy();
let gastosFiltroProveedorId = '';

async function cargarGastos() {
  if ($('#gastos-fecha-varios')) $('#gastos-fecha-varios').value = gastosFechaFiltroVarios || '';
  if ($('#gastos-fecha-proveedores')) $('#gastos-fecha-proveedores').value = gastosFechaFiltroProveedores || '';
  await recargarProveedores();
  await pintarGastos();
}

async function recargarProveedores() {
  try {
    proveedoresGlobal = await api('/api/proveedores');
  } catch (_) {
    proveedoresGlobal = [];
  }
  const sel = $('#gastos-filtro-proveedor');
  if (sel) {
    const valActual = sel.value;
    sel.innerHTML = '<option value="">Todos los proveedores</option>' +
      proveedoresGlobal.map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)}${p.rubro ? ` (${escapeHtml(p.rubro)})` : ''}</option>`).join('');
    sel.value = valActual;
  }
}

async function pintarGastos() {
  const tVarios = $('#tabla-gastos-varios');
  const tProv = $('#tabla-gastos-proveedores');
  if (tVarios) tVarios.innerHTML = spinnerHtml();
  if (tProv) tProv.innerHTML = spinnerHtml();

  let qVarios = '/api/gastos?tipo=varios';
  if (gastosFechaFiltroVarios) qVarios += '&fecha=' + gastosFechaFiltroVarios;

  let qProv = '/api/gastos?tipo=proveedor';
  if (gastosFechaFiltroProveedores) qProv += '&fecha=' + gastosFechaFiltroProveedores;
  if (gastosFiltroProveedorId) qProv += '&proveedor_id=' + gastosFiltroProveedorId;

  const [listVarios, listProveedores] = await Promise.all([
    api(withSucOperativa(qVarios)).catch(() => []),
    api(withSucOperativa(qProv)).catch(() => [])
  ]);

  const totalVarios = listVarios.reduce((acc, g) => acc + g.monto, 0);
  const totalProveedores = listProveedores.reduce((acc, g) => acc + g.monto, 0);
  const totalGeneral = totalVarios + totalProveedores;
  const totalEfectivo = listVarios.concat(listProveedores)
    .filter((g) => g.forma_pago !== 'transferencia')
    .reduce((acc, g) => acc + g.monto, 0);
  const totalTransferencia = listVarios.concat(listProveedores)
    .filter((g) => g.forma_pago === 'transferencia')
    .reduce((acc, g) => acc + g.monto, 0);

  if ($('#gastos-cards')) {
    $('#gastos-cards').innerHTML = `
      <div class="card negativo"><div class="valor">${fmtGs(totalVarios)}</div><div class="etiqueta">Gastos varios${gastosFechaFiltroVarios ? ' (' + fmtFecha(gastosFechaFiltroVarios) + ')' : ''}</div></div>
      <div class="card ambar"><div class="valor">${fmtGs(totalProveedores)}</div><div class="etiqueta">Pago a proveedores${gastosFechaFiltroProveedores ? ' (' + fmtFecha(gastosFechaFiltroProveedores) + ')' : ''}</div></div>
      <div class="card"><div class="valor">${fmtGs(totalGeneral)}</div><div class="etiqueta">Total egresos</div></div>
      <div class="card positivo"><div class="valor">${fmtGs(totalEfectivo)}</div><div class="etiqueta">Efectivo (Caja)</div></div>
      <div class="card"><div class="valor">${fmtGs(totalTransferencia)}</div><div class="etiqueta">Transferencias</div></div>
    `;
  }

  // Render tabla gastos varios
  if (tVarios) {
    if (!listVarios.length) {
      tVarios.innerHTML = '<thead><tr><th>Fecha</th><th>Categoría</th><th>Concepto</th><th>Motivo</th><th>Monto</th><th>Medio de pago</th><th></th></tr></thead><tbody>' + emptyStateHtml('receipt', 'Sin gastos varios registrados', gastosFechaFiltroVarios ? 'No hay gastos varios para esta fecha' : 'Registrá un gasto con el botón superior') + '</tbody>';
    } else {
      tVarios.innerHTML = '<thead><tr><th>Fecha</th><th>Categoría</th><th>Concepto</th><th>Motivo</th><th>Monto</th><th>Medio de pago</th><th></th></tr></thead><tbody>' +
        listVarios.map((g) => `<tr class="fila-nav" tabindex="0" title="Flechas: recorrer · Enter: acciones de la fila">
          <td><b>${fmtFecha(g.fecha)}</b></td>
          <td><span class="tag tarjeta">${escapeHtml(g.categoria)}</span></td>
          <td>${escapeHtml(g.concepto)}</td>
          <td class="muted">${g.motivo ? escapeHtml(g.motivo) : '—'}</td>
          <td style="font-weight:700">${fmtGs(g.monto)}</td>
          <td>${g.forma_pago === 'transferencia' ? '<span class="tag ticket"><i data-lucide="arrow-right-left"></i> Transferencia</span>' : '<span class="tag ok"><i data-lucide="banknote"></i> Efectivo (Caja)</span>'}</td>
          <td><button class="btn small danger ghost" onclick="eliminarGasto(${g.id})" title="Eliminar"><i data-lucide="trash-2"></i></button></td>
        </tr>`).join('') + '</tbody>';
    }
  }

  // Render tabla gastos proveedores
  if (tProv) {
    if (!listProveedores.length) {
      tProv.innerHTML = '<thead><tr><th>Fecha</th><th>Proveedor</th><th>Detalle / Insumo</th><th>N° Comprobante</th><th>Monto</th><th>Medio de pago</th><th></th></tr></thead><tbody>' + emptyStateHtml('truck', 'Sin compras o pagos a proveedores', gastosFechaFiltroProveedores ? 'No hay compras registradas para esta fecha' : 'Registrá una compra con el botón superior') + '</tbody>';
    } else {
      tProv.innerHTML = '<thead><tr><th>Fecha</th><th>Proveedor</th><th>Detalle / Insumo</th><th>N° Comprobante</th><th>Monto</th><th>Medio de pago</th><th></th></tr></thead><tbody>' +
        listProveedores.map((g) => `<tr class="fila-nav" tabindex="0" title="Flechas: recorrer · Enter: acciones de la fila">
          <td><b>${fmtFecha(g.fecha)}</b></td>
          <td>
            <strong>${escapeHtml(g.proveedor_nombre || 'Proveedor')}</strong>
            ${g.proveedor_rubro ? `<br><small class="muted">${escapeHtml(g.proveedor_rubro)}</small>` : ''}
          </td>
          <td>${escapeHtml(g.concepto)}</td>
          <td>${g.comprobante ? `<code>${escapeHtml(g.comprobante)}</code>` : '<span class="muted">—</span>'}</td>
          <td style="font-weight:700;color:var(--marron-deep)">${fmtGs(g.monto)}</td>
          <td>${g.forma_pago === 'transferencia' ? '<span class="tag ticket"><i data-lucide="arrow-right-left"></i> Transferencia</span>' : '<span class="tag ok"><i data-lucide="banknote"></i> Efectivo (Caja)</span>'}</td>
          <td><button class="btn small danger ghost" onclick="eliminarGasto(${g.id})" title="Eliminar"><i data-lucide="trash-2"></i></button></td>
        </tr>`).join('') + '</tbody>';
    }
  }

  reicons();
}

// ── Event listeners de la sección Gastos ──────────────────
$$('#gastos-seg button').forEach((b) => b.addEventListener('click', () => {
  $$('#gastos-seg button').forEach((x) => x.classList.toggle('activo', x === b));
  subtabGastosActual = b.dataset.subtab;
  const esVarios = subtabGastosActual === 'varios';
  $('#gastos-subtab-varios')?.classList.toggle('hidden', !esVarios);
  $('#gastos-subtab-proveedores')?.classList.toggle('hidden', esVarios);
  if ($('#btn-gestionar-proveedores')) $('#btn-gestionar-proveedores').style.display = esVarios ? 'none' : '';
  if ($('#btn-nuevo-gasto-texto')) $('#btn-nuevo-gasto-texto').textContent = esVarios ? 'Registrar gasto vario' : 'Pago a proveedor';
  pintarGastos();
}));

$('#btn-nuevo-gasto')?.addEventListener('click', () => {
  if (subtabGastosActual === 'proveedores') abrirModalPagoProveedor();
  else abrirModalGastoVario();
});

$('#btn-gestionar-proveedores')?.addEventListener('click', () => abrirModalGestionProveedores());

$('#btn-gastos-hoy-varios')?.addEventListener('click', () => {
  gastosFechaFiltroVarios = fechaHoy();
  if ($('#gastos-fecha-varios')) $('#gastos-fecha-varios').value = gastosFechaFiltroVarios;
  pintarGastos();
});
$('#btn-gastos-todos-varios')?.addEventListener('click', () => {
  gastosFechaFiltroVarios = null;
  if ($('#gastos-fecha-varios')) $('#gastos-fecha-varios').value = '';
  pintarGastos();
});
$('#gastos-fecha-varios')?.addEventListener('change', (e) => {
  gastosFechaFiltroVarios = e.target.value || null;
  pintarGastos();
});

$('#btn-gastos-hoy-proveedores')?.addEventListener('click', () => {
  gastosFechaFiltroProveedores = fechaHoy();
  if ($('#gastos-fecha-proveedores')) $('#gastos-fecha-proveedores').value = gastosFechaFiltroProveedores;
  pintarGastos();
});
$('#btn-gastos-todos-proveedores')?.addEventListener('click', () => {
  gastosFechaFiltroProveedores = null;
  if ($('#gastos-fecha-proveedores')) $('#gastos-fecha-proveedores').value = '';
  pintarGastos();
});
$('#gastos-fecha-proveedores')?.addEventListener('change', (e) => {
  gastosFechaFiltroProveedores = e.target.value || null;
  pintarGastos();
});
$('#gastos-filtro-proveedor')?.addEventListener('change', (e) => {
  gastosFiltroProveedorId = e.target.value || '';
  pintarGastos();
});

function abrirModalGastoVario() {
  const cats = ['Servicios', 'Limpieza', 'Mantenimiento', 'Insumos varios', 'Sueldos', 'Viáticos', 'Otros']
    .map((c) => `<option value="${c}">${c}</option>`).join('');
  abrirModal('Registrar gasto vario', `
    <div class="form-row">
      <div class="full">
        <label>Concepto del gasto
          <input id="gv-concepto" placeholder="Ej: Artículos de limpieza, Hielo, Reparación canilla">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Categoría
          <select id="gv-categoria">${cats}</select>
        </label>
      </div>
      <div>
        <label>Monto (₲)
          <input type="number" id="gv-monto" min="1" step="any" placeholder="0">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Medio de pago
          <select id="gv-forma-pago">
            <option value="efectivo">Efectivo (se descuenta de la caja abierta)</option>
            <option value="transferencia">Transferencia bancaria (no descuenta de caja)</option>
          </select>
        </label>
      </div>
      <div>
        <label>Fecha (vacío = hoy)
          <input type="date" id="gv-fecha" value="${fechaHoy()}">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div class="full">
        <label>Motivo u observaciones (opcional)
          <input id="gv-motivo" placeholder="Ej: Se compró lavandina y trapos porque se terminó el stock">
        </label>
      </div>
    </div>
    <div class="actions" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" onclick="guardarGastoVario()"><i data-lucide="save"></i> Registrar gasto</button>
    </div>
  `);
  reicons();
  setTimeout(() => $('#gv-concepto')?.focus(), 50);
}

async function guardarGastoVario() {
  const concepto = ($('#gv-concepto')?.value || '').trim();
  const monto = parseFloat($('#gv-monto')?.value);
  if (!concepto) return toast('Ingresá el concepto del gasto', 'warn');
  if (!Number.isFinite(monto) || monto <= 0) return toast('Ingresá un monto válido mayor a 0', 'warn');

  const body = bodySucOperativa({
    tipo: 'varios',
    concepto,
    categoria: $('#gv-categoria')?.value || 'Otros',
    motivo: ($('#gv-motivo')?.value || '').trim(),
    monto,
    forma_pago: $('#gv-forma-pago')?.value || 'efectivo',
    fecha: $('#gv-fecha')?.value || fechaHoy()
  });

  try {
    await post('/api/gastos', body);
    cerrarModal();
    toast('Gasto vario registrado correctamente', 'ok');
    pintarGastos();
    cargarDashboard();
    cargarCaja();
  } catch (e) {
    toast(e.message || 'Error al guardar gasto', 'err');
  }
}

function abrirModalPagoProveedor() {
  if (!proveedoresGlobal.length) {
    return abrirModalNuevoProveedor(true);
  }
  const provsOpts = proveedoresGlobal.map((p) =>
    `<option value="${p.id}">${escapeHtml(p.nombre)}${p.rubro ? ` · ${escapeHtml(p.rubro)}` : ''}</option>`
  ).join('');

  abrirModal('Registrar pago a proveedor', `
    <div class="form-row">
      <div class="full">
        <div style="display:flex;align-items:flex-end;gap:8px">
          <div style="flex:1">
            <label>Proveedor
              <select id="pp-proveedor" class="pos-select full">${provsOpts}</select>
            </label>
          </div>
          <button type="button" class="btn ghost small" style="margin-bottom:10px" onclick="abrirModalNuevoProveedor(true)"><i data-lucide="plus"></i> Nuevo proveedor</button>
        </div>
      </div>
    </div>
    <div class="form-row">
      <div class="full">
        <label>Detalle / Insumos adquiridos
          <input id="pp-concepto" placeholder="Ej: 10 bolsas harina 000, 2 cajas levadura">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Monto total (₲)
          <input type="number" id="pp-monto" min="1" step="any" placeholder="0">
        </label>
      </div>
      <div>
        <label>N° Factura / Remisión (opcional)
          <input id="pp-comprobante" placeholder="Ej: 001-001-0001234">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Medio de pago
          <select id="pp-forma-pago">
            <option value="transferencia">Transferencia bancaria (no descuenta de caja)</option>
            <option value="efectivo">Efectivo (se retira del cajón de la caja abierta)</option>
          </select>
        </label>
      </div>
      <div>
        <label>Fecha (vacío = hoy)
          <input type="date" id="pp-fecha" value="${fechaHoy()}">
        </label>
      </div>
    </div>
    <div class="actions" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button class="btn ghost" onclick="cerrarModal()">Cancelar</button>
      <button class="btn" onclick="guardarPagoProveedor()"><i data-lucide="save"></i> Registrar pago</button>
    </div>
  `);
  reicons();
  setTimeout(() => $('#pp-concepto')?.focus(), 50);
}

async function guardarPagoProveedor() {
  const proveedorId = parseInt($('#pp-proveedor')?.value, 10);
  const concepto = ($('#pp-concepto')?.value || '').trim();
  const monto = parseFloat($('#pp-monto')?.value);
  if (!proveedorId) return toast('Seleccioná un proveedor', 'warn');
  if (!concepto) return toast('Ingresá el detalle o concepto de la compra', 'warn');
  if (!Number.isFinite(monto) || monto <= 0) return toast('Ingresá un monto válido mayor a 0', 'warn');

  const body = bodySucOperativa({
    tipo: 'proveedor',
    proveedor_id: proveedorId,
    concepto,
    comprobante: ($('#pp-comprobante')?.value || '').trim(),
    monto,
    forma_pago: $('#pp-forma-pago')?.value || 'transferencia',
    fecha: $('#pp-fecha')?.value || fechaHoy()
  });

  try {
    await post('/api/gastos', body);
    cerrarModal();
    toast('Pago a proveedor registrado correctamente', 'ok');
    pintarGastos();
    cargarDashboard();
    cargarCaja();
  } catch (e) {
    toast(e.message || 'Error al registrar pago', 'err');
  }
}

function abrirModalGestionProveedores() {
  const renderTabla = (lista) => {
    if (!lista.length) return emptyStateHtml('truck', 'Sin proveedores cargados', 'Agregá proveedores con el botón superior');
    return `<table>
      <thead><tr><th>Nombre</th><th>Rubro</th><th>Contacto / Teléfono</th><th>RUC</th><th></th></tr></thead>
      <tbody>
        ${lista.map((p) => `<tr>
          <td><strong>${escapeHtml(p.nombre)}</strong>${p.direccion ? `<br><small class="muted">${escapeHtml(p.direccion)}</small>` : ''}</td>
          <td><span class="tag tarjeta">${escapeHtml(p.rubro || 'General')}</span></td>
          <td>${escapeHtml(p.contacto || '')}${p.telefono ? `<br><small><i data-lucide="phone" style="width:11px;height:11px"></i> ${escapeHtml(p.telefono)}</small>` : ''}</td>
          <td>${p.ruc ? `<code>${escapeHtml(p.ruc)}</code>` : '<span class="muted">—</span>'}</td>
          <td><div class="actions">
            <button class="btn small ghost" onclick="abrirModalNuevoProveedor(false, ${p.id})" title="Editar"><i data-lucide="edit-2"></i></button>
            <button class="btn small danger ghost" onclick="eliminarProveedor(${p.id})" title="Dar de baja"><i data-lucide="trash-2"></i></button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  };

  abrirModal('Gestión de Proveedores', `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap">
      <input type="text" id="prov-buscar-input" class="buscar" placeholder="Buscar proveedor por nombre, rubro o RUC..." style="max-width:320px;margin:0">
      <button class="btn" onclick="abrirModalNuevoProveedor(false)"><i data-lucide="plus"></i> Nuevo proveedor</button>
    </div>
    <div id="prov-tabla-container" style="max-height:400px;overflow-y:auto;border:1px solid var(--borde);border-radius:var(--radius-sm)">
      ${renderTabla(proveedoresGlobal)}
    </div>
  `);
  reicons();

  $('#prov-buscar-input')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    const filtrados = proveedoresGlobal.filter((p) =>
      p.nombre.toLowerCase().includes(q) ||
      (p.rubro || '').toLowerCase().includes(q) ||
      (p.ruc || '').toLowerCase().includes(q) ||
      (p.contacto || '').toLowerCase().includes(q)
    );
    $('#prov-tabla-container').innerHTML = renderTabla(filtrados);
    reicons();
  });
}

function abrirModalNuevoProveedor(volverAPago = false, proveedorId = null) {
  const p = proveedorId ? (proveedoresGlobal.find((x) => x.id === proveedorId) || {}) : {};
  const esEdicion = !!proveedorId;

  abrirModal(esEdicion ? `Editar proveedor — ${p.nombre}` : 'Nuevo proveedor', `
    <div class="form-row">
      <div class="full">
        <label>Nombre del proveedor / Empresa
          <input id="np-nombre" value="${escapeHtml(p.nombre || '')}" placeholder="Ej: Molinos Asunción S.A.">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Rubro principal
          <input id="np-rubro" value="${escapeHtml(p.rubro || '')}" placeholder="Ej: Harinas, Levaduras, Lácteos, Packaging">
        </label>
      </div>
      <div>
        <label>RUC (opcional)
          <input id="np-ruc" value="${escapeHtml(p.ruc || '')}" placeholder="Ej: 80012345-6">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Teléfono / WhatsApp
          <input id="np-telefono" value="${escapeHtml(p.telefono || '')}" placeholder="Ej: 0981-123456">
        </label>
      </div>
      <div>
        <label>Persona de contacto / Vendedor
          <input id="np-contacto" value="${escapeHtml(p.contacto || '')}" placeholder="Ej: Carlos Gómez">
        </label>
      </div>
    </div>
    <div class="form-row">
      <div class="full">
        <label>Dirección (opcional)
          <input id="np-direccion" value="${escapeHtml(p.direccion || '')}" placeholder="Ej: Av. Fernando de la Mora 450">
        </label>
      </div>
    </div>
    <div class="actions" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button class="btn ghost" onclick="${volverAPago ? 'abrirModalPagoProveedor()' : 'abrirModalGestionProveedores()'}">Cancelar</button>
      <button class="btn" onclick="guardarProveedor(${esEdicion ? p.id : 'null'}, ${volverAPago})"><i data-lucide="save"></i> ${esEdicion ? 'Actualizar' : 'Guardar proveedor'}</button>
    </div>
  `);
  reicons();
  setTimeout(() => $('#np-nombre')?.focus(), 50);
}

async function guardarProveedor(id, volverAPago) {
  const nombre = ($('#np-nombre')?.value || '').trim();
  if (!nombre) return toast('Ingresá el nombre del proveedor', 'warn');

  const datos = {
    nombre,
    rubro: ($('#np-rubro')?.value || '').trim(),
    ruc: ($('#np-ruc')?.value || '').trim(),
    telefono: ($('#np-telefono')?.value || '').trim(),
    contacto: ($('#np-contacto')?.value || '').trim(),
    direccion: ($('#np-direccion')?.value || '').trim(),
  };

  try {
    if (id) {
      await put('/api/proveedores/' + id, datos);
      toast('Proveedor actualizado', 'ok');
    } else {
      await post('/api/proveedores', datos);
      toast('Proveedor creado', 'ok');
    }
    await recargarProveedores();
    if (volverAPago) {
      abrirModalPagoProveedor();
    } else {
      abrirModalGestionProveedores();
    }
  } catch (e) {
    toast(e.message || 'Error al guardar proveedor', 'err');
  }
}

async function eliminarProveedor(id) {
  if (!await confirmarAccion({
    titulo: 'Desactivar proveedor',
    mensaje: '¿Deseas dar de baja este proveedor? Los pagos y compras históricas no se borrarán.',
    aceptar: 'Desactivar',
    peligro: true,
  })) return;
  try {
    await del('/api/proveedores/' + id);
    toast('Proveedor dado de baja', 'warn');
    await recargarProveedores();
    abrirModalGestionProveedores();
  } catch (e) {
    toast(e.message || 'Error al desactivar proveedor', 'err');
  }
}

async function eliminarGasto(id) {
  if (!await confirmarAccion({
    titulo: 'Eliminar gasto',
    mensaje: '¿Eliminar este registro? Si afectó a la caja, también se revertirá el egreso.',
    aceptar: 'Eliminar gasto',
    peligro: true,
  })) return;
  try {
    await del('/api/gastos/' + id);
    toast('Gasto eliminado', 'warn');
    pintarGastos();
    cargarDashboard();
    cargarCaja();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ── Configuración ─────────────────────────────────────────
let cfgLogo = '';

function pintarLogoPref() {
  const host = $('#cfg-logo-preview');
  if (cfgLogo) {
    host.innerHTML = `<img src="${cfgLogo}" alt="Logo del negocio">`;
    host.style.display = 'block';
    $('#btn-quitar-logo').style.display = '';
  } else {
    host.innerHTML = '';
    host.style.display = 'none';
    $('#btn-quitar-logo').style.display = 'none';
  }
}

$('#btn-subir-logo')?.addEventListener('click', () => $('#cfg-logo-input')?.click());
$('#cfg-logo-input')?.addEventListener('change', (e) => {
  const archivo = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!archivo) return;
  if (archivo.size > 2000000) return toast('El logo debe pesar menos de 2 MB', 'warn');
  const fr = new FileReader();
  fr.onload = () => { cfgLogo = String(fr.result || ''); pintarLogoPref(); toast('Logo cargado. Guardá la configuración para aplicarlo.', 'ok'); };
  fr.onerror = () => toast('No se pudo leer la imagen', 'err');
  fr.readAsDataURL(archivo);
});

$('#btn-quitar-logo')?.addEventListener('click', () => { cfgLogo = ''; pintarLogoPref(); });

async function cargarConfig() {
  const cfg = await api('/api/config');
  configGlobal = cfg;
  $('#cfg-usuario').textContent = usuarioActual || '—';
  $('#cfg-nombre').value = cfg.nombre_negocio || '';
  $('#cfg-ruc').value = cfg.ruc || '';
  $('#cfg-actividad').value = cfg.actividad_economica || '';
  $('#cfg-direccion').value = cfg.direccion || '';
  $('#cfg-telefono').value = cfg.telefono || '';
  $('#cfg-ciudad').value = cfg.ciudad || '';
  if ($('#cfg-permitir-sin-stock')) {
    $('#cfg-permitir-sin-stock').checked = cfg.permitir_venta_sin_stock === undefined || Number(cfg.permitir_venta_sin_stock) === 1;
  }
  cfgLogo = cfg.logo || '';
  pintarLogoPref();

  if (!licenciaInfo) licenciaInfo = await api('/api/licencia');
  const l = licenciaInfo;
  const comprado = l.modo === 'comprado';
  $('#licencia-box').innerHTML = comprado ? `
    <p class="msg ok"><i data-lucide="badge-check" style="width:15px;height:15px;vertical-align:-2px"></i> <b>Versión completa activada.</b> Gracias por confiar en el sistema. Tenés reportes históricos ilimitados, exportación de datos y comprobantes sin la marca de prueba.</p>`
  : `
    <p class="muted" style="margin-bottom:12px">Estás usando la <b>versión de prueba</b>: quedan <b>${l.dias_restantes} día${l.dias_restantes === 1 ? '' : 's'}</b> (hasta el <b>${fmtFecha(l.fin)}</b>). Todo funciona, salvo los límites anunciados:</p>
    <ul style="margin:0 0 14px;padding-left:20px;line-height:1.8">
      <li>Reportes históricos: últimos ${l.limite_reporte ? l.limite_reporte.dias : 7} días.</li>
      <li>Exportación de datos: deshabilitada (versión completa).</li>
      <li>Al vencer, el sistema pasa a solo-lectura (no se apagan los datos).</li>
    </ul>
    <div class="form-row">
      <div><label>Código para reiniciar la prueba
        <input id="lic-codigo-prueba" placeholder="Ej: a1b2c3d4e5f6"></label></div>
      <div><label>Código de activación
        <input id="lic-codigo-comprado" placeholder="Ej: f6e5d4c3b2a1"></label></div>
    </div>
    <p class="muted" style="margin-top:0">Los dos códigos te los da quien instaló el sistema.</p>
    <div class="actions" style="justify-content:flex-start">
      <button class="btn" id="btn-lic-activar"><i data-lucide="badge-check"></i> Activar versión completa</button>
      <button class="btn ghost" id="btn-lic-reiniciar"><i data-lucide="refresh-ccw"></i> Reiniciar prueba (2 meses)</button>
    </div>
    <p class="msg" id="lic-msg"></p>`;
  $('#btn-lic-activar')?.addEventListener('click', () => activarOReiniciarLicencia('activar'));
  $('#btn-lic-reiniciar')?.addEventListener('click', () => activarOReiniciarLicencia('reiniciar'));
  if (licenciaInfo) {
    $('#export-msg').innerHTML = l.modo === 'prueba'
      ? '<span class="msg err">La exportación se habilita con la versión completa.</span>'
      : '';
  }
  await pintarSucursalesYUsuarios();
  if (esDueño) await cargarConfigFiscal();
  reicons();
}

// ── Sucursales y usuarios (Configuración, solo dueño) ──
async function pintarSucursalesYUsuarios() {
  const boxS = $('#box-sucursales');
  const boxU = $('#box-usuarios');
  const boxDemo = $('#box-demo');
  const boxNegocio = $('#box-negocio-config');
  const boxFiscal = $('#box-fiscal');
  const boxLicencia = $('#box-licencia');
  if (!esDueño) {
    if (boxS) boxS.style.display = 'none';
    if (boxU) boxU.style.display = 'none';
    if (boxNegocio) boxNegocio.style.display = 'none';
    if (boxFiscal) boxFiscal.style.display = 'none';
    if (boxLicencia) boxLicencia.style.display = 'none';
    // Restablecer la demo borra los datos de todas las sucursales: es
    // exclusivo del dueño (el servidor también lo exige).
    if (boxDemo) boxDemo.style.display = 'none';
    return;
  }
  if (boxS) boxS.style.display = '';
  if (boxU) boxU.style.display = '';
  if (boxDemo) boxDemo.style.display = '';
  if (boxNegocio) boxNegocio.style.display = '';
  if (boxFiscal) boxFiscal.style.display = '';
  if (boxLicencia) boxLicencia.style.display = '';
  const [sucursales, usuarios] = await Promise.all([api('/api/sucursales'), api('/api/usuarios')]);
  sucursalesGlobal = sucursales;
  usuariosGlobal = usuarios;
  const tablaS = $('#tabla-sucursales');
  if (tablaS) {
    tablaS.innerHTML = '<thead><tr><th>Sucursal</th><th>Dirección</th><th>Ventas</th><th>Estado</th><th></th></tr></thead><tbody>' +
      (sucursales.length ? sucursales.map((s) => `<tr>
        <td><b>${escapeHtml(s.nombre)}</b></td>
        <td class="muted">${escapeHtml(s.direccion) || '—'}</td>
        <td>${s.ventas ?? '—'}</td>
        <td>${s.activa ? '<span class="tag ok">Activa</span>' : '<span class="tag ticket">Inactiva</span>'}</td>
        <td><div class="actions"><button class="btn small ghost" onclick="modalSucursal(${s.id})"><i data-lucide="pencil"></i> Editar</button></div></td>
      </tr>`).join('') : '<tr><td colspan="5">' + emptyStateHtml('store', 'Sin sucursales', 'Creá la primera') + '</td></tr>') +
      '</tbody>';
  }
  const tablaU = $('#tabla-usuarios');
  if (tablaU) {
    tablaU.innerHTML = '<thead><tr><th>Usuario</th><th>Sucursal</th><th>Estado</th><th></th></tr></thead><tbody>' +
      (usuarios.length ? usuarios.map((u) => `<tr>
        <td><b>${escapeHtml(u.usuario)}</b></td>
        <td class="muted">${escapeHtml(u.sucursal_nombre) || 'Todas (dueño)'}</td>
        <td>${u.activo ? '<span class="tag ok">Activo</span>' : '<span class="tag ticket">Inactivo</span>'}</td>
        <td><div class="actions"><button class="btn small ghost" onclick="modalUsuario(${u.id})"><i data-lucide="pencil"></i> Editar</button></div></td>
      </tr>`).join('') : '<tr><td colspan="4">' + emptyStateHtml('users', 'Sin usuarios') + '</td></tr>') +
      '</tbody>';
  }
  pintarSucursalActiva();
  pintarFiltroReportes();
  reicons();
}

let productosConfigIva = [];

async function cargarConfigFiscal() {
  const selector = $('#cfg-fiscal-sucursal');
  if (!selector || !esDueño) return;
  const sucursalActual = Number(selector.value) || sucursalActiva || (sucursalesGlobal[0] && sucursalesGlobal[0].id);
  selector.innerHTML = sucursalesGlobal.map((s) =>
    `<option value="${s.id}" ${s.id === sucursalActual ? 'selected' : ''}>${escapeHtml(s.nombre)}</option>`
  ).join('');
  if (!sucursalActual) return;
  try {
    const data = await api(`/api/config/fiscal?sucursal_id=${sucursalActual}`);
    const f = data.fiscal || {};
    $('#cfg-fiscal-timbrado').value = f.timbrado || '';
    $('#cfg-fiscal-vigencia').value = f.timbrado_vigencia || '';
    $('#cfg-fiscal-establecimiento').value = f.establecimiento || '001';
    $('#cfg-fiscal-punto').value = f.punto_expedicion || '001';
    $('#cfg-fiscal-desde').value = f.numero_desde || 1;
    $('#cfg-fiscal-hasta').value = f.numero_hasta || 9999999;
    productosConfigIva = data.productos || [];
    pintarConfigIva();
    msg($('#cfg-fiscal-msg'), '', '');
  } catch (e) {
    msg($('#cfg-fiscal-msg'), escapeHtml(e.message), 'err');
  }
}

function pintarConfigIva() {
  const tabla = $('#cfg-iva-productos');
  if (!tabla) return;
  if (!productosConfigIva.length) {
    tabla.innerHTML = '<tbody><tr><td class="muted">No hay productos activos para configurar.</td></tr></tbody>';
    return;
  }
  tabla.innerHTML = `<thead><tr><th>Producto</th><th>Categoría</th><th>Tasa de IVA</th></tr></thead><tbody>${
    productosConfigIva.map((p) => `<tr>
      <td><b>${escapeHtml(p.nombre)}</b></td><td>${escapeHtml(p.categoria)}</td>
      <td><select id="iva-producto-${p.id}" class="pos-select" aria-label="IVA de ${escapeAttr(p.nombre)}">
        <option value="" ${p.iva_tasa == null ? 'selected' : ''}>Sin configurar</option>
        <option value="0" ${Number(p.iva_tasa) === 0 ? 'selected' : ''}>Exenta</option>
        <option value="5" ${Number(p.iva_tasa) === 5 ? 'selected' : ''}>5%</option>
        <option value="10" ${Number(p.iva_tasa) === 10 ? 'selected' : ''}>10%</option>
      </select></td>
    </tr>`).join('')
  }</tbody>`;
}

$('#btn-guardar-fiscal')?.addEventListener('click', async () => {
  const boton = $('#btn-guardar-fiscal');
  boton.disabled = true;
  try {
    await put('/api/config/fiscal', {
      sucursal_id: Number($('#cfg-fiscal-sucursal').value),
      timbrado: $('#cfg-fiscal-timbrado').value.trim(),
      timbrado_vigencia: $('#cfg-fiscal-vigencia').value,
      establecimiento: $('#cfg-fiscal-establecimiento').value.trim(),
      punto_expedicion: $('#cfg-fiscal-punto').value.trim(),
      numero_desde: Number($('#cfg-fiscal-desde').value),
      numero_hasta: Number($('#cfg-fiscal-hasta').value),
    });
    msg($('#cfg-fiscal-msg'), 'Datos de timbrado y numeración guardados.', 'ok');
    toast('Configuración fiscal guardada', 'ok');
  } catch (e) {
    msg($('#cfg-fiscal-msg'), escapeHtml(e.message), 'err');
  } finally {
    boton.disabled = false;
  }
});

$('#btn-guardar-iva')?.addEventListener('click', async () => {
  const boton = $('#btn-guardar-iva');
  boton.disabled = true;
  try {
    await put('/api/config/fiscal/iva', {
      productos: productosConfigIva.map((p) => ({
        id: p.id,
        iva_tasa: $(`#iva-producto-${p.id}`).value,
      })),
    });
    msg($('#cfg-iva-msg'), 'Tasas de IVA guardadas.', 'ok');
    toast('IVA de productos actualizado', 'ok');
    await cargarConfigFiscal();
  } catch (e) {
    msg($('#cfg-iva-msg'), escapeHtml(e.message), 'err');
  } finally {
    boton.disabled = false;
  }
});

function opcionesSucursalSel(seleccionada) {
  return sucursalesGlobal.map((s) => `<option value="${s.id}" ${s.id === seleccionada ? 'selected' : ''}>${escapeHtml(s.nombre)}</option>`).join('');
}

function modalSucursal(id) {
  const s = sucursalesGlobal.find((x) => x.id === id);
  if (!s) return;
  abrirModal(`Sucursal: ${s.nombre}`, `
    <div class="form-row">
      <div class="full"><label>Nombre<input id="sc-nombre" value="${escapeHtml(s.nombre)}"></label></div>
    </div>
    <div class="form-row">
      <div class="full"><label>Dirección<input id="sc-direccion" value="${escapeHtml(s.direccion)}"></label></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="sc-activa" ${s.activa ? 'checked' : ''}> Sucursal activa</label>
    <p class="muted" style="margin-top:8px">Desactivar solo la esconde de los catálogos; las ventas históricas se conservan.</p>
    <button class="btn" style="width:100%;margin-top:16px" onclick="guardarSucursal(${s.id})"><i data-lucide="save"></i> Guardar</button>`);
}

function nuevaSucursal() {
  abrirModal('Nueva sucursal', `
    <div class="form-row">
      <div class="full"><label>Nombre<input id="sc-nombre" placeholder="Ej: Sucursal Centro"></label></div>
    </div>
    <div class="form-row">
      <div class="full"><label>Dirección<input id="sc-direccion" placeholder="Ej: Av. Central 500"></label></div>
    </div>
    <button class="btn" style="width:100%;margin-top:16px" onclick="guardarSucursal(null)"><i data-lucide="plus"></i> Crear sucursal</button>`);
}

async function guardarSucursal(id) {
  const nombre = ($('#sc-nombre')?.value || '').trim();
  if (!nombre) return toast('Ingresá el nombre', 'warn');
  const body = { nombre, direccion: ($('#sc-direccion')?.value || '').trim() };
  const activaEl = $('#sc-activa');
  if (activaEl) Object.assign(body, { activa: activaEl.checked ? 1 : 0 });
  try {
    if (id) await put('/api/sucursales/' + id, body);
    else await post('/api/sucursales', body);
    modal?.classList.add('hidden');
    toast(id ? 'Sucursal actualizada' : 'Sucursal creada', 'ok');
    cargarConfig();
  } catch (e) { toast(e.message, 'err'); }
}

function modalUsuario(id) {
  const u = id ? usuariosGlobal.find((x) => x.id === id) : null;
  abrirModal(u ? `Usuario: ${u.usuario}` : 'Nuevo usuario', `
    <div class="form-row">
      <div class="full"><label>Usuario para entrar al sistema<input id="us-usuario" value="${escapeHtml(u ? u.usuario : '')}" ${id ? 'readonly' : ''}></label></div>
    </div>
    <div class="form-row">
      <div class="full"><label>¿En qué sucursal trabaja? (Todas las sucursales = dueño, ve y administra todo)
        <select id="us-sucursal">
          <option value="">Todas las sucursales</option>
          ${opcionesSucursalSel(u ? u.sucursal_id : null)}
        </select></label></div>
    </div>
    <div class="form-row">
      <div class="full"><label>${id ? 'Contraseña nueva (dejá vacío para no cambiarla)' : 'Contraseña (mínimo 6 caracteres)'}<input type="password" id="us-password" autocomplete="new-password"></label></div>
    </div>
    ${id ? `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="us-activo" ${u.activo ? 'checked' : ''}> Usuario activo</label>` : ''}
    <button class="btn" style="width:100%;margin-top:16px" onclick="guardarUsuario(${id || 'null'})"><i data-lucide="save"></i> Guardar</button>`);
}

async function guardarUsuario(id) {
  const body = {};
  if (id) {
    const p = $('#us-password').value;
    if (p) {
      if (p.length < 6) return toast('La contraseña debe tener al menos 6 caracteres', 'warn');
      body.password = p;
    }
    body.activo = $('#us-activo').checked ? 1 : 0;
  } else {
    const u = ($('#us-usuario').value || '').trim();
    const p = $('#us-password').value;
    if (!u || p.length < 6) return toast('Completá usuario y una contraseña de al menos 6 caracteres', 'warn');
    body.usuario = u;
    body.password = p;
  }
  body.sucursal_id = $('#us-sucursal').value || null;
  try {
    if (id) await put('/api/usuarios/' + id, body);
    else await post('/api/usuarios', body);
    modal?.classList.add('hidden');
    toast(id ? 'Usuario actualizado' : 'Usuario creado', 'ok');
    cargarConfig();
  } catch (e) { toast(e.message, 'err'); }
}

// ── Instalar como aplicación (PWA) ─────────────────────
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const m = $('#instalar-msg');
  if (m) m.textContent = '';
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('¡Aplicación instalada! Encontrás el ícono en el escritorio o pantalla de inicio.', 'ok');
});

function instalarApp() {
  if (installPrompt) {
    const b = $('#btn-instalar');
    if (b) b.disabled = true;
    installPrompt.prompt();
    installPrompt.userChoice.then(() => {
      installPrompt = null;
      if ($('#btn-instalar')) $('#btn-instalar').disabled = false;
    }).catch(() => {
      if ($('#btn-instalar')) $('#btn-instalar').disabled = false;
    });
    return;
  }
  abrirModal('Instalar el sistema', `
    <p>Tu navegador no mostró el botón de instalar. Suele pasar cuando entrás por <b>http://IP-de-la-red</b>: Chrome y el iPhone exigen conexión segura (https) para apps instalables.</p>
    <ul style="margin:10px 0 0 18px;line-height:1.7">
      <li><b>Esta computadora (Chrome o Edge):</b> abrí <code>http://localhost:3000</code> y usá el ícono de <b>Instalar</b> que aparece a la derecha de la barra de direcciones.</li>
      <li><b>Celular Android (Chrome):</b> menú ⋮ → <b>Agregar a pantalla de inicio</b>.</li>
      <li><b>iPhone/iPad (Safari):</b> botón <b>Compartir</b> → <b>Agregar a pantalla de inicio</b>.</li>
    </ul>
    <p style="margin-top:10px" class="muted">Con "Agregar a pantalla de inicio" el atajo abre igual el sistema, aunque sin todos los beneficios de una app instalada.</p>
    <button class="btn" style="width:100%;margin-top:14px" onclick="cerrarModal()">Entendido</button>`);
}

$('#btn-instalar')?.addEventListener('click', instalarApp);

$('#btn-guardar-config').addEventListener('click', async () => {
  const boton = $('#btn-guardar-config');
  boton.disabled = true;
  try {
    await put('/api/config', {
      nombre_negocio: $('#cfg-nombre').value, ruc: $('#cfg-ruc').value,
      actividad_economica: $('#cfg-actividad').value, direccion: $('#cfg-direccion').value,
      telefono: $('#cfg-telefono').value, ciudad: $('#cfg-ciudad').value,
      logo: cfgLogo,
      permitir_venta_sin_stock: $('#cfg-permitir-sin-stock')?.checked ? 1 : 0
    });
    configGlobal = await api('/api/config');
    toast('Configuración guardada', 'ok');
    msg($('#cfg-msg'), 'Configuración guardada');
  } catch (e) {
    toast(e.message, 'err');
    msg($('#cfg-msg'), escapeHtml(e.message), 'err');
  } finally {
    boton.disabled = false;
  }
});

$('#btn-reset-demo').addEventListener('click', async () => {
  if (!await confirmarAccion({
    titulo: 'Restablecer datos de demostración',
    mensaje: 'Se borrarán las ventas, productos, clientes, cajas y gastos cargados y se restaurarán los datos de prueba. Esta acción no se puede deshacer.',
    aceptar: 'Restablecer datos',
    peligro: true,
  })) return;
  const btn = $('#btn-reset-demo');
  btn.disabled = true;
  try {
    await post('/api/demo/restablecer', {});
    toast('Datos demo restablecidos', 'ok');
    msg($('#reset-demo-msg'), 'Datos demo restablecidos. Recargando...');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast(e.message, 'err');
    msg($('#reset-demo-msg'), escapeHtml(e.message), 'err');
    btn.disabled = false;
  }
});

// ── Arranque ──────────────────────────────────────────────
async function arrancar() {
  ['tabla-productos', 'tabla-clientes', 'tabla-gastos-varios', 'tabla-gastos-proveedores'].forEach(hacerTablaNavegable);
  instalarNavegacionCarrito();
  try {
    const r = await api('/api/auth/session');
    ocultarLogin(r.usuario, r);
    cargarDatosSesion().then(() => {
      cargarDashboard();
      cargarLicencia();
      cargarPos();
      cargarCaja();
      chequearTerminos();
    });
  } catch (_) {
    mostrarLogin();
  }
}
arrancar();