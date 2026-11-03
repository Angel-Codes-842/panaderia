const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const db = require('./db/schema');
const negocio = require('./services/negocio');
const auth = require('./services/auth');
const licencia = require('./services/licencia');
const { hoy, fechaOffset, num, entero, str, esFormaPago, fechaValida, bErr } = require('./lib/ayudas');

const app = express();

// ── Cabeceras de seguridad (lo primero: aplican a todas las respuestas) ──
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-DNS-Prefetch-Control', 'off');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com data:; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  next();
});

// Envuelve handlers async: errores no capturados van al middleware de errores.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Multisucursal ──
// Un usuario sin sucursal asignada es el "dueño": ve todas las sucursales,
// administra usuarios/sucursales y elige dónde registra.
function esDueño(sesion) {
  return !sesion || !sesion.sucursal_id;
}
// Resuelve la sucursal en la que se registra una operación:
// el usuario asignado manda; el dueño elige (body/query), con respaldo 1.
function sucursalOperativa(req, def = 1) {
  if (req.sesion.sucursal_id) return req.sesion.sucursal_id;
  return entero(req.body.sucursal_id || req.query.sucursal_id, 1, null) || def;
}

// ── SQL del camino caliente (reutilizado dentro y fuera de transacciones) ──
const SQL = {
  cajaAbiertaFechaSucursal: `SELECT * FROM cajas WHERE fecha = $1 AND sucursal_id = $2 AND estado = 'abierta'`,
  ultimoComprobanteSucursal: `SELECT numero_comprobante FROM ventas WHERE tipo = $1 AND sucursal_id = $2 ORDER BY numero_comprobante DESC LIMIT 1`,
  insertVenta: `INSERT INTO ventas (
                  numero_comprobante, tipo, fecha, sucursal_id, forma_pago, cliente_id, total, costo, descuento, pagado, estado_pago,
                  fiscal_timbrado, fiscal_vigencia, fiscal_establecimiento, fiscal_punto_expedicion,
                  emisor_nombre, emisor_ruc, emisor_actividad, emisor_direccion, emisor_telefono, emisor_ciudad,
                  cliente_nombre_snapshot, cliente_documento_snapshot, cliente_tipo_documento_snapshot
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
  insertDetalle: `INSERT INTO venta_detalles
                  (venta_id, producto_id, cantidad, precio, costo, nombre_producto, iva_tasa, iva_base, iva_monto, descuento)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  insertMovimiento: `INSERT INTO movimientos_caja (caja_id, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)`,
};
// Versión sobre el pool (lecturas sin transacción).
const q = {
  productoPorId: (id) => db.get(`SELECT * FROM productos WHERE id = $1 AND activo = 1`, [id]),
  ventaNoAnulada: (id) => db.get(`SELECT * FROM ventas WHERE id = $1 AND anulada = 0`, [id]),
  cajaAbiertaFechaSucursal: (fecha, suc) => db.get(SQL.cajaAbiertaFechaSucursal, [fecha, suc]),
};

// ================= AUTENTICACIÓN =================

const MAX_INTENTOS = 5;
const BLOQUEO_MINUTOS = 2;
const intentos = new Map();

function claveIntento(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return (ip === '::1' ? '127.0.0.1' : ip) || 'desconocido';
}
function estaBloqueado(req) {
  const clave = claveIntento(req);
  const r = intentos.get(clave);
  if (!r || r.n < MAX_INTENTOS) return false;
  if (Date.now() >= r.hasta) { intentos.delete(clave); return false; }
  return true;
}
function falloLogin(req) {
  const clave = claveIntento(req);
  const ahora = Date.now();
  let r = intentos.get(clave);
  if (!r || ahora >= r.hasta) r = { n: 0, hasta: ahora + BLOQUEO_MINUTOS * 60 * 1000 };
  r.n += 1;
  intentos.set(clave, r);
}
function aciertoLogin(req) {
  intentos.delete(claveIntento(req));
}
// Solo confiar en proxies inversos si se pide expresamente (p. ej. Nginx/Reverse
// proxy delante). Por defecto se usa la IP directa del socket.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
// Poda periódica de bloqueos vencidos y sesiones caducadas (evita que las
// tablas que crecen en memoria queden con entradas viejas).
setInterval(() => {
  const ahora = Date.now();
  for (const [k, r] of intentos) if (ahora >= r.hasta) intentos.delete(k);
  auth.limpiarSesionesVencidas().catch((e) => console.error('No se pudieron limpiar sesiones vencidas:', e));
}, 60 * 1000).unref();

app.post('/api/auth/login', h(async (req, res) => {
  if (estaBloqueado(req)) {
    return res.status(429).json({ error: `Demasiados intentos. Esperá ${BLOQUEO_MINUTOS} minutos.` });
  }
  const usuario = await auth.verificarCredenciales(req.body.usuario, req.body.password);
  if (!usuario) {
    falloLogin(req);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  aciertoLogin(req);
  const token = await auth.crearSesion(usuario.id);
  res.set('Set-Cookie', auth.cookieSesion(token));
  const sucursal = usuario.sucursal_id
    ? await db.get(`SELECT id, nombre FROM sucursales WHERE id = $1`, [usuario.sucursal_id])
    : null;
  res.json({ ok: true, usuario: usuario.usuario, sucursal_id: usuario.sucursal_id, sucursal_nombre: sucursal ? sucursal.nombre : null });
}));

app.get('/api/auth/session', h(async (req, res) => {
  const sesion = await auth.sesionDeToken(auth.leerCookies(req.headers.cookie)[auth.COOKIE]);
  if (!sesion) return res.status(401).json({ error: 'Sin sesión' });
  const sucursal = sesion.sucursal_id
    ? await db.get(`SELECT id, nombre FROM sucursales WHERE id = $1`, [sesion.sucursal_id])
    : null;
  res.json({ ok: true, usuario: sesion.usuario, sucursal_id: sesion.sucursal_id, sucursal_nombre: sucursal ? sesion.sucursal_nombre || sucursal.nombre : null });
}));

app.post('/api/auth/logout', h(async (req, res) => {
  await auth.cerrarSesion(auth.leerCookies(req.headers.cookie)[auth.COOKIE]);
  res.set('Set-Cookie', auth.cookieVacia());
  res.json({ ok: true });
}));

app.post('/api/auth/password', h(async (req, res) => {
  const sesion = await auth.sesionDeToken(auth.leerCookies(req.headers.cookie)[auth.COOKIE]);
  if (!sesion) return res.status(401).json({ error: 'Sin sesión' });
  const actual = str(req.body.actual, 200);
  const nueva = str(req.body.nueva, 200);
  if (nueva.length < 6) return res.status(400).json({ error: 'La nueva contraseña necesita al menos 6 caracteres' });
  if (nueva === actual) return res.status(400).json({ error: 'La nueva contraseña es igual a la actual' });
  const ok = await auth.verificarCredenciales(sesion.usuario, actual);
  if (!ok) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  await auth.cambiarPassword(sesion.id, nueva);
  const token = await auth.crearSesion(sesion.id);
  res.set('Set-Cookie', auth.cookieSesion(token));
  res.json({ ok: true });
}));

// A partir de acá, todo requiere sesión iniciada
app.use('/api', h(async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const sesion = await auth.sesionDeToken(auth.leerCookies(req.headers.cookie)[auth.COOKIE]);
  if (!sesion) return res.status(401).json({ error: 'Sesión no iniciada' });
  req.sesion = sesion;
  return next();
}));

// ================= LICENCIA (versión de prueba) =================
// El trial es declarado: días visibles, límites visibles. Al vencer el
// sistema queda en solo-lectura (se ve todo, no se pueden cargar ventas).
// La versión comprada se activa con un código, para que la decisión y el
// cobro queden del lado de quien instala el sistema.

app.get('/api/licencia', h(async (_req, res) => {
  const l = await licencia.obtener();
  res.json({
    modo: l.modo,
    inicio: l.inicio,
    fin: l.fin,
    dias_restantes: licencia.diasRestantes(l),
    expirada: licencia.expirada(l),
    limite_reporte: await licencia.limiteReporte(),
  });
}));

app.post('/api/licencia', h(async (req, res) => {
  if (!esDueño(req.sesion)) return res.status(403).json({ error: 'Solo el dueño puede administrar la licencia' });
  const resultado = req.body.accion === 'reiniciar'
    ? await licencia.reiniciar(str(req.body.codigo, 64))
    : await licencia.activar(str(req.body.codigo, 64));
  if (!resultado.ok) return res.status(400).json({ error: resultado.error });
  res.json({ ok: true });
}));

// Prueba vencida: el sistema queda en solo-lectura (todo sigue visible).
app.use('/api', h(async (req, res, next) => {
  if (req.method !== 'GET' && licencia.expirada(await licencia.obtener())) {
    return res.status(403).json({
      error: 'La versión de prueba venció. El sistema queda en solo-lectura: podés ver los datos, pero para seguir cargando ventas necesitás la versión completa.',
      codigo: 'PRUEBA_VENCIDA',
    });
  }
  return next();
}));

// ================= SUCURSALES Y USUARIOS (solo el dueño) =================

function requireDueño(req, res, next) {
  if (!esDueño(req.sesion)) {
    return res.status(403).json({ error: 'Solo el dueño puede administrar sucursales y usuarios' });
  }
  next();
}
// Igual que requireDueño, pero con el mensaje propio de la operación.
function soloDueño(mensaje) {
  return (req, res, next) => {
    if (!esDueño(req.sesion)) {
      return res.status(403).json({ error: mensaje });
    }
    next();
  };
}

