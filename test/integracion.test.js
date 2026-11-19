// Test de integración: levanta el server real contra una base Postgres dedicada
// (panaderia_test) y ejercita los flujos principales vía HTTP.
// Requiere el Postgres de compose arriba (docker compose up -d db).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const PUERTO = 3417;
const BASE = `http://127.0.0.1:${PUERTO}`;
const DB_TEST = process.env.DB_TEST || 'panaderia_test';
const URL_ADMIN = process.env.DATABASE_URL_ADMIN || 'postgres://panaderia:admin123@localhost:5432/postgres';
const URL_TEST = process.env.DATABASE_URL_TEST || `postgres://panaderia:admin123@localhost:5432/${DB_TEST}`;

const REPO = path.join(__dirname, '..');
const LOG = process.env.LOG_FILE || path.join(os.tmpdir(), 'test-integracion.log');
let proc = null;
let tienePendientes = false;

function leerCookie(res) {
  const sc = res.headers.get('set-cookie') || '';
  return sc.split(';')[0].trim() || null;
}

async function api(method, ruta, { sesion, json, query } = {}) {
  const url = new URL(BASE + ruta);
  if (query) for (const k of Object.keys(query)) url.searchParams.set(k, String(query[k]));
  const headers = {};
  if (sesion) headers.Cookie = sesion;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const cuerpo = await res.json().catch(() => null);
  return { status: res.status, cuerpo, cookie: leerCookie(res) };
}

const get = (sesion, ruta, query) => api('GET', ruta, { sesion, query });
const post = (sesion, ruta, json) => api('POST', ruta, { sesion, json });
const put = (sesion, ruta, json) => api('PUT', ruta, { sesion, json });

// Texto crudo (para las exportaciones CSV, que no son JSON).
async function getTexto(sesion, ruta) {
  const res = await fetch(BASE + ruta, { headers: sesion ? { Cookie: sesion } : {} });
  return { status: res.status, texto: await res.text() };
}

// Filas de un CSV exportado (sin encabezado).
function filasCsv(csv) {
  return csv.split('\n').slice(1).map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
}

async function login(usuario, password) {
  const r = await api('POST', '/api/auth/login', { json: { usuario, password } });
  assert.equal(r.status, 200, 'login debería ser 200');
  assert.equal(r.cuerpo.ok, true);
  return r.cookie;
}

async function oku(r, msg) {
  assert.equal(r.status, 200, msg + ` (estado ${r.status})`);
  return r.cuerpo;
}

before(async () => {
  // 1) Crear la base dedicada si no existe.
  const admin = new Client({ connectionString: URL_ADMIN });
  await admin.connect();
  try {
    const existe = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_TEST]);
    if (!existe.rows.length) await admin.query(`CREATE DATABASE ${DB_TEST}`);
  } finally {
    await admin.end();
  }

  // 2) Levantar el server contra esa base, con datos de demo y DATA_DIR temporal.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pan-test-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PUERTO),
      DATABASE_URL: URL_TEST,
      INITIAL_ADMIN_USER: 'admin',
      INITIAL_ADMIN_PASSWORD: 'admin123',
      SEED_IF_EMPTY: '1',
      DATA_DIR: tmp,
      LICENCIA_CACHE_MS: '0',
    },
    stdio: ['ignore', fs.openSync(LOG, 'w'), fs.openSync(LOG, 'a')],
  });

  // 3) Esperar healthz.
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    if (proc.exitCode !== null) {
      throw new Error('El server de test murió al arrancar. Ver: ' + LOG);
    }
    try {
      const r = await fetch(`${BASE}/healthz`);
      ok = r.ok;
    } catch (_) { /* aún arrancando */ }
    if (!ok) await new Promise((r) => setTimeout(r, 500));
  }
  if (!ok) throw new Error('No hubo healthz. Ver: ' + LOG);
});

after(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((r) => {
      proc.once('exit', r);
      setTimeout(r, 3000);
    });
  }
  // Limpiar la base de test (fuerza cierre de conexiones sueltas del pool).
  const admin = new Client({ connectionString: URL_ADMIN });
  await admin.connect();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB_TEST]);
    await admin.query(`DROP DATABASE IF EXISTS ${DB_TEST}`);
  } finally {
    await admin.end();
  }
});

// ─────────────────────────────────────────────────────────

test('arranque: login admin (dueño) y datos de demo cargados', async () => {
  const admin = await login('admin', 'admin123');

  const prod = await get(admin, '/api/productos');
  assert.equal(prod.cuerpo.length, 10, 'el seed crea 10 productos');
  assert.ok(prod.cuerpo.every((p) => !p.codigo), 'el seed no asigna códigos automáticos');

  const cfg = await oku(await get(admin, '/api/config'), 'GET /api/config');
  assert.equal(cfg.nombre_negocio, 'Mi Panadería');

  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ventas = await oku(await get(admin, '/api/ventas', { fecha: hoy }), 'GET /api/ventas');
  assert.ok(ventas.length >= 3, `el seed deja ventas de hoy (hay ${ventas.length})`);

  const caja = await get(admin, '/api/caja', { sucursal_id: 1 });
  assert.equal(caja.cuerpo.estado, 'abierta', 'el seed deja la caja de hoy abierta');

  const lic = await oku(await get(admin, '/api/licencia'), 'GET /api/licencia');
  assert.equal(lic.modo, 'prueba');
  assert.equal(lic.dias_restantes, 60, 'la prueba arranca con 2 meses');
  assert.ok(lic.limite_reporte && lic.limite_reporte.dias === 7);
});