app.get('/api/sucursales', requireDueño, h(async (_req, res) => {
  res.json(await db.all(`
    SELECT s.id, s.nombre, s.direccion, s.activa,
           (SELECT COUNT(*)::int FROM ventas v WHERE v.sucursal_id = s.id AND v.anulada = 0) AS ventas
    FROM sucursales s ORDER BY s.id
  `));
}));

app.post('/api/sucursales', requireDueño, h(async (req, res) => {
  const nombre = str(req.body.nombre, 100);
  if (!nombre) return res.status(400).json({ error: 'Ingresá el nombre de la sucursal' });
  const info = await db.get(`INSERT INTO sucursales (nombre, direccion) VALUES ($1,$2) RETURNING id`,
    [nombre, str(req.body.direccion, 150)]);
  res.json({ id: info.id });
}));

app.put('/api/sucursales/:id', requireDueño, h(async (req, res) => {
  const id = entero(req.params.id, 1, 0);
  const existe = await db.get(`SELECT id FROM sucursales WHERE id = $1`, [id]);
  if (!existe) return res.status(404).json({ error: 'No existe' });
  if (req.body.activa === 0) {
    const fila = await db.get(`SELECT COUNT(*)::int AS c FROM sucursales WHERE activa = 1`);
    if (fila.c <= 1) return res.status(400).json({ error: 'No podés desactivar la única sucursal activa' });
  }
  await db.run(`UPDATE sucursales SET nombre = $1, direccion = $2, activa = $3 WHERE id = $4`,
    [str(req.body.nombre, 100), str(req.body.direccion, 150), req.body.activa === 0 ? 0 : 1, id]);
  res.json({ ok: true });
}));

app.get('/api/usuarios', requireDueño, h(async (_req, res) => {
  res.json(await db.all(`
    SELECT u.id, u.usuario, u.sucursal_id,
           COALESCE(s.nombre, 'Todas las sucursales') AS sucursal_nombre, u.activo, u.creado_en
    FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
    ORDER BY u.id
  `));
}));