test('productos: el código es opcional, se puede cambiar y sigue siendo único', async () => {
  const admin = await login('admin', 'admin123');
  const creado = await post(admin, '/api/productos', {
    nombre: 'Producto sin código', unidad: 'unidad', precio_venta: 1000, stock: 5,
  });
  assert.equal(creado.status, 200, JSON.stringify(creado.cuerpo));
  assert.equal(creado.cuerpo.codigo, null);

  const actualizado = await put(admin, `/api/productos/${creado.cuerpo.id}`, {
    nombre: 'Producto sin código', unidad: 'unidad', precio_venta: 1000, stock: 5, codigo: ' pan 01 ',
  });
  assert.equal(actualizado.status, 200);
  assert.equal(actualizado.cuerpo.codigo, 'PAN01');

  const conservado = await put(admin, `/api/productos/${creado.cuerpo.id}`, {
    nombre: 'Producto sin código', unidad: 'unidad', precio_venta: 1000, stock: 5,
  });
  assert.equal(conservado.cuerpo.codigo, 'PAN01', 'omitir el campo conserva el código guardado');

  const duplicado = await post(admin, '/api/productos', {
    nombre: 'Producto con código repetido', unidad: 'unidad', precio_venta: 1000, stock: 1, codigo: 'PAN01',
  });
  assert.equal(duplicado.status, 400, 'los códigos informados deben seguir siendo únicos');

  const limpiado = await put(admin, `/api/productos/${creado.cuerpo.id}`, {
    nombre: 'Producto sin código', unidad: 'unidad', precio_venta: 1000, stock: 5, codigo: '',
  });
  assert.equal(limpiado.status, 200);
  assert.equal(limpiado.cuerpo.codigo, null, 'un código vacío se guarda como ausencia');
  assert.equal((await api('DELETE', `/api/productos/${creado.cuerpo.id}`, { sesion: admin })).status, 200);
});

test('recetas: calcula costo por rendimiento, sugiere precio y no altera stock sin confirmar', async () => {
  const admin = await login('admin', 'admin123');
  const producto = await post(admin, '/api/productos', {
    nombre: 'Pan para costeo', unidad: 'kg', precio_venta: 3000, stock: 7,
  });
  assert.equal(producto.status, 200);

  const harina = await post(admin, '/api/insumos', {
    nombre: 'Harina de prueba', unidad_base: 'kg', costo_unitario: 8000,
  });
  const agua = await post(admin, '/api/insumos', {
    nombre: 'Agua de prueba', unidad_base: 'l', costo_unitario: 1000,
  });
  assert.equal(harina.status, 200);
  assert.equal(agua.status, 200);

  const receta = await put(admin, `/api/recetas/${producto.cuerpo.id}`, {
    rendimiento: 10,
    margen: 40,
    insumos: [
      { insumo_id: harina.cuerpo.id, cantidad: 1.5, unidad: 'kg' },
      { insumo_id: agua.cuerpo.id, cantidad: 500, unidad: 'ml' },
    ],
  });
  assert.equal(receta.status, 200, JSON.stringify(receta.cuerpo));
  assert.equal(receta.cuerpo.costo_lote, 12500);
  assert.equal(receta.cuerpo.costo_unitario, 1250);
  assert.equal(receta.cuerpo.precio_sugerido, 1750);

  const productoSinCambios = await get(admin, `/api/productos/${producto.cuerpo.id}`);
  assert.equal(productoSinCambios.cuerpo.stock, 7, 'guardar la fórmula no modifica el stock');
  assert.equal(productoSinCambios.cuerpo.precio_venta, 3000, 'guardar la fórmula no cambia el precio');

  const recetaInvalida = await put(admin, `/api/recetas/${producto.cuerpo.id}`, {
    rendimiento: 10,
    margen: 40,
    insumos: [{ insumo_id: harina.cuerpo.id, cantidad: 1, unidad: 'l' }],
  });
  assert.equal(recetaInvalida.status, 400, 'rechaza unidades incompatibles');
  const recetaGuardada = await get(admin, `/api/recetas/${producto.cuerpo.id}`);
  assert.equal(recetaGuardada.cuerpo.costo_lote, 12500, 'un error conserva la receta anterior');

  const aplicado = await post(admin, `/api/recetas/${producto.cuerpo.id}/aplicar-precio`, {});
  assert.equal(aplicado.status, 200);
  const productoActualizado = await get(admin, `/api/productos/${producto.cuerpo.id}`);
  assert.equal(productoActualizado.cuerpo.precio_venta, 1750);
  assert.equal(productoActualizado.cuerpo.stock, 7, 'aplicar el precio tampoco modifica el stock');
});

test('config: el logo del negocio viaja y persiste (PUT/GET)', async () => {
  const admin = await login('admin', 'admin123');

  const antes = await oku(await get(admin, '/api/config'), 'GET /api/config');
  assert.equal(antes.logo, '', 'por defecto no hay logo');

  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
  await oku(await put(admin, '/api/config', { nombre_negocio: antes.nombre_negocio, ruc: antes.ruc, timbrado: antes.timbrado, direccion: antes.direccion, telefono: antes.telefono, ciudad: antes.ciudad, logo }), 'PUT /api/config con logo');

  const conLogo = await oku(await get(admin, '/api/config'), 'GET /api/config con logo');
  assert.equal(conLogo.logo, logo);

  await oku(await put(admin, '/api/config', { nombre_negocio: antes.nombre_negocio, ruc: antes.ruc, timbrado: antes.timbrado, direccion: antes.direccion, telefono: antes.telefono, ciudad: antes.ciudad, logo: '' }), 'PUT /api/config sin logo');
  const sinLogo = await oku(await get(admin, '/api/config'), 'GET /api/config sin logo');
  assert.equal(sinLogo.logo, '');
});

test('venta: descuenta stock, suma movimiento a caja y numera consecutivo', async () => {
  const admin = await login('admin', 'admin123');

  const antes = (await oku(await get(admin, '/api/productos'), 'productos'))[0]; // pan francés
  const stockAntes = antes.stock;

  const v1 = await post(admin, '/api/ventas', { items: [{ producto_id: antes.id, cantidad: 2 }] });
  assert.equal(v1.status, 200);
  const v2 = await post(admin, '/api/ventas', { items: [{ producto_id: antes.id, cantidad: 3 }] });
  assert.equal(v2.status, 200);
  assert.equal(v2.cuerpo.numero_comprobante, v1.cuerpo.numero_comprobante + 1, 'números consecutivos');

  const despues = (await oku(await get(admin, '/api/productos'), 'productos'))[0];
  assert.equal(despues.stock, stockAntes - 5, 'el stock bajó 5');

  const caja = await get(admin, '/api/caja', { sucursal_id: 1 });
  assert.ok(caja.cuerpo.movimientos.some((m) => m.concepto === `Venta N° ${v1.cuerpo.numero_comprobante}`));
  assert.equal(caja.status, 200);
});

test('venta: pagos combinados separan efectivo, transferencia y tarjeta', async () => {
  const admin = await login('admin', 'admin123');
  const producto = (await oku(await get(admin, '/api/productos'), 'productos'))[0];
  const precio = Number(producto.precio_venta);
  const cajaAntes = await oku(await get(admin, '/api/caja', { sucursal_id: 1 }), 'caja antes del pago combinado');

  const venta = await post(admin, '/api/ventas', {
    items: [{ producto_id: producto.id, cantidad: 3 }],
    forma_pago: 'mixto',
    pagos: { efectivo: precio, transferencia: precio, tarjeta: precio },
  });
  assert.equal(venta.status, 200, JSON.stringify(venta.cuerpo));
  assert.equal(venta.cuerpo.forma_pago, 'mixto');
  assert.equal(venta.cuerpo.pagos.length, 3);

  const cajaDespues = await oku(await get(admin, '/api/caja', { sucursal_id: 1 }), 'caja después del pago combinado');
  assert.equal(cajaDespues.total_efectivo, cajaAntes.total_efectivo + precio);
  assert.equal(cajaDespues.total_transferencia, cajaAntes.total_transferencia + precio);
  assert.equal(cajaDespues.total_tarjeta, cajaAntes.total_tarjeta + precio);

  const invalida = await post(admin, '/api/ventas', {
    items: [{ producto_id: producto.id, cantidad: 2 }],
    forma_pago: 'mixto',
    pagos: { efectivo: precio, transferencia: 0, tarjeta: 0 },
  });
  assert.equal(invalida.status, 400, 'rechaza un desglose que no suma el total');
});

test('venta: conserva el importe ingresado y calcula la cantidad desde el precio', async () => {
  const admin = await login('admin', 'admin123');
  const creado = await post(admin, '/api/productos', {
    nombre: 'Producto para probar importe exacto',
    unidad: 'kg',
    precio_venta: 13000,
    stock: 2,
  });
  assert.equal(creado.status, 200);

  const importe = 1000;
  const cantidad = Math.round((importe / 13000) * 1000) / 1000;
  const venta = await post(admin, '/api/ventas', {
    items: [{ producto_id: creado.cuerpo.id, cantidad, importe }],
  });
  assert.equal(venta.status, 200, JSON.stringify(venta.cuerpo));
  assert.equal(venta.cuerpo.total, importe);

  const detalle = await oku(await get(admin, `/api/ventas/${venta.cuerpo.venta_id}`), 'detalle de venta');
  assert.equal(Number(detalle.detalles[0].importe), importe);
  assert.ok(Math.abs(Number(detalle.detalles[0].cantidad) - cantidad) < 1e-12);

  const producto = (await oku(await get(admin, '/api/productos'), 'productos'))
    .find((p) => p.id === creado.cuerpo.id);
  assert.ok(Math.abs(Number(producto.stock) - (2 - cantidad)) < 1e-12);

  const importeInconsistente = await post(admin, '/api/ventas', {
    items: [{ producto_id: creado.cuerpo.id, cantidad, importe: importe + 100 }],
  });
  assert.equal(importeInconsistente.status, 400, 'no acepta importes que no coinciden con el peso y precio');

  const demasiadosDecimales = await post(admin, '/api/ventas', {
    items: [{ producto_id: creado.cuerpo.id, cantidad: 0.0007 }],
  });
  assert.equal(demasiadosDecimales.status, 400, 'rechaza cantidades con más de tres decimales');
});

test('con permitir_venta_sin_stock = 0: ventas concurrentes no pueden vender más unidades que el stock', async () => {
  const admin = await login('admin', 'admin123');
  await put(admin, '/api/config', { permitir_venta_sin_stock: 0 });
  const creado = await post(admin, '/api/productos', {
    nombre: 'Producto para prueba concurrente', precio_venta: 1000, stock: 5,
  });
  assert.equal(creado.status, 200);

  const ventas = await Promise.all([
    post(admin, '/api/ventas', { items: [{ producto_id: creado.cuerpo.id, cantidad: 4 }] }),
    post(admin, '/api/ventas', { items: [{ producto_id: creado.cuerpo.id, cantidad: 4 }] }),
  ]);
  assert.equal(ventas.filter((venta) => venta.status === 200).length, 1);
  assert.equal(ventas.filter((venta) => venta.status === 400).length, 1);

  const producto = (await oku(await get(admin, '/api/productos'), 'productos'))
    .find((p) => p.id === creado.cuerpo.id);
  assert.equal(producto.stock, 1, 'el stock nunca queda negativo ni se sobrevende');
});

test('con permitir_venta_sin_stock = 1: permite venta sin stock y descuenta a negativo', async () => {
  const admin = await login('admin', 'admin123');
  await put(admin, '/api/config', { permitir_venta_sin_stock: 1 });
  const creado = await post(admin, '/api/productos', {
    nombre: 'Producto sin stock habilitado', precio_venta: 1500, stock: 0,
  });
  assert.equal(creado.status, 200);

  const venta = await post(admin, '/api/ventas', {
    items: [{ producto_id: creado.cuerpo.id, cantidad: 3 }]
  });
  assert.equal(venta.status, 200);

  const producto = (await oku(await get(admin, '/api/productos'), 'productos'))
    .find((p) => p.id === creado.cuerpo.id);
  assert.equal(producto.stock, -3, 'el stock queda en -3');
});