app.post('/api/usuarios', requireDueño, h(async (req, res) => {
  const usuario = str(req.body.usuario, 50);
  const password = str(req.body.password, 200);
  if (!usuario) return res.status(400).json({ error: 'Ingresá un nombre de usuario' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña necesita al menos 6 caracteres' });
  if (await auth.usuarioExiste(usuario)) return res.status(400).json({ error: 'Ese usuario ya existe' });
  const sucursalId = entero(req.body.sucursal_id, 1, null);
  if (sucursalId) {
    const s = await db.get(`SELECT id FROM sucursales WHERE id = $1 AND activa = 1`, [sucursalId]);
    if (!s) return res.status(400).json({ error: 'Sucursal no válida' });
  }
  const id = await auth.crearUsuario(usuario, password, sucursalId);
  res.json({ id });
}));

app.put('/api/usuarios/:id', requireDueño, h(async (req, res) => {
  const id = entero(req.params.id, 1, 0);
  const usuario = await db.get(`SELECT * FROM usuarios WHERE id = $1`, [id]);
  if (!usuario) return res.status(404).json({ error: 'No existe' });
  if (id === req.sesion.id && req.body.activo === 0) {
    return res.status(400).json({ error: 'No podés desactivar tu propio usuario' });
  }
  if (id === req.sesion.id && req.body.sucursal_id !== undefined && (req.body.sucursal_id === null || req.body.sucursal_id === '')) {
    return res.status(400).json({ error: 'No podés quitarte la vista de todas las sucursales (perderías el acceso de dueño)' });
  }
  if (req.body.sucursal_id !== undefined) {
    const elegida = (req.body.sucursal_id === null || req.body.sucursal_id === '')
      ? null : entero(req.body.sucursal_id, 1, null);
    if (elegida) {
      const s = await db.get(`SELECT id FROM sucursales WHERE id = $1 AND activa = 1`, [elegida]);
      if (!s) return res.status(400).json({ error: 'Sucursal no válida' });
    }
    await db.run(`UPDATE usuarios SET sucursal_id = $1 WHERE id = $2`, [elegida, id]);
  }
  if (req.body.activo !== undefined) {
    await db.run(`UPDATE usuarios SET activo = $1 WHERE id = $2`, [req.body.activo === 0 ? 0 : 1, id]);
  }
  if (typeof req.body.password === 'string' && req.body.password !== '') {
    const password = str(req.body.password, 200);
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña necesita al menos 6 caracteres' });
    await auth.cambiarPassword(id, password);
  }
  res.json({ ok: true });
}));

// ================= GASTOS =================

const CATEGORIAS_GASTO = ['Sueldos', 'Servicios', 'Insumos varios', 'Mantenimiento', 'Otros'];

app.get('/api/gastos', h(async (req, res) => {
  const fecha = fechaValida(req.query.fecha);
  const suc = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  const where = [];
  const params = [];
  if (fecha) { where.push('g.fecha = $' + (params.length + 1)); params.push(fecha); }
  if (suc) { where.push('g.sucursal_id = $' + (params.length + 1)); params.push(suc); }
  const sql = `SELECT g.*, COALESCE(s.nombre,'') AS sucursal_nombre FROM gastos g
               LEFT JOIN sucursales s ON s.id = g.sucursal_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY g.fecha DESC, g.id DESC`;
  res.json(await db.all(sql, params));
}));

app.post('/api/gastos', h(async (req, res) => {
  const concepto = str(req.body.concepto, 150);
  const monto = num(req.body.monto, 0.01, 1e12, null);
  if (!concepto) return res.status(400).json({ error: 'Ingresá un concepto' });
  if (monto === null) return res.status(400).json({ error: 'Ingresá un monto válido' });
  const categoria = CATEGORIAS_GASTO.includes(req.body.categoria) ? req.body.categoria : 'Otros';
  const fecha = str(req.body.fecha, 10) || hoy();
  const sucursalId = sucursalOperativa(req);
  const resultado = await db.transakt(async (t) => {
    const caja = await t.get(SQL.cajaAbiertaFechaSucursal, [fecha, sucursalId]);
    const cajaId = caja ? caja.id : null;
    const info = await t.get(
      `INSERT INTO gastos (concepto, monto, categoria, fecha, sucursal_id, caja_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [concepto, monto, categoria, fecha, sucursalId, cajaId]);
    if (caja) {
      await t.run(SQL.insertMovimiento, [caja.id, 'egreso', `Gasto: ${concepto}`, monto, fecha]);
    }
    return { id: info.id };
  });
  res.json(resultado);
}));

app.delete('/api/gastos/:id', h(async (req, res) => {
  const gasto = await db.get(`SELECT * FROM gastos WHERE id = $1`, [entero(req.params.id, 1, 0)]);
  if (!gasto) return res.status(404).json({ error: 'No existe' });
  if (req.sesion.sucursal_id && gasto.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés eliminar gastos de otra sucursal' });
  }
  await db.transakt(async (t) => {
    await t.run(`DELETE FROM gastos WHERE id = $1`, [gasto.id]);
    if (gasto.caja_id) {
      // Revertir el egreso de caja asociado (solo el que corresponde a este gasto)
      await t.run(`DELETE FROM movimientos_caja WHERE id = (
        SELECT id FROM movimientos_caja WHERE caja_id = $1 AND concepto = $2 AND monto = $3 AND tipo = 'egreso' LIMIT 1)`,
        [gasto.caja_id, `Gasto: ${gasto.concepto}`, gasto.monto]);
      const caja = await t.get(`SELECT * FROM cajas WHERE id = $1`, [gasto.caja_id]);
      if (caja && caja.estado === 'cerrada') {
        const movs = await t.all(`SELECT * FROM movimientos_caja WHERE caja_id = $1`, [caja.id]);
        const ingresos = movs.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
        const egresos = movs.filter((m) => m.tipo === 'egreso').reduce((a, m) => a + m.monto, 0);
        const esperado = caja.apertura + ingresos - egresos;
        await t.run(`UPDATE cajas SET cierre_esperado = $1, diferencia = $2 WHERE id = $3`,
          [esperado, caja.cierre_real - esperado, caja.id]);
      }
    }
  });
  res.json({ ok: true });
}));

app.get('/api/gastos/categorias', (_req, res) => res.json(CATEGORIAS_GASTO));

// ================= REPORTES =================

app.get('/api/reporte/dia', h(async (req, res) => {
  const fecha = fechaValida(req.query.fecha) || hoy();
  const suc = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  // Versión de prueba: los reportes solo llegan hacia atrás los días anunciados.
  const limite = await licencia.limiteReporte();
  if (limite && fecha < limite.desde) {
    return res.json({
      limitado: true,
      fecha,
      mensaje: `En la versión de prueba los reportes llegan a los últimos ${licencia.DIAS_REPORTE_PRUEBA} días. Para ver fechas anteriores necesitás la versión completa.`,
      desde: limite.desde,
    });
  }
  const condVenta = suc ? `AND sucursal_id = $2` : '';
  const condDetalle = suc ? `AND v.sucursal_id = $2` : '';
  const condLote = suc ? `AND l.sucursal_id = $2` : '';
  const params = suc ? [fecha, suc] : [fecha];
  const [ventas, porForma, lotes, productosVendidos, cajas] = await Promise.all([
    suc
      ? db.all(`SELECT * FROM ventas WHERE fecha = $1 AND anulada = 0 AND sucursal_id = $2`, params)
      : db.all(`SELECT * FROM ventas WHERE fecha = $1 AND anulada = 0`, [fecha]),
    db.all(`
      SELECT forma_pago, COUNT(*)::int AS cantidad, SUM(total) AS total
      FROM ventas WHERE fecha = $1 AND anulada = 0 ${condVenta} GROUP BY forma_pago
    `, params),
    db.all(`
      SELECT l.id, l.producto_id, l.unidades_producidas AS cantidad, l.fecha,
             p.nombre AS producto_nombre, p.unidad AS producto_unidad
      FROM lotes l JOIN productos p ON p.id = l.producto_id
      WHERE l.fecha = $1 ${condLote} ORDER BY l.id
    `, params),
    db.all(`
      SELECT p.nombre, p.unidad, p.categoria, SUM(vd.cantidad) AS cantidad, SUM(vd.cantidad * vd.precio) AS total
      FROM venta_detalles vd JOIN productos p ON p.id = vd.producto_id
      JOIN ventas v ON v.id = vd.venta_id
      WHERE v.fecha = $1 AND v.anulada = 0 ${condDetalle}
      GROUP BY p.id ORDER BY total DESC
    `, params),
    suc
      ? db.all(`SELECT * FROM cajas WHERE fecha = $1 AND sucursal_id = $2`, params)
      : db.all(`SELECT * FROM cajas WHERE fecha = $1`, [fecha]),
  ]);
  const totalVentas = ventas.reduce((a, v) => a + v.total, 0);
  const caja = cajas.length === 1 ? cajas[0] : (cajas.length > 1 ? {
    id: null, fecha, apertura: cajas.reduce((a, c) => a + (c.apertura || 0), 0),
    cierre_esperado: cajas.some((c) => c.cierre_esperado === null) ? null : cajas.reduce((a, c) => a + (c.cierre_esperado || 0), 0),
    cierre_real: cajas.some((c) => c.cierre_real === null) ? null : cajas.reduce((a, c) => a + (c.cierre_real || 0), 0),
    diferencia: cajas.some((c) => c.diferencia === null) ? null : cajas.reduce((a, c) => a + (c.diferencia || 0), 0),
    estado: cajas.some((c) => c.estado === 'abierta') ? 'abierta' : 'cerrada',
    consolidada: true,
  } : null);
  res.json({ fecha, total_ventas: totalVentas, cantidad_ventas: ventas.length, por_forma: porForma, lotes, productos_vendidos: productosVendidos, caja });
}));

app.get('/api/reporte/semana', h(async (req, res) => {
  const serie = [];
  const fechas = [];
  for (let off = 6; off >= 0; off--) fechas.push(fechaOffset(-off));
  const desde = fechas[0], hasta = fechas[6];
  const suc = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  const condVenta = suc ? `AND v.sucursal_id = $3` : '';
  const condLote = suc ? `AND sucursal_id = $3` : '';
  const condCaja = suc ? `AND sucursal_id = $3` : '';
  const params = suc ? [desde, hasta, suc] : [desde, hasta];
  const topParams = suc ? [suc] : [];
  const topCond = suc ? `AND v.sucursal_id = $1` : '';
  const [ventasPorDia, lotesPorDia, cajasPorDia, top] = await Promise.all([
    db.all(`
      SELECT v.fecha, COALESCE(SUM(v.total),0) AS t, COUNT(*) AS c
      FROM ventas v WHERE v.fecha BETWEEN $1 AND $2 AND v.anulada = 0 ${condVenta} GROUP BY v.fecha
    `, params),
    db.all(`
      SELECT fecha, COALESCE(SUM(unidades_producidas),0) AS t, COUNT(*) AS c
      FROM lotes WHERE fecha BETWEEN $1 AND $2 ${condLote} GROUP BY fecha
    `, params),
    db.all(`
      SELECT fecha, apertura, cierre_esperado, estado
      FROM cajas WHERE fecha BETWEEN $1 AND $2 ${condCaja}
    `, params),
    db.all(`
      SELECT p.nombre, p.unidad, SUM(vd.cantidad) AS cantidad, SUM(vd.cantidad * vd.precio) AS total
      FROM venta_detalles vd JOIN productos p ON p.id = vd.producto_id
      JOIN ventas v ON v.id = vd.venta_id
      WHERE v.anulada = 0 ${topCond}
      GROUP BY p.id ORDER BY total DESC LIMIT 6
    `, topParams),
  ]);
  const vMap = Object.fromEntries(ventasPorDia.map((r) => [r.fecha, r]));
  const lMap = Object.fromEntries(lotesPorDia.map((r) => [r.fecha, r]));
  const cMap = {};
  for (const c of cajasPorDia) {
    if (!cMap[c.fecha]) cMap[c.fecha] = c;
    else cMap[c.fecha] = { fecha: c.fecha, apertura: cMap[c.fecha].apertura + (c.apertura || 0), cierre_esperado: (cMap[c.fecha].cierre_esperado === null || c.cierre_esperado === null) ? null : cMap[c.fecha].cierre_esperado + (c.cierre_esperado || 0), estado: (c.estado === 'abierta' || cMap[c.fecha].estado === 'abierta') ? 'abierta' : 'cerrada' };
  }
  for (const fecha of fechas) {
    const v = vMap[fecha];
    const l = lMap[fecha];
    serie.push({
      fecha,
      ventas: v ? Number(v.t) : 0,
      comprobantes: v ? Number(v.c) : 0,
      produccion: l ? Number(l.t) : 0,
      producciones: l ? Number(l.c) : 0,
      caja: cMap[fecha] || null,
    });
  }
  res.json({ serie, top });
}));

// ================= PRODUCTOS =================

// Código de barras opcional: se normaliza solo cuando el negocio lo informa.
function normalizarCodigo(v) {
  return str(v, 32).toUpperCase().replace(/\s+/g, '');
}
function responderCodigoDuplicado(e, res) {
  if (e && e.code === '23505') {
    res.status(400).json({ error: 'Ya existe un producto con ese código' });
    return true;
  }
  return false;
}

app.get('/api/productos', h(async (_req, res) => {
  res.json(await db.all(`SELECT * FROM productos WHERE activo = 1 ORDER BY categoria, nombre`));
}));

app.post('/api/productos', h(async (req, res) => {
  const nombre = str(req.body.nombre, 100);
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
  const unidad = ['unidad', 'docena', 'kg'].includes(req.body.unidad) ? req.body.unidad : 'unidad';
  const precio = num(req.body.precio_venta, 0, 1e12, 0);
  const stock = num(req.body.stock, 0, 1e9, 0);
  const codigo = normalizarCodigo(req.body.codigo);
  try {
    const info = await db.get(
      `INSERT INTO productos (nombre, categoria, unidad, precio_venta, stock, codigo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [nombre, str(req.body.categoria, 50) || 'Otros', unidad, precio, stock, codigo]);
    res.json({ id: info.id, codigo: codigo || null });
  } catch (e) {
    if (responderCodigoDuplicado(e, res)) return;
    throw e;
  }
}));

app.get('/api/productos/:id', h(async (req, res) => {
  const p = await db.get(`SELECT * FROM productos WHERE id = $1`, [entero(req.params.id, 1, 0)]);
  if (!p) return res.status(404).json({ error: 'No existe' });
  res.json(p);
}));

app.put('/api/productos/:id', h(async (req, res) => {
  const nombre = str(req.body.nombre, 100);
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
  const unidad = ['unidad', 'docena', 'kg'].includes(req.body.unidad) ? req.body.unidad : 'unidad';
  const precio = num(req.body.precio_venta, 0, 1e12, 0);
  const stock = num(req.body.stock, 0, 1e9, null);
  const id = entero(req.params.id, 1, 0);
  const actual = await db.get(`SELECT codigo FROM productos WHERE id = $1`, [id]);
  if (!actual) return res.status(404).json({ error: 'No existe' });
  const codigo = req.body.codigo === undefined ? actual.codigo : normalizarCodigo(req.body.codigo);
  try {
    if (stock === null) {
      await db.run(`UPDATE productos SET nombre=$1, categoria=$2, unidad=$3, precio_venta=$4, codigo=$5 WHERE id=$6`,
        [nombre, str(req.body.categoria, 50) || 'Otros', unidad, precio, codigo, id]);
    } else {
      await db.run(`UPDATE productos SET nombre=$1, categoria=$2, unidad=$3, precio_venta=$4, stock=$5, codigo=$6 WHERE id=$7`,
        [nombre, str(req.body.categoria, 50) || 'Otros', unidad, precio, stock, codigo, id]);
    }
    res.json({ ok: true, codigo: codigo || null });
  } catch (e) {
    if (responderCodigoDuplicado(e, res)) return;
    throw e;
  }
}));

app.delete('/api/productos/:id', h(async (req, res) => {
  await db.run(`UPDATE productos SET activo = 0 WHERE id = $1`, [entero(req.params.id, 1, 0)]);
  res.json({ ok: true });
}));

// ================= PRODUCCIÓN =================

app.get('/api/lotes', h(async (req, res) => {
  const suc = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  const cond = suc ? `WHERE l.sucursal_id = $1` : '';
  const params = suc ? [suc] : [];
  res.json(await db.all(`
    SELECT l.id, l.producto_id, l.unidades_producidas AS cantidad, l.fecha, l.sucursal_id,
           COALESCE(s.nombre, '') AS sucursal_nombre,
           p.nombre AS producto_nombre, p.unidad AS producto_unidad
    FROM lotes l JOIN productos p ON p.id = l.producto_id
    LEFT JOIN sucursales s ON s.id = l.sucursal_id
    ${cond}
    ORDER BY l.id DESC
  `, params));
}));

app.post('/api/produccion', h(async (req, res) => {
  const productoId = entero(req.body.producto_id, 1, null);
  if (productoId === null) return res.status(400).json({ error: 'Producto inválido' });
  const cantidad = num(req.body.cantidad, 0.001, 1e9, null);
  if (cantidad === null) return res.status(400).json({ error: 'Ingresá una cantidad válida' });
  try {
    res.json(await negocio.producir(productoId, cantidad, hoy(), sucursalOperativa(req)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ================= CONFIGURACIÓN =================

app.get('/api/config', h(async (_req, res) => {
  res.json(await db.get(`SELECT * FROM configuracion WHERE id = 1`) || {});
}));

app.put('/api/config', requireDueño, h(async (req, res) => {
  const campos = {
    nombre_negocio: str(req.body.nombre_negocio, 100),
    ruc: str(req.body.ruc, 30),
    actividad_economica: str(req.body.actividad_economica, 150),
    timbrado: '',
    direccion: str(req.body.direccion, 150),
    telefono: str(req.body.telefono, 30),
    ciudad: str(req.body.ciudad, 60),
    logo: typeof req.body.logo === 'string' ? req.body.logo.slice(0, 500000) : ''
  };
  await db.run(`UPDATE configuracion SET nombre_negocio=$1, ruc=$2, actividad_economica=$3, direccion=$4, telefono=$5, ciudad=$6, logo=$7 WHERE id=1`,
    [campos.nombre_negocio, campos.ruc, campos.actividad_economica, campos.direccion, campos.telefono, campos.ciudad, campos.logo]);
  res.json({ ok: true });
}));

app.get('/api/config/fiscal', requireDueño, h(async (req, res) => {
  const sucursalId = entero(req.query.sucursal_id, 1, 1);
  const sucursal = await db.get(`SELECT id, nombre FROM sucursales WHERE id = $1`, [sucursalId]);
  if (!sucursal) return res.status(400).json({ error: 'Sucursal no válida' });
  const fiscal = await db.get(`SELECT * FROM configuracion_fiscal WHERE sucursal_id = $1`, [sucursalId]);
  const productos = await db.all(`SELECT id, nombre, categoria, iva_tasa FROM productos WHERE activo = 1 ORDER BY categoria, nombre`);
  res.json({ sucursal, fiscal: fiscal || null, productos });
}));

app.put('/api/config/fiscal', requireDueño, h(async (req, res) => {
  const sucursalId = entero(req.body.sucursal_id, 1, null);
  const timbrado = str(req.body.timbrado, 8);
  const vigencia = fechaValida(req.body.timbrado_vigencia);
  const establecimiento = str(req.body.establecimiento, 3);
  const punto = str(req.body.punto_expedicion, 3);
  const desde = entero(req.body.numero_desde, 1, null);
  const hasta = entero(req.body.numero_hasta, 1, null);
  if (!sucursalId || !await db.get(`SELECT id FROM sucursales WHERE id = $1`, [sucursalId])) {
    return res.status(400).json({ error: 'Sucursal no válida' });
  }
  if (!/^\d{8}$/.test(timbrado)) return res.status(400).json({ error: 'El timbrado debe tener 8 dígitos' });
  if (!vigencia) return res.status(400).json({ error: 'Ingresá la fecha de vigencia del timbrado' });
  if (!/^\d{3}$/.test(establecimiento) || !/^\d{3}$/.test(punto)) {
    return res.status(400).json({ error: 'El establecimiento y el punto de expedición deben tener 3 dígitos' });
  }
  if (desde === null || hasta === null || desde > 9999999 || hasta > 9999999 || desde > hasta) {
    return res.status(400).json({ error: 'Ingresá un rango de numeración válido (hasta 7 dígitos)' });
  }
  const ultimo = await db.get(`SELECT MAX(numero_comprobante) AS numero FROM ventas WHERE tipo = 'factura' AND sucursal_id = $1`, [sucursalId]);
  if (ultimo && Number(ultimo.numero || 0) >= desde && Number(ultimo.numero || 0) > hasta) {
    return res.status(400).json({ error: 'El rango final no puede ser menor que una factura ya numerada' });
  }
  await db.run(`INSERT INTO configuracion_fiscal
      (sucursal_id, timbrado, timbrado_vigencia, establecimiento, punto_expedicion, numero_desde, numero_hasta)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (sucursal_id) DO UPDATE SET timbrado=EXCLUDED.timbrado,
      timbrado_vigencia=EXCLUDED.timbrado_vigencia, establecimiento=EXCLUDED.establecimiento,
      punto_expedicion=EXCLUDED.punto_expedicion, numero_desde=EXCLUDED.numero_desde,
      numero_hasta=EXCLUDED.numero_hasta`,
  [sucursalId, timbrado, vigencia, establecimiento, punto, desde, hasta]);
  res.json({ ok: true });
}));

app.put('/api/config/fiscal/iva', requireDueño, h(async (req, res) => {
  if (!Array.isArray(req.body.productos)) return res.status(400).json({ error: 'La lista de IVA no es válida' });
  const vistos = new Set();
  const productos = [];
  for (const p of req.body.productos) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return res.status(400).json({ error: 'Cada producto debe tener una tasa válida: sin configurar, exenta, 5% o 10%' });
    }
    const id = entero(p.id, 1, null);
    const sinConfigurar = p.iva_tasa === null || p.iva_tasa === undefined || p.iva_tasa === '';
    const iva = sinConfigurar ? null : entero(p.iva_tasa, 0, null);
    if (!id || vistos.has(id) || (!sinConfigurar && (iva === null || ![0, 5, 10].includes(iva)))) {
      return res.status(400).json({ error: 'Cada producto debe tener una tasa válida: sin configurar, exenta, 5% o 10%' });
    }
    vistos.add(id);
    productos.push({ id, iva });
  }
  await db.transakt(async (t) => {
    for (const p of productos) {
      const { id, iva } = p;
      const r = await t.run(`UPDATE productos SET iva_tasa=$1 WHERE id=$2 AND activo=1`, [iva, id]);
      if (!r.rowCount) throw bErr('Un producto ya no está disponible. Recargá la configuración fiscal e intentá de nuevo.');
    }
  });
  res.json({ ok: true });
}));

// ================= TÉRMINOS Y CONDICIONES =================

const TERMINOS_VERSION = '1';

app.get('/api/terminos', h(async (_req, res) => {
  const c = await db.get(`SELECT terminos_aceptados, terminos_fecha FROM configuracion WHERE id = 1`);
  const aceptada = (c.terminos_aceptados || '') === TERMINOS_VERSION;
  res.json({ version: TERMINOS_VERSION, aceptada, aceptada_en: c.terminos_fecha || '' });
}));

app.post('/api/terminos/aceptar', h(async (_req, res) => {
  await db.run(`UPDATE configuracion SET terminos_aceptados = $1, terminos_fecha = $2 WHERE id = 1`,
    [TERMINOS_VERSION, hoy()]);
  res.json({ ok: true });
}));

// ================= VENTAS =================

app.post('/api/ventas', h(async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Venta vacía' });
  const tipoDoc = req.body.tipo === 'factura' ? 'factura' : 'ticket';
  if (tipoDoc === 'factura' && !entero(req.body.cliente_id, 1, null)) {
    return res.status(400).json({ error: 'La factura necesita un cliente con RUC o cédula' });
  }
  const formaPago = esFormaPago(req.body.forma_pago);
  const sucursalId = sucursalOperativa(req);
  const clienteId = entero(req.body.cliente_id, 1, null);
  if (formaPago === 'credito' && !clienteId) {
    return res.status(400).json({ error: 'Para vender a crédito tenés que elegir un cliente' });
  }

  // Numeración por sucursal bajo concurrencia: un índice único (tipo, sucursal,
  // número) evita que dos ventas simultáneas tomen el mismo número; si hay
  // choque se reintenta la transacción completa.
  let resultado = null;
  for (let intento = 0; intento < 10; intento++) {
    try {
      resultado = await db.transakt(async (t) => {
        const cajaHoy = await t.get(SQL.cajaAbiertaFechaSucursal, [hoy(), sucursalId]);
        if (!cajaHoy) throw bErr('No hay una caja abierta para hoy en esa sucursal. Abrí la caja en el módulo Caja antes de vender.');

        let perfilFiscal = null;
        let negocioFiscal = null;
        let clienteFiscal = null;
        if (tipoDoc === 'factura') {
          perfilFiscal = await t.get(`SELECT * FROM configuracion_fiscal WHERE sucursal_id = $1`, [sucursalId]);
          negocioFiscal = await t.get(`SELECT * FROM configuracion WHERE id = 1`);
          clienteFiscal = await t.get(`SELECT * FROM clientes WHERE id = $1 AND activo = 1`, [clienteId]);
          if (!perfilFiscal || !/^\d{8}$/.test(perfilFiscal.timbrado) ||
              !perfilFiscal.timbrado_vigencia || perfilFiscal.timbrado_vigencia < hoy() ||
              !/^\d{3}$/.test(perfilFiscal.establecimiento) ||
              !/^\d{3}$/.test(perfilFiscal.punto_expedicion)) {
            throw bErr('Configurá un timbrado vigente y los datos de establecimiento en Configuración antes de emitir facturas.');
          }
          if (!negocioFiscal || !negocioFiscal.nombre_negocio || !negocioFiscal.ruc || !negocioFiscal.actividad_economica) {
            throw bErr('Completá nombre, RUC y actividad económica del emisor en Configuración antes de emitir facturas.');
          }
          if (!clienteFiscal || !clienteFiscal.nombre || !clienteFiscal.documento) {
            throw bErr('La factura necesita un cliente con nombre y documento cargados.');
          }
        }

        const ultimo = await t.get(SQL.ultimoComprobanteSucursal, [tipoDoc, sucursalId]);
        const numero = tipoDoc === 'factura'
          ? Math.max(Number(ultimo ? ultimo.numero_comprobante : 0) + 1, perfilFiscal.numero_desde)
          : (ultimo ? ultimo.numero_comprobante : 0) + 1;
        if (tipoDoc === 'factura' && numero > perfilFiscal.numero_hasta) {
          throw bErr('Se agotó el rango de numeración autorizado para esta sucursal. Configurá el siguiente timbrado.');
        }
        const itemsValidados = items.map((it) => {
          const pid = entero(it.producto_id, 1, null);
          const cantidad = num(it.cantidad, 0.001, 1e9, null);
          if (pid === null || cantidad === null) throw bErr('Hay un producto o cantidad inválida en el ticket');
          return { productoId: pid, cantidad };
        });
        const idsProductos = [...new Set(itemsValidados.map((it) => it.productoId))].sort((a, b) => a - b);
        const productos = await t.all(
          `SELECT * FROM productos
           WHERE id = ANY($1::bigint[]) AND activo = 1
           ORDER BY id
           FOR UPDATE`,
          [idsProductos]
        );
        const productosPorId = new Map(productos.map((p) => [p.id, p]));
        const cantidadesPorProducto = new Map();
        let subtotal = 0;
        const detalles = [];

        for (const it of itemsValidados) {
          const p = productosPorId.get(it.productoId);
          if (!p) throw bErr(`Producto no existe (${it.productoId})`);
          if (tipoDoc === 'factura' && (p.iva_tasa === null || ![0, 5, 10].includes(Number(p.iva_tasa)))) {
            throw bErr(`Configurá el IVA de ${p.nombre} en Configuración antes de emitir la factura.`);
          }
          const precio = p.precio_venta;
          const cantidadAcumulada = (cantidadesPorProducto.get(p.id) || 0) + it.cantidad;
          if (p.stock < cantidadAcumulada) {
            throw bErr(`Stock insuficiente de ${p.nombre}: hay ${p.stock}, pide ${cantidadAcumulada}`);
          }
          cantidadesPorProducto.set(p.id, cantidadAcumulada);
          const importe = precio * it.cantidad;
          subtotal += importe;
          detalles.push({ producto: p, cantidad: it.cantidad, precio, importe });
        }
        for (const [productoId, cantidad] of cantidadesPorProducto) {
          await t.run(`UPDATE productos SET stock = stock - $1 WHERE id = $2`, [cantidad, productoId]);
        }

        const descuento = num(req.body.descuento, 0, 1e12, 0);
        if (descuento > subtotal) throw bErr('El descuento no puede ser mayor al subtotal');
        const total = Math.max(0, subtotal - descuento);

        // A crédito se cobra solo el abono inicial (puede ser 0) y el resto
        // queda como deuda del cliente. En las demás formas se cobra todo.
        let pagado = total;
        if (formaPago === 'credito') {
          pagado = req.body.abono === undefined || req.body.abono === '' || req.body.abono === null
            ? 0
            : num(req.body.abono, 0, total, null);
          if (pagado === null) throw bErr('El abono no puede ser mayor al total');
        }
        const estadoPago = pagado >= total ? 'pagada' : 'pendiente';

        const ins = await t.get(SQL.insertVenta,
          [
            numero, tipoDoc, hoy(), sucursalId, formaPago, clienteId, total, 0, descuento, pagado, estadoPago,
            perfilFiscal ? perfilFiscal.timbrado : '', perfilFiscal ? perfilFiscal.timbrado_vigencia : '',
            perfilFiscal ? perfilFiscal.establecimiento : '', perfilFiscal ? perfilFiscal.punto_expedicion : '',
            perfilFiscal ? negocioFiscal.nombre_negocio : '', perfilFiscal ? negocioFiscal.ruc : '',
            perfilFiscal ? negocioFiscal.actividad_economica : '', perfilFiscal ? negocioFiscal.direccion : '',
            perfilFiscal ? negocioFiscal.telefono : '', perfilFiscal ? negocioFiscal.ciudad : '',
            perfilFiscal ? clienteFiscal.nombre : '', perfilFiscal ? clienteFiscal.documento : '',
            perfilFiscal ? clienteFiscal.tipo_documento : '',
          ]);
        let descuentoRestante = descuento;
        for (let i = 0; i < detalles.length; i++) {
          const d = detalles[i];
          const descuentoLinea = i === detalles.length - 1
            ? descuentoRestante
            : (subtotal > 0 ? descuento * d.importe / subtotal : 0);
          descuentoRestante -= descuentoLinea;
          const importeNeto = d.importe - descuentoLinea;
          const tasa = perfilFiscal ? Number(d.producto.iva_tasa) : null;
          const baseIva = tasa === null || tasa === 0 ? importeNeto : importeNeto / (1 + tasa / 100);
          const montoIva = tasa === null ? 0 : importeNeto - baseIva;
          await t.run(SQL.insertDetalle, [
            ins.id, d.producto.id, d.cantidad, d.precio, 0, d.producto.nombre,
            tasa, baseIva, montoIva, descuentoLinea,
          ]);
        }

        // A la caja entra el dinero cobrado, no la deuda pendiente.
        if (pagado > 0) {
          const concepto = pagado < total ? `Venta N° ${numero} (abono)` : `Venta N° ${numero}`;
          await t.run(SQL.insertMovimiento, [cajaHoy.id, 'ingreso', concepto, pagado, hoy()]);
        }
        if (formaPago === 'credito' && pagado > 0) {
          await t.run(`INSERT INTO abonos (venta_id, cliente_id, sucursal_id, caja_id, monto, fecha, creado_en)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [ins.id, clienteId, sucursalId, cajaHoy.id, pagado, hoy(), new Date().toISOString()]);
        }

        return {
          venta_id: ins.id, numero_comprobante: numero, tipo: tipoDoc,
          subtotal, descuento, total, pagado, saldo: Math.max(0, total - pagado), estado_pago: estadoPago,
        };
      });
      break;
    } catch (e) {
      if (e.code === '23505' && intento < 9) continue; // choque de comprobante: reintenta
      throw e;
    }
  }

  if (!resultado) return res.status(400).json({ error: 'No se pudo asignar el número de comprobante' });
  res.json(resultado);
}));

app.get('/api/ventas', h(async (req, res) => {
  const fecha = fechaValida(req.query.fecha) || hoy();
  const suc = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  const cond = suc ? `AND v.sucursal_id = $2` : '';
  const params = suc ? [fecha, suc] : [fecha];
  res.json(await db.all(`
    SELECT v.*, COALESCE(s.nombre,'') AS sucursal_nombre,
           (v.total - v.pagado) AS saldo,
           c.nombre AS cliente_nombre, c.documento AS cliente_documento FROM ventas v
    LEFT JOIN sucursales s ON s.id = v.sucursal_id
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE v.fecha = $1 ${cond} ORDER BY v.numero_comprobante DESC
  `, params));
}));

app.get('/api/ventas/consulta', h(async (req, res) => {
  const fechaConsultaValida = (valor) => {
    const fecha = fechaValida(valor);
    if (!fecha) return null;
    const fechaUTC = new Date(`${fecha}T00:00:00Z`);
    return Number.isNaN(fechaUTC.getTime()) || fechaUTC.toISOString().slice(0, 10) !== fecha ? null : fecha;
  };
  const desde = req.query.desde ? fechaConsultaValida(req.query.desde) : hoy();
  const hasta = req.query.hasta ? fechaConsultaValida(req.query.hasta) : (desde || hoy());
  if (!desde || !hasta || desde > hasta) {
    return res.status(400).json({ error: 'Ingresá un rango de fechas válido' });
  }
  const pagina = entero(req.query.pagina, 1, 1);
  const limite = entero(req.query.limite, 1, 50);
  if (limite > 100) return res.status(400).json({ error: 'El límite máximo por página es 100 ventas' });

  const condiciones = ['v.fecha BETWEEN $1 AND $2'];
  const params = [desde, hasta];
  const agregarCondicion = (sql, valor) => {
    params.push(valor);
    condiciones.push(sql.replace('?', `$${params.length}`));
  };
  const sucursalId = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  if (sucursalId) agregarCondicion('v.sucursal_id = ?', sucursalId);
  if (['ticket', 'factura'].includes(req.query.tipo)) agregarCondicion('v.tipo = ?', req.query.tipo);
  if (req.query.estado === 'vigentes') condiciones.push('v.anulada = 0');
  else if (req.query.estado === 'anuladas') condiciones.push('v.anulada = 1');
  if (['efectivo', 'transferencia', 'tarjeta', 'credito'].includes(req.query.forma_pago)) {
    agregarCondicion('v.forma_pago = ?', req.query.forma_pago);
  }
  const busqueda = str(req.query.q, 100);
  if (busqueda) {
    params.push(`%${busqueda}%`);
    const ref = `$${params.length}`;
    condiciones.push(`(
      v.numero_comprobante::text ILIKE ${ref}
      OR COALESCE(c.nombre, '') ILIKE ${ref}
      OR COALESCE(c.documento, '') ILIKE ${ref}
    )`);
  }

  const where = condiciones.join(' AND ');
  const offset = (pagina - 1) * limite;
  const [resumen, ventas] = await Promise.all([
    db.get(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE v.anulada = 1)::int AS anuladas,
             COALESCE(SUM(v.total) FILTER (WHERE v.anulada = 0), 0) AS total_vigente
      FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE ${where}
    `, params),
    db.all(`
      SELECT v.*, COALESCE(s.nombre,'') AS sucursal_nombre,
             (v.total - v.pagado) AS saldo,
             c.nombre AS cliente_nombre, c.documento AS cliente_documento
      FROM ventas v
      LEFT JOIN sucursales s ON s.id = v.sucursal_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE ${where}
      ORDER BY v.fecha DESC, v.numero_comprobante DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limite, offset]),
  ]);
  res.json({ ventas, total: resumen.total, anuladas: resumen.anuladas, total_vigente: resumen.total_vigente, pagina, limite });
}));

app.get('/api/ventas/:id', h(async (req, res) => {
  const v = await db.get(`
    SELECT v.*, COALESCE(s.nombre,'') AS sucursal_nombre,
           (v.total - v.pagado) AS saldo,
           c.nombre AS cliente_nombre, c.documento AS cliente_documento FROM ventas v
    LEFT JOIN sucursales s ON s.id = v.sucursal_id
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE v.id = $1
  `, [entero(req.params.id, 1, 0)]);
  if (!v) return res.status(404).json({ error: 'No existe' });
  if (req.sesion.sucursal_id && v.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés ver ventas de otra sucursal' });
  }
  const detalles = await db.all(`
    SELECT vd.*, COALESCE(NULLIF(vd.nombre_producto, ''), p.nombre) AS nombre, p.unidad FROM venta_detalles vd
    JOIN productos p ON p.id = vd.producto_id WHERE vd.venta_id = $1
  `, [v.id]);
  res.json({ ...v, detalles });
}));

app.post('/api/ventas/:id/anular', h(async (req, res) => {
  const v = await q.ventaNoAnulada(entero(req.params.id, 1, 0));
  if (!v) return res.status(400).json({ error: 'Venta no existe o ya fue anulada' });
  if (req.sesion.sucursal_id && v.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés anular ventas de otra sucursal' });
  }
  await db.transakt(async (t) => {
    await t.run(`UPDATE ventas SET anulada = 1 WHERE id = $1`, [v.id]);
    const detalles = await t.all(`SELECT * FROM venta_detalles WHERE venta_id = $1`, [v.id]);
    for (const d of detalles) {
      await t.run(`UPDATE productos SET stock = stock + $1 WHERE id = $2`, [d.cantidad, d.producto_id]);
    }
    const caja = await t.get(SQL.cajaAbiertaFechaSucursal, [v.fecha, v.sucursal_id]);
    if (caja) {
      // Solo se devuelve el dinero que realmente entró a la caja; en una venta
      // a crédito el resto nunca se cobró (la deuda desaparece al anular).
      const devuelto = Number.isFinite(v.pagado) ? v.pagado : v.total;
      if (devuelto > 0) {
        await t.run(SQL.insertMovimiento, [caja.id, 'egreso', `Anulación Venta N° ${v.numero_comprobante}`, devuelto, hoy()]);
      }
    }
  });
  res.json({ ok: true });
}));

// ================= CLIENTES =================

app.get('/api/clientes', h(async (_req, res) => {
  res.json(await db.all(`
    SELECT c.*, COUNT(v.id) AS ventas, COALESCE(SUM(v.total),0) AS total_compras,
      COALESCE(SUM(CASE WHEN v.estado_pago = 'pendiente' THEN GREATEST(v.total - v.pagado, 0) ELSE 0 END),0) AS deuda
    FROM clientes c
    LEFT JOIN ventas v ON v.cliente_id = c.id AND v.anulada = 0
    WHERE c.activo = 1
    GROUP BY c.id ORDER BY c.nombre
  `));
}));

app.post('/api/clientes', h(async (req, res) => {
  const nombre = str(req.body.nombre, 100);
  const documento = str(req.body.documento, 30);
  if (!nombre && !documento) return res.status(400).json({ error: 'Ingresá nombre o documento' });
  const info = await db.get(
    `INSERT INTO clientes (nombre, tipo_documento, documento, telefono) VALUES ($1,$2,$3,$4) RETURNING id`,
    [nombre, req.body.tipo_documento === 'Cédula' ? 'Cédula' : 'RUC', documento, str(req.body.telefono, 30)]);
  res.json({ id: info.id });
}));

app.put('/api/clientes/:id', h(async (req, res) => {
  await db.run(`UPDATE clientes SET nombre = $1, tipo_documento = $2, documento = $3, telefono = $4 WHERE id = $5`,
    [str(req.body.nombre, 100), req.body.tipo_documento === 'Cédula' ? 'Cédula' : 'RUC', str(req.body.documento, 30), str(req.body.telefono, 30), entero(req.params.id, 1, 0)]);
  res.json({ ok: true });
}));

app.delete('/api/clientes/:id', h(async (req, res) => {
  await db.run(`UPDATE clientes SET activo = 0 WHERE id = $1`, [entero(req.params.id, 1, 0)]);
  res.json({ ok: true });
}));

// ================= CRÉDITOS / FIADOS =================
// Una venta a crédito es una venta con `total > pagado`. No hace falta una
// tabla de deuda aparte: el saldo se calcula desde la venta y cada pago queda
// registrado en `abonos` y en los movimientos de la caja donde entró.

app.get('/api/creditos', h(async (req, res) => {
  const suc = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  const cond = suc ? 'AND v.sucursal_id = $1' : '';
  const params = suc ? [suc] : [];
  res.json(await db.all(`
    SELECT v.id, v.numero_comprobante, v.tipo, v.fecha, v.total, v.pagado,
           (v.total - v.pagado) AS saldo, v.sucursal_id,
           c.id AS cliente_id, c.nombre AS cliente_nombre, c.documento AS cliente_documento,
           c.tipo_documento AS cliente_tipo_documento, c.telefono AS cliente_telefono,
           COALESCE(s.nombre,'') AS sucursal_nombre,
           (SELECT MAX(a.fecha) FROM abonos a WHERE a.venta_id = v.id) AS ultimo_abono
    FROM ventas v
    JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN sucursales s ON s.id = v.sucursal_id
    WHERE v.anulada = 0 AND v.total > v.pagado ${cond}
    ORDER BY v.fecha, v.numero_comprobante
  `, params));
}));

app.get('/api/creditos/venta/:id', h(async (req, res) => {
  const v = await db.get(`
    SELECT v.*, (v.total - v.pagado) AS saldo,
           c.nombre AS cliente_nombre, c.documento AS cliente_documento,
           COALESCE(s.nombre,'') AS sucursal_nombre
    FROM ventas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN sucursales s ON s.id = v.sucursal_id
    WHERE v.id = $1 AND v.anulada = 0
  `, [entero(req.params.id, 1, 0)]);
  if (!v) return res.status(404).json({ error: 'Venta no encontrada' });
  if (req.sesion.sucursal_id && v.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés ver ventas de otra sucursal' });
  }
  const abonos = await db.all(`SELECT * FROM abonos WHERE venta_id = $1 ORDER BY id`, [v.id]);
  const detalles = await db.all(`
    SELECT vd.*, p.nombre FROM venta_detalles vd
    JOIN productos p ON p.id = vd.producto_id WHERE vd.venta_id = $1
  `, [v.id]);
  res.json({ ...v, abonos, detalles });
}));

app.post('/api/creditos/abonar', h(async (req, res) => {
  const ventaId = entero(req.body.venta_id, 1, null);
  const monto = num(req.body.monto, 0.01, 1e12, null);
  if (ventaId === null) return res.status(400).json({ error: 'Venta inválida' });
  if (monto === null) return res.status(400).json({ error: 'Ingresá un monto válido' });

  const previa = await db.get(`SELECT * FROM ventas WHERE id = $1 AND anulada = 0`, [ventaId]);
  if (!previa) return res.status(404).json({ error: 'Venta no encontrada o anulada' });
  if (req.sesion.sucursal_id && previa.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés cobrar créditos de otra sucursal' });
  }

  const resultado = await db.transakt(async (t) => {
    const v = await t.get(`SELECT * FROM ventas WHERE id = $1 AND anulada = 0 FOR UPDATE`, [ventaId]);
    if (!v) throw bErr('Venta no encontrada o anulada');
    const saldo = v.total - v.pagado;
    if (saldo <= 0) throw bErr('Esta venta ya está pagada');
    if (monto > saldo + 0.009) throw bErr(`El abono no puede superar el saldo pendiente (${saldo})`);

    const caja = await t.get(SQL.cajaAbiertaFechaSucursal, [hoy(), v.sucursal_id]);
    if (!caja) throw bErr('Abrí la caja de hoy para registrar el abono');

    const pagado = v.pagado + monto;
    const estadoPago = pagado >= v.total ? 'pagada' : 'pendiente';
    await t.run(`UPDATE ventas SET pagado = $1, estado_pago = $2 WHERE id = $3`, [pagado, estadoPago, v.id]);
    await t.run(`INSERT INTO abonos (venta_id, cliente_id, sucursal_id, caja_id, monto, fecha, creado_en)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [v.id, v.cliente_id, v.sucursal_id, caja.id, monto, hoy(), new Date().toISOString()]);

    const cliente = await t.get(`SELECT nombre FROM clientes WHERE id = $1`, [v.cliente_id]);
    const nombre = cliente && cliente.nombre ? cliente.nombre : 'cliente';
    await t.run(SQL.insertMovimiento,
      [caja.id, 'ingreso', `Abono crédito ${nombre} (Venta N° ${v.numero_comprobante})`, monto, hoy()]);

    return { ok: true, pagado, saldo: Math.max(0, v.total - pagado), estado_pago: estadoPago };
  });
  res.json(resultado);
}));

// ================= CAJA =================

app.get('/api/caja', h(async (req, res) => {
  const sucursalId = sucursalOperativa(req);
  const caja = await db.get(`SELECT * FROM cajas WHERE fecha = $1 AND sucursal_id = $2`, [hoy(), sucursalId]);
  if (!caja) return res.json(null);
  const movs = await db.all(`SELECT * FROM movimientos_caja WHERE caja_id = $1 ORDER BY id`, [caja.id]);
  const ingresos = movs.filter(m => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
  const egresos = movs.filter(m => m.tipo === 'egreso').reduce((a, m) => a + m.monto, 0);
  res.json({ ...caja, movimientos: movs, total_ingresos: ingresos, total_egresos: egresos });
}));

// Cajas de días anteriores que quedaron abiertas porque nadie las cerró.
// Se listan todas (no solo la última) para poder cerrarlas desde Caja.
app.get('/api/caja/pendientes', h(async (req, res) => {
  const sucursalId = sucursalOperativa(req);
  res.json(await db.all(`
    SELECT c.id, c.fecha, c.apertura,
      COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto END), 0) AS ingresos,
      COALESCE(SUM(CASE WHEN m.tipo = 'egreso' THEN m.monto END), 0) AS egresos
    FROM cajas c LEFT JOIN movimientos_caja m ON m.caja_id = c.id
    WHERE c.sucursal_id = $1 AND c.fecha < $2 AND c.estado = 'abierta'
    GROUP BY c.id ORDER BY c.fecha
  `, [sucursalId, hoy()]));
}));

app.get('/api/cajas', h(async (req, res) => {
  const suc = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  const cond = suc ? `WHERE c.sucursal_id = $1` : '';
  const params = suc ? [suc] : [];
  res.json(await db.all(`
    SELECT c.*, COALESCE(s.nombre,'') AS sucursal_nombre,
      COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto END), 0) AS ingresos,
      COALESCE(SUM(CASE WHEN m.tipo = 'egreso' THEN m.monto END), 0) AS egresos,
      COUNT(m.id) AS cant_movs
    FROM cajas c LEFT JOIN movimientos_caja m ON m.caja_id = c.id
    LEFT JOIN sucursales s ON s.id = c.sucursal_id
    ${cond}
    GROUP BY c.id, s.nombre ORDER BY c.fecha DESC
  `, params));
}));

app.get('/api/cajas/:id', h(async (req, res) => {
  const caja = await db.get(`SELECT * FROM cajas WHERE id = $1`, [entero(req.params.id, 1, 0)]);
  if (!caja) return res.status(404).json({ error: 'No existe' });
  if (req.sesion.sucursal_id && caja.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés ver cajas de otra sucursal' });
  }
  const movs = await db.all(`SELECT * FROM movimientos_caja WHERE caja_id = $1 ORDER BY id`, [caja.id]);
  const ingresos = movs.filter(m => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
  const egresos = movs.filter(m => m.tipo === 'egreso').reduce((a, m) => a + m.monto, 0);
  res.json({ ...caja, movimientos: movs, total_ingresos: ingresos, total_egresos: egresos });
}));

app.post('/api/cajas/:id/reabrir', h(async (req, res) => {
  const caja = await db.get(`SELECT * FROM cajas WHERE id = $1`, [entero(req.params.id, 1, 0)]);
  if (!caja) return res.status(404).json({ error: 'No existe' });
  if (req.sesion.sucursal_id && caja.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés reabrir cajas de otra sucursal' });
  }
  if (caja.estado === 'abierta') return res.status(400).json({ error: 'La caja ya está abierta' });
  await db.run(`UPDATE cajas SET estado = 'abierta', cierre_esperado = NULL, cierre_real = NULL, diferencia = NULL WHERE id = $1`, [caja.id]);
  res.json({ ok: true });
}));

app.post('/api/caja/abrir', h(async (req, res) => {
  const apertura = num(req.body.apertura, 0, 1e12, 0);
  const sucursalId = sucursalOperativa(req);
  const existe = await db.get(`SELECT * FROM cajas WHERE fecha = $1 AND sucursal_id = $2`, [hoy(), sucursalId]);
  if (existe) return res.status(400).json({ error: 'La caja de hoy ya existe' });
  const previasAbiertas = await db.all(`SELECT fecha FROM cajas WHERE fecha < $1 AND sucursal_id = $2 AND estado = 'abierta' ORDER BY fecha`, [hoy(), sucursalId]);
  const info = await db.get(`INSERT INTO cajas (fecha, sucursal_id, apertura, estado) VALUES ($1,$2,$3,$4) RETURNING id`,
    [hoy(), sucursalId, apertura, 'abierta']);
  res.json({
    id: info.id,
    previa_abierta: previasAbiertas.length ? previasAbiertas[previasAbiertas.length - 1].fecha : null,
    previas_abiertas: previasAbiertas.map((c) => c.fecha),
  });
}));

app.post('/api/caja/egreso', h(async (req, res) => {
  const concepto = str(req.body.concepto, 150);
  const monto = num(req.body.monto, 0.01, 1e12, null);
  if (!concepto || monto === null) return res.status(400).json({ error: 'Ingresá concepto y monto válido' });
  const sucursalId = sucursalOperativa(req);
  const cajaId = entero(req.body.caja_id, 1, null);
  const caja = cajaId
    ? await db.get(`SELECT * FROM cajas WHERE id = $1 AND estado = 'abierta'`, [cajaId])
    : await q.cajaAbiertaFechaSucursal(hoy(), sucursalId);
  if (!caja) return res.status(400).json({ error: 'No hay caja abierta' });
  if (req.sesion.sucursal_id && caja.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés operar la caja de otra sucursal' });
  }
  await db.run(SQL.insertMovimiento, [caja.id, 'egreso', concepto, monto, hoy()]);
  res.json({ ok: true });
}));

app.post('/api/caja/cerrar', h(async (req, res) => {
  const cierreReal = num(req.body.cierre_real, 0, 1e12, null);
  if (cierreReal === null) return res.status(400).json({ error: 'Ingresá el cierre real' });
  const sucursalId = sucursalOperativa(req);
  const cajaId = entero(req.body.caja_id, 1, null);
  const caja = cajaId
    ? await db.get(`SELECT * FROM cajas WHERE id = $1 AND estado = 'abierta'`, [cajaId])
    : await q.cajaAbiertaFechaSucursal(hoy(), sucursalId);
  if (!caja) return res.status(400).json({ error: 'No hay caja abierta' });
  if (req.sesion.sucursal_id && caja.sucursal_id !== req.sesion.sucursal_id) {
    return res.status(403).json({ error: 'No podés operar la caja de otra sucursal' });
  }
  const movs = await db.all(`SELECT * FROM movimientos_caja WHERE caja_id = $1`, [caja.id]);
  const ingresos = movs.filter(m => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
  const egresos = movs.filter(m => m.tipo === 'egreso').reduce((a, m) => a + m.monto, 0);
  const esperado = caja.apertura + ingresos - egresos;
  const diferencia = cierreReal - esperado;
  await db.run(`UPDATE cajas SET cierre_esperado = $1, cierre_real = $2, diferencia = $3, estado = 'cerrada' WHERE id = $4`,
    [esperado, cierreReal, diferencia, caja.id]);
  res.json({ esperado, diferencia, apertura: caja.apertura, ingresos, egresos, cant_movs: movs.length });
}));

// ================= EXPORTACIÓN (versión completa) =================

function aCsv(filas, columnas) {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // Las columnas vienen de la consulta: el encabezado se mantiene aunque la
  // exportación no tenga filas (una sucursal sin ventas, por ejemplo).
  const cabs = columnas || Object.keys(filas[0] || {});
  return '\uFEFF' + cabs.join(';') + '\n' + filas.map((f) => cabs.map((c) => escape(f[c])).join(';')).join('\n');
}

// Cada exportador devuelve la consulta y sus parámetros. `suc` es la sucursal
// a filtrar (null = todas). Productos y clientes son catálogos compartidos
// por todo el negocio: no llevan sucursal y por eso no se filtran.
const EXPORTADORES = {
  ventas: (suc) => ({
    sql: `
    SELECT v.id, v.tipo, v.numero_comprobante, v.fecha, v.forma_pago, COALESCE(c.nombre,'') AS cliente,
           v.total, v.descuento, v.pagado, (v.total - v.pagado) AS saldo,
           COALESCE(s.nombre,'') AS sucursal
    FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN sucursales s ON s.id = v.sucursal_id
    WHERE v.anulada = 0 ${suc ? 'AND v.sucursal_id = $1' : ''} ORDER BY v.fecha, v.id`,
    params: suc ? [suc] : [],
  }),
  creditos: (suc) => ({
    sql: `
    SELECT COALESCE(c.nombre,'') AS cliente, c.documento, v.fecha, v.numero_comprobante,
           v.total, v.pagado, (v.total - v.pagado) AS saldo,
           COALESCE(s.nombre,'') AS sucursal
    FROM ventas v JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN sucursales s ON s.id = v.sucursal_id
    WHERE v.anulada = 0 AND v.total > v.pagado ${suc ? 'AND v.sucursal_id = $1' : ''}
    ORDER BY v.fecha, v.id`,
    params: suc ? [suc] : [],
  }),
  productos: () => ({
    sql: `SELECT id, nombre, categoria, unidad, precio_venta, stock FROM productos WHERE activo = 1 ORDER BY nombre`,
    params: [],
  }),
  clientes: () => ({
    sql: `SELECT id, nombre, tipo_documento, documento, telefono FROM clientes WHERE activo = 1 ORDER BY nombre`,
    params: [],
  }),
  cajas: (suc) => ({
    sql: `
    SELECT c.fecha, COALESCE(s.nombre,'') AS sucursal, c.apertura, c.cierre_esperado, c.cierre_real, c.diferencia, c.estado,
      COALESCE(SUM(CASE WHEN m.tipo='ingreso' THEN m.monto END),0) AS ingresos,
      COALESCE(SUM(CASE WHEN m.tipo='egreso' THEN m.monto END),0) AS egresos
    FROM cajas c LEFT JOIN movimientos_caja m ON m.caja_id = c.id
    LEFT JOIN sucursales s ON s.id = c.sucursal_id
    ${suc ? 'WHERE c.sucursal_id = $1' : ''}
    GROUP BY c.id, s.nombre ORDER BY c.fecha`,
    params: suc ? [suc] : [],
  }),
};

app.get('/api/exportar/:tipo', h(async (req, res) => {
  // El gancho honesto: en la versión de prueba la exportación está
  // deshabilitada y anunciada. Los datos de la prueba son de demostración,
  // así que nadie queda rehén de sus propios datos reales.
  if (!licencia.esComprado(await licencia.obtener())) {
    return res.status(403).json({
      error: 'La exportación de datos es de la versión completa. En la versión de prueba está deshabilitada.',
      codigo: 'FUNCION_COMPLETA',
    });
  }
  const tipo = req.params.tipo;
  if (!EXPORTADORES[tipo]) return res.status(404).json({ error: 'Exportación no válida' });
  // Un usuario de sucursal solo exporta lo de su sucursal (no puede pedir
  // otra por query). El dueño exporta el consolidado o filtra con
  // ?sucursal_id=.
  const sucursalId = req.sesion.sucursal_id || entero(req.query.sucursal_id, 1, null);
  const { sql, params } = EXPORTADORES[tipo](sucursalId);
  const { columnas, filas } = await db.allCols(sql, params);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${tipo}-${hoy()}.csv"`);
  res.send(aCsv(filas, columnas));
}));

// ================= DEMO =================

// Restablecer la demo borra los datos de TODAS las sucursales: solo el
// dueño puede hacerlo (un usuario de sucursal no tiene por qué tocar los
// datos del negocio entero).
app.post('/api/demo/restablecer', soloDueño('Solo el dueño puede restablecer los datos de demostración'), h(async (_req, res) => {
  try {
    await require('./db/seed')();
    res.json({ ok: true });
  } catch (e) {
    console.error('Error al restablecer demo:', e);
    res.status(500).json({ error: 'No se pudo restablecer la demo: ' + e.message });
  }
}));

// ================= ERRORES Y ARRANQUE =================

app.get('/healthz', h(async (_req, res) => {
  try {
    await db.get(`SELECT 1`);
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
}));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status === 400 && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido en la petición' });
  }
  if (status >= 500) console.error(err);
  const error = status >= 500
    ? 'Error interno del servidor'
    : err.esErrorNegocio && typeof err.message === 'string'
      ? err.message
      : 'Petición inválida';
  res.status(status).json({ error });
});

// ---------- Backup diario (pg_dump) ----------
function hacerBackup() {
  return new Promise((resolve) => {
    try {
      const backupsDir = path.join(db.DATA_DIR, 'backups');
      fs.mkdirSync(backupsDir, { recursive: true });
      const file = path.join(backupsDir, `panaderia-${hoy()}.dump`);
      const temporal = file + '.tmp';
      const limpiarTemporal = () => {
        try { fs.unlinkSync(temporal); } catch (_) {}
      };
      // No repetir si ya hay un backup válido de hoy (no vacío): un pg_dump que
      // falló deja un archivo de 0 bytes y no debe bloquear el próximo intento.
      let yaExiste = false;
      try { yaExiste = fs.statSync(file).size > 0; } catch (_) { yaExiste = false; }
      if (yaExiste) return resolve();
      try { fs.unlinkSync(file); } catch (_) {}
      limpiarTemporal();
      const url = process.env.DATABASE_URL || 'postgres://panaderia:panaderia@localhost:5432/panaderia';
      execFile('pg_dump', ['--format=custom', '--compress=0', '--no-owner', '--file=' + temporal, url],
        { timeout: 120000 },
        (e) => {
          try {
            if (e) {
              limpiarTemporal();
              console.error('No se pudo crear el backup:', e.message);
              return resolve();
            }
            if (fs.statSync(temporal).size === 0) {
              limpiarTemporal();
              console.error('No se pudo crear el backup: pg_dump generó un archivo vacío');
              return resolve();
            }
            fs.renameSync(temporal, file);
            const backups = fs.readdirSync(backupsDir)
              .filter((f) => /^panaderia-\d{4}-\d{2}-\d{2}\.dump$/.test(f))
              .sort();
            while (backups.length > 7) fs.unlinkSync(path.join(backupsDir, backups.shift()));
            console.log('Backup diario creado: ' + file);
          } catch (error) {
            limpiarTemporal();
            console.error('No se pudo finalizar el backup:', error.message);
          }
          resolve();
        });
    } catch (e) {
      console.error('No se pudo crear el backup:', e.message);
      resolve();
    }
  });
}

function ipsRedLocal() {
  const ips = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const ni of lista || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

// ---------- Arranque ----------
(async () => {
  await db.migrar();

  // Los datos de ejemplo solo se cargan cuando se habilitan explícitamente.
  const base = await db.get(`SELECT (SELECT COUNT(*)::int FROM productos) AS productos, (SELECT COUNT(*)::int FROM ventas) AS ventas`);
  if (process.env.SEED_IF_EMPTY === '1' && base.productos === 0 && base.ventas === 0) {
    console.log('Base vacía: cargando datos de demostración...');
    await require('./db/seed')();
  }

  // Nunca dejar el sistema sin acceso: si la base no tiene usuarios
  // (instalación nueva o base restaurada de una versión anterior), se crea el inicial.
  if (await auth.asegurarUsuarioInicial()) {
    console.log(`\n  Acceso creado: usuario "${auth.USUARIO_INICIAL}" / contraseña "${auth.PASSWORD_INICIAL}"`);
    console.log('  Cambiala desde Configuración → Tu contraseña.\n');
  }
  await auth.limpiarSesionesVencidas();

  // ---------- Licencia de prueba ----------
  const licenciaRegistrada = (await db.get(`SELECT COUNT(*)::int AS c FROM licencia WHERE id = 1`)).c > 0;
  const lic = await licencia.obtener();
  const rutaCodigo = path.join(db.DATA_DIR, 'codigos-de-licencia.txt');
  function escribirCodigos() {
    const contenido =
      `Panadería — códigos de licencia\n` +
      `Reiniciar prueba de ${licencia.DIAS_PRUEBA} días: ${lic.codigo_prueba}\n` +
      `Activar versión completa: ${lic.codigo_comprado}\n` +
      `No los muestres en pantalla al cliente.\n`;
    // El archivo es una copia de los códigos que manda la BD: si cambió (por
    // ejemplo, tras reinstalar) se reescribe, para no entregar códigos viejos.
    if (!fs.existsSync(rutaCodigo) || fs.readFileSync(rutaCodigo, 'utf8') !== contenido) {
      fs.writeFileSync(rutaCodigo, contenido);
    }
  }
  // En modo prueba los códigos del archivo se mantienen sincronizados con la BD.
  if (lic.modo === 'prueba') escribirCodigos();

  if (!licenciaRegistrada) {
    console.log(`\n  Versión de prueba activada ${licencia.DIAS_PRUEBA} días (hasta ${lic.fin}).`);
    console.log(`  Código para reiniciar la prueba: ${lic.codigo_prueba}`);
    console.log(`  Código de activación permanente: ${lic.codigo_comprado}`);
    console.log(`  Guardados en ${rutaCodigo}\n`);
  } else if (lic.modo === 'prueba') {
    if (licencia.expirada(lic)) {
      console.log(`\n  La versión de prueba venció el ${lic.fin}. El sistema está en solo-lectura.\n`);
    } else {
      console.log(`\n  Versión de prueba: ${licencia.diasRestantes(lic)} días restantes (hasta ${lic.fin}).`);
      console.log(`  Códigos de licencia disponibles en ${rutaCodigo}\n`);
    }
  } else {
    console.log('Versión completa activada.\n');
  }

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`Sistema Panadería corriendo en http://localhost:${PORT} (PostgreSQL)`);
    if (!fs.existsSync('/.dockerenv')) {
      for (const ip of ipsRedLocal()) console.log(`  También en http://${ip}:${PORT} (desde otros equipos de la red)`);
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const alt = PORT + 1;
      app.listen(alt, () => console.log(`El puerto ${PORT} está ocupado. Corriendo en http://localhost:${alt}`));
    } else {
      throw err;
    }
  });

  for (const señal of ['SIGINT', 'SIGTERM']) {
    process.on(señal, () => {
      console.log('\nCerrando el sistema...');
      server.close(async () => {
        try { await db.cerrar(); } catch (_) {}
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }

  hacerBackup();
  setInterval(hacerBackup, 60 * 60 * 1000).unref();
})().catch((e) => {
  console.error('No se pudo arrancar el sistema:', e);
  process.exit(1);
});