test('caja: permite modificar monto de apertura de caja abierta y audita el cambio', async () => {
  const admin = await login('admin', 'admin123');
  const modApertura = await put(admin, '/api/caja/apertura', {
    apertura: 125000,
    motivo: 'Ajuste de prueba'
  });
  assert.equal(modApertura.status, 200);
  assert.equal(modApertura.cuerpo.apertura_nueva, 125000);

  const caja = await get(admin, '/api/caja', { sucursal_id: 1 });
  assert.equal(caja.cuerpo.apertura, 125000);

  const auditoria = await get(admin, '/api/auditoria');
  assert.ok(auditoria.cuerpo.filas.some((a) => a.accion === 'modificar_apertura_caja' && a.motivo === 'Ajuste de prueba'));
});

test('factura legal sin cliente -> 400', async () => {
  const admin = await login('admin', 'admin123');
  const r = await post(admin, '/api/ventas', { tipo: 'factura', items: [{ producto_id: 1, cantidad: 1 }] });
  assert.equal(r.status, 400);
});

test('anulación: restaura stock y saca la venta del reporte', async () => {
  const admin = await login('admin', 'admin123');
  const antes = (await oku(await get(admin, '/api/productos'), 'productos'))[1]; // pan hamburguesa
  const stockAntes = antes.stock;
  const cajaAntes = await oku(await get(admin, '/api/caja', { sucursal_id: 1 }), 'caja antes de anular');

  const v = await post(admin, '/api/ventas', { items: [{ producto_id: antes.id, cantidad: 4 }] });
  assert.equal(v.status, 200);
  const cajaConVenta = await oku(await get(admin, '/api/caja', { sucursal_id: 1 }), 'caja con venta');

  const anul = await post(admin, `/api/ventas/${v.cuerpo.venta_id}/anular`);
  assert.equal(anul.status, 200);
  const cajaAnulada = await oku(await get(admin, '/api/caja', { sucursal_id: 1 }), 'caja después de anular');
  assert.equal(cajaAnulada.total_efectivo, cajaConVenta.total_efectivo, 'conserva el ingreso y registra su devolución como egreso');
  assert.equal(cajaAnulada.total_egresos, cajaAntes.total_egresos + v.cuerpo.total);
  assert.equal(
    cajaAnulada.apertura + cajaAnulada.total_efectivo - cajaAnulada.total_egresos,
    cajaAntes.apertura + cajaAntes.total_efectivo - cajaAntes.total_egresos,
    'la anulación no altera el efectivo esperado neto'
  );

  const despues = (await oku(await get(admin, '/api/productos'), 'productos'))[1];
  assert.equal(despues.stock, stockAntes, 'anular restaura el stock');

  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const detalle = await oku(await get(admin, `/api/ventas/${v.cuerpo.venta_id}`), 'venta');
  assert.equal(detalle.anulada, 1);

  const reporte = await oku(await get(admin, '/api/reporte/dia', { fecha: hoy, sucursal_id: 1 }), 'reporte');
  assert.ok(!reporte.productos_vendidos.some((p) => p.nombre === antes.nombre && p.cantidad === 4),
    'el reporte no cuenta la venta anulada');
});

test('auditoría: registra anulación con motivo y cambio de precio', async () => {
  const admin = await login('admin', 'admin123');
  const prods = await oku(await get(admin, '/api/productos'), 'productos');
  const prod = prods[0];

  // 1. Cambio de precio
  const nuevoPrecio = prod.precio_venta + 1500;
  await oku(await put(admin, `/api/productos/${prod.id}`, { ...prod, precio_venta: nuevoPrecio }), 'cambio precio');

  // 2. Venta y anulación con motivo
  const v = await post(admin, '/api/ventas', { items: [{ producto_id: prod.id, cantidad: 1 }] });
  assert.equal(v.status, 200);
  const motivo = 'Cobro erróneo registrado';
  const anul = await post(admin, `/api/ventas/${v.cuerpo.venta_id}/anular`, { motivo });
  assert.equal(anul.status, 200);

  // 3. Consultar auditoría
  const audit = await oku(await get(admin, '/api/auditoria', { accion: 'anular_venta' }), 'auditoria anulación');
  assert.ok(audit.registros.length >= 1, 'hay registros de anulación');
  const entrada = audit.registros.find((r) => r.entidad_id === v.cuerpo.venta_id);
  assert.ok(entrada, 'la venta anulada figura en la auditoría');
  assert.equal(entrada.motivo, motivo);
  assert.equal(entrada.usuario_nombre, 'admin');

  const auditPrecio = await oku(await get(admin, '/api/auditoria', { accion: 'cambio_precio' }), 'auditoria precio');
  assert.ok(auditPrecio.registros.some((r) => r.entidad_id === prod.id && r.detalles.precio_nuevo === nuevoPrecio),
    'el cambio de precio figura en auditoría');
});

test('control de ventas: filtra fechas y devuelve resumen paginado', async () => {
  const admin = await login('admin', 'admin123');
  const producto = (await oku(await get(admin, '/api/productos'), 'productos'))[0];
  const venta = await post(admin, '/api/ventas', {
    items: [{ producto_id: producto.id, cantidad: 1 }],
    forma_pago: 'transferencia',
  });
  assert.equal(venta.status, 200);

  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const consulta = await oku(await get(admin, '/api/ventas/consulta', {
    desde: hoy, hasta: hoy, tipo: 'ticket', estado: 'vigentes',
    forma_pago: 'transferencia', pagina: 1, limite: 10,
  }), 'consulta de ventas');
  assert.ok(consulta.ventas.some((v) => v.id === venta.cuerpo.venta_id));
  assert.ok(consulta.total >= 1);
  assert.equal(consulta.pagina, 1);
  assert.equal(consulta.limite, 10);
  assert.ok(Number(consulta.total_vigente) >= venta.cuerpo.total);

  const rangoInvalido = await get(admin, '/api/ventas/consulta', { desde: hoy, hasta: '2026-99-99' });
  assert.equal(rangoInvalido.status, 400);
  const limiteInvalido = await get(admin, '/api/ventas/consulta', { desde: hoy, hasta: hoy, limite: 101 });
  assert.equal(limiteInvalido.status, 400);
});

test('multisucursal: el dueño crea sucursal y usuario staff; el staff no administra', async () => {
  const admin = await login('admin', 'admin123');
  const creada = await post(admin, '/api/sucursales', { nombre: 'Norte', direccion: 'Calle 4' });
  assert.equal(creada.status, 200, JSON.stringify(creada.cuerpo));
  const suc2 = creada.cuerpo.id;

  const u = await post(admin, '/api/usuarios', { usuario: 'pepe', password: 'pepe123', sucursal_id: suc2 });
  assert.equal(u.status, 200, JSON.stringify(u.cuerpo));
  assert.notEqual(u.cuerpo.id, null);

  const pepe = await login('pepe', 'pepe123');

  // Staff no puede administrar sucursales ni usuarios ni ver auditoría.
  assert.equal((await get(pepe, '/api/sucursales')).status, 403);
  assert.equal((await get(pepe, '/api/usuarios')).status, 403);
  assert.equal((await get(pepe, '/api/config/fiscal')).status, 403);
  assert.equal((await get(pepe, '/api/auditoria')).status, 403);
  assert.equal((await post(pepe, '/api/sucursales', { nombre: 'X' })).status, 403);
});

test('staff vende solo en su sucursal (numeración propia) y no ve la otra', async () => {
  const admin = await login('admin', 'admin123');
  const pepe = await login('pepe', 'pepe123');

  // Stock global: anotamos el de pan de hamburguesa.
  const prods = await oku(await get(admin, '/api/productos'), 'productos');
  const prodPan = prods.find((p) => p.nombre === 'Pan de hamburguesa');
  const stockGlobal = prodPan.stock;
  const config = await oku(await get(admin, '/api/config'), 'config');
  await oku(await put(admin, '/api/config', {
    ...config, actividad_economica: 'Elaboración y venta de productos de panadería',
  }), 'configurar actividad económica');
  await oku(await put(admin, '/api/config/fiscal', {
    sucursal_id: 2, timbrado: '12345678', timbrado_vigencia: '2099-12-31',
    establecimiento: '002', punto_expedicion: '001', numero_desde: 1, numero_hasta: 9999999,
  }), 'configurar timbrado de sucursal');
  await oku(await put(admin, '/api/config/fiscal/iva', {
    productos: [{ id: prodPan.id, iva_tasa: 10 }],
  }), 'configurar IVA del producto');

  // Pepe abre su caja y vende una factura con cliente (cliente 1 del seed).
  const abrir = await post(pepe, '/api/caja/abrir', { apertura: 500000 });
  assert.equal(abrir.status, 200, JSON.stringify(abrir.cuerpo));

  const v = await post(pepe, '/api/ventas', { tipo: 'factura', cliente_id: 1, items: [{ producto_id: prodPan.id, cantidad: 4 }] });
  assert.equal(v.status, 200, JSON.stringify(v.cuerpo));
  assert.equal(v.cuerpo.numero_comprobante, 1, 'numeración independiente por sucursal');
  const factura = await oku(await get(admin, `/api/ventas/${v.cuerpo.venta_id}`), 'factura');
  assert.equal(factura.fiscal_establecimiento, '002');
  assert.equal(factura.fiscal_punto_expedicion, '001');
  assert.equal(factura.detalles[0].iva_tasa, 10);
  assert.ok(Number(factura.detalles[0].iva_monto) > 0, 'guarda el IVA incluido para reimpresión');
  const consultaStaff = await oku(await get(pepe, '/api/ventas/consulta', {
    desde: new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10),
    hasta: new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10),
    sucursal_id: 1,
  }), 'consulta de ventas staff');
  assert.ok(consultaStaff.ventas.length >= 1);
  assert.ok(consultaStaff.ventas.every((venta) => venta.sucursal_id === 2), 'la consulta no filtra ventas de otra sucursal');

  // Stock global compartido: bajó para el dueño también.
  const prods2 = await oku(await get(admin, '/api/productos'), 'productos');
  assert.equal(prods2.find((p) => p.id === prodPan.id).stock, stockGlobal - 4);

  // Reporte de la sucursal 2 refleja la venta.
  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const rep2 = await oku(await get(admin, '/api/reporte/dia', { fecha: hoy, sucursal_id: 2 }), 'reporte suc 2');
  assert.equal(rep2.cantidad_ventas, 1);
  assert.equal(rep2.total_ventas, prodPan.precio_venta * 4);

  // Pepe no puede ver ni anular ventas de la sucursal 1.
  const ventasSuc1 = await oku(await get(admin, '/api/ventas', { fecha: hoy, sucursal_id: 1 }), 'ventas suc 1');
  const idSuc1 = ventasSuc1.find((x) => !x.anulada).id;
  assert.equal((await get(pepe, `/api/ventas/${idSuc1}`)).status, 403);
  assert.equal((await post(pepe, `/api/ventas/${idSuc1}/anular`)).status, 403);

  // El reporte del dueño consolida ambas sucursales.
  const repTodo = await oku(await get(admin, '/api/reporte/dia', { fecha: hoy }), 'reporte consolidado');
  assert.ok(repTodo.cantidad_ventas >= 2, 'consolida sucursal 1 y 2');
});

test('reportes de la semana y listado de cajas responden', async () => {
  const admin = await login('admin', 'admin123');

  const semana = await oku(await get(admin, '/api/reporte/semana', { sucursal_id: 1 }), 'reporte/semana');
  assert.equal(semana.serie.length, 7, 'serie de 7 días');
  assert.ok(Array.isArray(semana.top));

  // Historial: el de hoy también pasa por el mismo endpoint que el frontend usa.
  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const hist = await oku(await get(admin, '/api/reporte/dia', { fecha: hoy, sucursal_id: 1 }), 'reporte día histórico');
  assert.equal(hist.limitado, undefined);

  const cajas = await oku(await get(admin, '/api/cajas'), 'listado de cajas');
  assert.ok(cajas.length >= 5, 'el seed deja una semana de cajas');
  assert.ok(cajas.every((c) => typeof c.sucursal_nombre === 'string'), 'trae sucursal_nombre');
  assert.ok(Number.isFinite(Number(cajas[0].ingresos)));
});

test('reporte histórico: resume el rango y desglosa productos por día y total', async () => {
  const admin = await login('admin', 'admin123');
  const fecha = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const creado = await post(admin, '/api/productos', {
    nombre: 'Producto para reporte histórico',
    unidad: 'kg',
    precio_venta: 13000,
    stock: 1,
  });
  assert.equal(creado.status, 200);

  const venta = await post(admin, '/api/ventas', {
    items: [{ producto_id: creado.cuerpo.id, cantidad: 0.077, importe: 1001 }],
  });
  assert.equal(venta.status, 200, JSON.stringify(venta.cuerpo));

  const reporte = await oku(await get(admin, '/api/reporte/rango', {
    desde: fecha, hasta: fecha, sucursal_id: 1,
  }), 'reporte histórico');
  assert.equal(reporte.desde, fecha);
  assert.equal(reporte.hasta, fecha);
  assert.ok(reporte.total_ventas >= 1001);
  assert.ok(reporte.cantidad_ventas >= 1);
  assert.ok(reporte.ventas_por_dia.some((dia) => dia.fecha === fecha && dia.comprobantes >= 1));
  assert.ok(reporte.pagos_total.some((pago) => pago.forma_pago === 'efectivo' && pago.total >= 1001));
  assert.equal(reporte.productos_total.find((p) => p.producto_id === creado.cuerpo.id).total, 1001);
  assert.equal(reporte.productos_por_dia.find((p) => p.producto_id === creado.cuerpo.id).cantidad, 0.077);
  assert.equal(reporte.productos_por_dia.find((p) => p.producto_id === creado.cuerpo.id).total, 1001);
  assert.ok(Array.isArray(reporte.produccion_por_dia));
  assert.ok(Array.isArray(reporte.gastos_por_dia));
  assert.ok(Array.isArray(reporte.cajas_por_dia));

  const rangoInvalido = await get(admin, '/api/reporte/rango', { desde: fecha, hasta: '2020-02-31' });
  assert.equal(rangoInvalido.status, 400);
});

test('gastos: se registran contra la caja y aparecen en el historial', async () => {
  const admin = await login('admin', 'admin123');
  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  const r = await post(admin, '/api/gastos', { concepto: 'Compra de harina', monto: 150000, categoria: 'Insumos varios' });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));

  const gastos = await oku(await get(admin, '/api/gastos', { fecha: hoy, sucursal_id: 1 }), 'gastos');
  assert.ok(gastos.some((g) => g.concepto === 'Compra de harina' && Number(g.monto) === 150000));

  const caja = await oku(await get(admin, '/api/caja', { sucursal_id: 1 }), 'caja');
  assert.ok(caja.movimientos.some((m) => m.tipo === 'egreso' && m.monto === 150000));
});

test('caja: cierre calcula esperado y diferencia', async () => {
  const admin = await login('admin', 'admin123');
  const caja = await oku(await get(admin, '/api/caja', { sucursal_id: 1 }), 'caja');
  const esperado = caja.apertura + caja.total_ingresos - caja.total_egresos;

  const cierre = await post(admin, '/api/caja/cerrar', { cierre_real: esperado + 4000 });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.cuerpo));
  assert.equal(cierre.cuerpo.esperado, esperado);
  assert.equal(cierre.cuerpo.diferencia, 4000);

  // Con la caja cerrada, una venta nueva debe rechazarse.
  const r = await post(admin, '/api/ventas', { items: [{ producto_id: 1, cantidad: 1 }] });
  assert.equal(r.status, 400);
});

test('cambio de contraseña propio', async () => {
  const admin = await login('admin', 'admin123');
  const u = await post(admin, '/api/usuarios', { usuario: 'tclave', password: 'clave123' });
  assert.equal(u.status, 200, JSON.stringify(u.cuerpo));

  const tclave = await login('tclave', 'clave123');
  assert.equal((await post(tclave, '/api/auth/password', { actual: 'malacontrasena', nueva: 'nueva123' })).status, 400);
  assert.equal((await post(tclave, '/api/auth/password', { actual: 'clave123', nueva: 'nueva123' })).status, 200);

  const r1 = await api('POST', '/api/auth/login', { json: { usuario: 'tclave', password: 'nueva123' } });
  assert.equal(r1.status, 200);
  const r2 = await api('POST', '/api/auth/login', { json: { usuario: 'tclave', password: 'clave123' } });
  assert.equal(r2.status, 401);
});

test('restablecer demo: vuelve a los datos base y conserva sucursales y usuarios', async () => {
  const admin = await login('admin', 'admin123');
  const r = await post(admin, '/api/demo/restablecer');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));

  const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ventas = await oku(await get(admin, '/api/ventas', { fecha: hoy }), 'ventas tras reset');
  assert.ok(ventas.length >= 3, 'el seed vuelve a dejar ventas');

  const suc = await oku(await get(admin, '/api/sucursales'), 'sucursales tras reset');
  assert.equal(suc.length, 2, 'se conserva la sucursal Norte');
  assert.ok(suc.some((s) => s.nombre === 'Norte'));

  // El usuario staff sigue existiendo y funcionando.
  const pepe = await login('pepe', 'pepe123');
  assert.ok(pepe);
});

test('el staff no puede restablecer la demo (ni borra los datos del negocio)', async () => {
  const admin = await login('admin', 'admin123');
  const pepe = await login('pepe', 'pepe123');

  const antes = await oku(await get(admin, '/api/ventas'), 'ventas antes del intento');
  const productosAntes = await oku(await get(admin, '/api/productos'), 'productos antes');

  // Restablecer la demo borra TODAS las sucursales: un usuario de sucursal
  // no puede hacerlo.
  const r = await post(pepe, '/api/demo/restablecer');
  assert.equal(r.status, 403, 'el staff recibe 403');

  // Los datos siguen intactos.
  const despues = await oku(await get(admin, '/api/ventas'), 'ventas después del intento');
  assert.equal(despues.length, antes.length, 'no se borraron las ventas');
  const productosDespues = await oku(await get(admin, '/api/productos'), 'productos después');
  assert.equal(productosDespues.length, productosAntes.length, 'no se borraron los productos');

  // El dueño sí puede restablecer la demo.
  const delDueño = await post(admin, '/api/demo/restablecer');
  assert.equal(delDueño.status, 200, JSON.stringify(delDueño.cuerpo));
});

test('reportes de prueba limitados hacia atrás', async () => {
  const admin = await login('admin', 'admin123');
  const r = await oku(await get(admin, '/api/reporte/dia', { fecha: '2020-01-01' }), 'reporte viejo');
  assert.equal(r.limitado, true);
});

test('la exportación respeta la sucursal del usuario', async () => {
  const admin = await login('admin', 'admin123');
  const pepe = await login('pepe', 'pepe123');

  // La exportación es de la versión completa: la activamos con el código real.
  const cli = new Client({ connectionString: URL_TEST });
  await cli.connect();
  let codigo;
  try {
    const fila = await cli.query(`SELECT codigo_comprado FROM licencia WHERE id = 1`);
    codigo = fila.rows[0].codigo_comprado;
  } finally {
    await cli.end();
  }
  const activar = await post(admin, '/api/licencia', { accion: 'activar', codigo });
  assert.equal(activar.status, 200, JSON.stringify(activar.cuerpo));

  // Pepe vende en su sucursal (Norte).
  const prods = await oku(await get(admin, '/api/productos'), 'productos');
  const prod = prods.find((p) => p.stock > 0);
  const abrir = await post(pepe, '/api/caja/abrir', { apertura: 100000 });
  assert.ok(abrir.status === 200 || abrir.status === 400, JSON.stringify(abrir.cuerpo));
  const venta = await post(pepe, '/api/ventas', { items: [{ producto_id: prod.id, cantidad: 1 }] });
  assert.equal(venta.status, 200, JSON.stringify(venta.cuerpo));

  // El staff exporta solo su sucursal.
  const csvStaff = await getTexto(pepe, '/api/exportar/ventas');
  assert.equal(csvStaff.status, 200, csvStaff.texto.slice(0, 120));
  const filasStaff = filasCsv(csvStaff.texto);
  assert.ok(filasStaff.length >= 1, 'el staff exporta al menos su venta');
  assert.ok(filasStaff.every((f) => f.trim().endsWith('Norte')), 'todas las filas son de su sucursal');
  assert.ok(!filasStaff.some((f) => f.trim().endsWith('Principal')), 'no se filtran ventas de otra sucursal');

  // El dueño exporta el consolidado (o filtra por sucursal si quiere).
  const csvAdmin = await getTexto(admin, '/api/exportar/ventas');
  assert.equal(csvAdmin.status, 200);
  const filasAdmin = filasCsv(csvAdmin.texto);
  assert.ok(filasAdmin.length > filasStaff.length, 'el dueño ve todas las sucursales');
  assert.ok(filasAdmin.some((f) => f.trim().endsWith('Principal')));

  const csvAdminSuc = await getTexto(admin, '/api/exportar/ventas?sucursal_id=2');
  assert.equal(csvAdminSuc.status, 200);
  const filasAdminSuc = filasCsv(csvAdminSuc.texto);
  assert.equal(filasAdminSuc.length, filasStaff.length, 'filtrando por sucursal coincide con el export del staff');
  assert.ok(filasAdminSuc.every((f) => f.trim().endsWith('Norte')));

  // El staff no puede pedir el export de otra sucursal por query.
  const csvStaffTruco = await getTexto(pepe, '/api/exportar/ventas?sucursal_id=1');
  assert.equal(csvStaffTruco.status, 200);
  const filasStaffTruco = filasCsv(csvStaffTruco.texto);
  assert.ok(filasStaffTruco.every((f) => f.trim().endsWith('Norte')), 'el query no le abre la otra sucursal');
  assert.ok(!filasStaffTruco.some((f) => f.trim().endsWith('Principal')));

  // Las cajas también se exportan filtradas por sucursal.
  const cajasStaff = await getTexto(pepe, '/api/exportar/cajas');
  assert.equal(cajasStaff.status, 200);
  const filasCajas = filasCsv(cajasStaff.texto);
  assert.ok(filasCajas.every((f) => f.split(';')[1] === 'Norte'), 'solo las cajas de su sucursal');
});

test('caja: una caja de un día anterior sin cerrar se lista y se puede cerrar', async () => {
  const admin = await login('admin', 'admin123');

  // Simulamos el caso real: un día se abrió la caja y nadie la cerró.
  const cli = new Client({ connectionString: URL_TEST });
  await cli.connect();
  let cajaId;
  try {
    const r = await cli.query(
      `INSERT INTO cajas (fecha, sucursal_id, apertura, estado) VALUES ('2020-01-01', 1, 100000, 'abierta') RETURNING id`);
    cajaId = Number(r.rows[0].id); // el Client del test no parsea BIGINT como el server
    await cli.query(
      `INSERT INTO movimientos_caja (caja_id, tipo, concepto, monto, fecha) VALUES ($1, 'ingreso', 'Venta vieja', 50000, '2020-01-01')`,
      [cajaId]);
  } finally {
    await cli.end();
  }

  // Aparece como pendiente, con su esperado calculado.
  const pendientes = await oku(await get(admin, '/api/caja/pendientes'), 'cajas pendientes');
  const propia = pendientes.find((c) => c.id === cajaId);
  assert.ok(propia, 'la caja sin cerrar aparece en pendientes');
  assert.equal(propia.fecha, '2020-01-01');
  assert.equal(Number(propia.ingresos), 50000);

  // Se cierra con el dinero contado de ese día y deja de estar pendiente.
  const cierre = await post(admin, '/api/caja/cerrar', {
    caja_id: cajaId,
    denominaciones: { 100000: 1, 50000: 1 },
  });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.cuerpo));
  assert.equal(cierre.cuerpo.esperado, 150000);
  assert.equal(cierre.cuerpo.diferencia, 0);
  const cajaCerrada = await oku(await get(admin, `/api/cajas/${cajaId}`), 'caja cerrada con arqueo');
  assert.equal(cajaCerrada.cierre_real, 150000);
  assert.deepEqual(cajaCerrada.cierre_denominaciones, { '100000': 1, '50000': 1 });

  const despues = await oku(await get(admin, '/api/caja/pendientes'), 'cajas pendientes después');
  assert.ok(!despues.some((c) => c.id === cajaId), 'ya no figura como pendiente');

  // La caja de hoy sigue intacta y abierta.
  const hoyCaja = await oku(await get(admin, '/api/caja'), 'caja de hoy');
  assert.equal(hoyCaja.estado, 'abierta');
});

test('la licencia vencida deja el sistema en solo-lectura', async () => {
  // Forzamos vencimiento directo en la base y comprobamos el candado de escritura.
  const admin = await login('admin', 'admin123');
  assert.equal((await post(admin, '/api/ventas', { items: [{ producto_id: 1, cantidad: 1 }] })).status, 200, 'pre-condición: se puede vender');

  const cli = new Client({ connectionString: URL_TEST });
  await cli.connect();
  try {
    await cli.query(`UPDATE licencia SET modo='prueba', fin='2000-01-01' WHERE id = 1`);
    await cli.query(`DELETE FROM sesiones`); // forzar token vigente de nuevo login
  } finally {
    await cli.end();
  }

  const admin2 = await login('admin', 'admin123');
  const venta = await post(admin2, '/api/ventas', { items: [{ producto_id: 1, cantidad: 1 }] });
  assert.equal(venta.status, 403);
  assert.equal(venta.cuerpo.codigo, 'PRUEBA_VENCIDA');
  // Lectura sigue disponible.
  assert.equal((await get(admin2, '/api/productos')).status, 200);
});

test('bloqueo tras 5 intentos de login fallidos', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/auth/login', { json: { usuario: 'admin', password: 'incorrecta' } });
    assert.equal(r.status, 401);
  }
  const r6 = await api('POST', '/api/auth/login', { json: { usuario: 'admin', password: 'admin123' } });
  assert.equal(r6.status, 429);
});

test('gastos y proveedores: flujo completo de gastos varios y pago a proveedores', async () => {
  const admin = await login('admin', 'admin123');

  // 1. Crear proveedor
  const provRes = await post(admin, '/api/proveedores', {
    nombre: 'Molinos del Sur',
    rubro: 'Harinas',
    telefono: '0981-555666',
    ruc: '80045678-9',
    contacto: 'Juan Pérez'
  });
  assert.equal(provRes.status, 200);
  assert.equal(provRes.cuerpo.nombre, 'Molinos del Sur');
  const provId = provRes.cuerpo.id;

  // 2. Registrar gasto vario en efectivo (afecta caja) con motivo opcional
  const gVario = await post(admin, '/api/gastos', {
    tipo: 'varios',
    concepto: 'Artículos de limpieza',
    categoria: 'Limpieza',
    motivo: 'Compra de lavandina y bolsas',
    monto: 25000,
    forma_pago: 'efectivo'
  });
  assert.equal(gVario.status, 200);

  // 3. Registrar pago a proveedor por transferencia (NO afecta efectivo de caja)
  const gProv = await post(admin, '/api/gastos', {
    tipo: 'proveedor',
    proveedor_id: provId,
    concepto: '10 bolsas de harina 000',
    comprobante: 'F-001-002-0045',
    monto: 850000,
    forma_pago: 'transferencia'
  });
  assert.equal(gProv.status, 200);

  // 4. Listar gastos y verificar campos
  const listaVarios = await get(admin, '/api/gastos', { tipo: 'varios' });
  assert.equal(listaVarios.status, 200);
  assert.ok(listaVarios.cuerpo.some((g) => g.id === gVario.cuerpo.id && g.motivo === 'Compra de lavandina y bolsas'));

  const listaProv = await get(admin, '/api/gastos', { tipo: 'proveedor' });
  assert.equal(listaProv.status, 200);
  assert.ok(listaProv.cuerpo.some((g) => g.id === gProv.cuerpo.id && g.proveedor_nombre === 'Molinos del Sur'));

  // 5. Verificar que el de efectivo restó de caja pero el de transferencia no
  const caja = await get(admin, '/api/caja', { sucursal_id: 1 });
  assert.ok(caja.cuerpo.movimientos.some((m) => m.monto === 25000 && m.tipo === 'egreso'));
  assert.ok(!caja.cuerpo.movimientos.some((m) => m.monto === 850000));
});