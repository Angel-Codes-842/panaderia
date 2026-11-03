const db = require('./schema');
const auth = require('../services/auth');

function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

async function reset() {
  // usuarios, sesiones y licencia NO se borran: restablecer la demo no debe
  // resetear la contraseña ni cerrar sesiones ni tocar el estado de la licencia.
  await db.run(`TRUNCATE TABLE abonos, lotes, venta_detalles, ventas, movimientos_caja, gastos, cajas, productos, clientes RESTART IDENTITY CASCADE`);
  await auth.limpiarSesionesVencidas();
}

async function hacerSeed() {
  await reset();

  // ---------- Usuario de acceso ----------
  if (await auth.asegurarUsuarioInicial()) {
    console.log(`Usuario creado: ${auth.USUARIO_INICIAL} / ${auth.PASSWORD_INICIAL} (cambiá la contraseña en Configuración)`);
  }

  // ---------- Configuración del negocio ----------
  await db.run(`INSERT INTO configuracion (id, nombre_negocio, ruc, timbrado, direccion, telefono, ciudad) VALUES (1,$1,$2,$3,$4,$5,$6)
                ON CONFLICT (id) DO UPDATE SET nombre_negocio = EXCLUDED.nombre_negocio, ruc = EXCLUDED.ruc, timbrado = EXCLUDED.timbrado,
                  direccion = EXCLUDED.direccion, telefono = EXCLUDED.telefono, ciudad = EXCLUDED.ciudad`,
    ['Mi Panadería', '80012345-0', '12345678', 'Av. Defensores del Chaco 1560', '021-660123', 'Pilar, Ñeembucú']);

  // ---------- Productos (simples: nombre, categoría, unidad, precio, stock) ----------
  const productos = [
    { nombre: 'Pan francés', categoria: 'Panes', unidad: 'kg', precio_venta: 14000, salida_lote: 30, stock: 15 },
    { nombre: 'Pan de hamburguesa', categoria: 'Panes', unidad: 'unidad', precio_venta: 2500, salida_lote: 48, stock: 60 },
    { nombre: 'Pan integral', categoria: 'Panes', unidad: 'kg', precio_venta: 16000, salida_lote: 12, stock: 8 },
    { nombre: 'Chipa', categoria: 'Panes', unidad: 'kg', precio_venta: 18000, salida_lote: 8, stock: 6 },
    { nombre: 'Medialuna', categoria: 'Facturas', unidad: 'unidad', precio_venta: 2500, salida_lote: 48, stock: 80 },
    { nombre: 'Factura de crema', categoria: 'Facturas', unidad: 'unidad', precio_venta: 3500, salida_lote: 40, stock: 40 },
    { nombre: 'Tortita negra', categoria: 'Facturas', unidad: 'unidad', precio_venta: 2000, salida_lote: 60, stock: 90 },
    { nombre: 'Biscocho', categoria: 'Bizcochos', unidad: 'docena', precio_venta: 12000, salida_lote: 5, stock: 12 },
    { nombre: 'Galletas de miel', categoria: 'Bizcochos', unidad: 'docena', precio_venta: 9000, salida_lote: 6, stock: 10 },
    { nombre: 'Bizcochuelo chocolate', categoria: 'Tortas', unidad: 'unidad', precio_venta: 35000, salida_lote: 4, stock: 4 }
  ];

  const productosDB = {};
  for (const p of productos) {
    const info = await db.get(`INSERT INTO productos (nombre, categoria, unidad, precio_venta, stock) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [p.nombre, p.categoria, p.unidad, p.precio_venta, p.stock]);
    productosDB[p.nombre] = { id: info.id, ...p };
  }
  // ---------- Clientes ----------
  const clientesNombres = [
    ['Doña Carmen', 'Cédula', '3456789', '0981-123456'],
    ['Carnicería San José', 'RUC', '80012345-6', '0982-765432'],
    ['Panadería La Abuela', 'RUC', '80098765-4', '0981-555222'],
    ['Sra. López', 'Cédula', '1234567', ''],
    ['Almacén Central', 'RUC', '80044455-8', '021-445566'],
    ['Pablo Martínez', 'Cédula', '7654321', '0985-333111']
  ];
  const clienteIds = [];
  for (const [n, td, doc, tel] of clientesNombres) {
    const info = await db.get(`INSERT INTO clientes (nombre, tipo_documento, documento, telefono) VALUES ($1,$2,$3,$4) RETURNING id`, [n, td, doc, tel]);
    clienteIds.push(info.id);
  }

  // ---------- Historial de la última semana ----------
  function fechaISO(offset) {
    const d = new Date(Date.now() - 3 * 3600 * 1000 - offset * 86400000);
    return d.toISOString().slice(0, 10);
  }

  const nombres = Object.keys(productosDB);

  const gastosDemo = [
    ['Pago de luz', 'Servicios'], ['Pago de agua', 'Servicios'], ['Recarga de garrafa', 'Insumos varios'],
    ['Bolsas y envases', 'Insumos varios'], ['Reparación de horno', 'Mantenimiento'], ['Limpieza', 'Mantenimiento'],
    ['Flete', 'Otros'], ['Sueldo ayudante', 'Sueldos']
  ];

  let nroTicket = 0;
  let nroFactura = 0;

  for (let offset = 6; offset >= 0; offset--) {
    const fecha = fechaISO(offset);
    const esHoy = offset === 0;

    // 1 a 3 producciones por día
    const cantLotes = int(1, 3);
    const lotesDeHoy = [];
    for (let i = 0; i < cantLotes; i++) {
      const p = productosDB[pick(nombres)];
      const factor = int(1, 3);
      await db.get(`INSERT INTO lotes (producto_id, unidades_producidas, fecha) VALUES ($1,$2,$3) RETURNING id`, [p.id, p.salida_lote * factor, fecha]);
      lotesDeHoy.push(p);
    }

    // 6 a 14 ventas por día
    const cantVentas = esHoy ? int(3, 6) : int(6, 14);
    const formas = ['efectivo', 'efectivo', 'efectivo', 'transferencia'];
    let totalDia = 0;
    for (let i = 0; i < cantVentas; i++) {
      const conCliente = rand() < 0.3;
      const tipo = conCliente ? 'factura' : 'ticket';
      const numero = tipo === 'factura' ? ++nroFactura : ++nroTicket;
      const dets = [];
      const cantItems = int(1, 4);
      let total = 0;
      for (let j = 0; j < cantItems; j++) {
        const prod = productosDB[pick(nombres)];
        const cant = int(1, 12);
        total += prod.precio_venta * cant;
        dets.push([prod.id, cant, prod.precio_venta, 0]);
      }
      const vid = (await db.get(`INSERT INTO ventas (numero_comprobante, tipo, fecha, forma_pago, cliente_id, total, costo, descuento, pagado, estado_pago) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$6,'pagada') RETURNING id`,
        [numero, tipo, fecha, pick(formas), conCliente ? pick(clienteIds) : null, total, 0])).id;
      for (const d of dets) await db.run(`INSERT INTO venta_detalles (venta_id, producto_id, cantidad, precio, costo) VALUES ($1,$2,$3,$4,$5)`, [vid, ...d]);
      totalDia += total;
    }

    // Caja del día (hoy queda abierta)
    const apertura = int(300000, 800000);
    const estado = esHoy ? 'abierta' : 'cerrada';
    const cajaId = (await db.get(`INSERT INTO cajas (fecha, apertura, estado) VALUES ($1,$2,$3) RETURNING id`, [fecha, apertura, estado])).id;

    // Gastos del día, cada uno con su egreso de caja
    const gastosDia = [];
    for (let i = 0; i < int(0, 2); i++) {
      const [concepto, categoria] = pick(gastosDemo);
      const monto = int(50, 800) * 1000;
      await db.get(`INSERT INTO gastos (concepto, monto, categoria, fecha, caja_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [concepto, monto, categoria, fecha, cajaId]);
      await db.run(`INSERT INTO movimientos_caja (caja_id, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)`, [cajaId, 'egreso', `Gasto: ${concepto}`, monto, fecha]);
      gastosDia.push(monto);
    }

    // Movimientos de ingresos por venta
    const ventasDia = await db.all(`SELECT * FROM ventas WHERE fecha = $1`, [fecha]);
    for (const v of ventasDia) await db.run(`INSERT INTO movimientos_caja (caja_id, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)`, [cajaId, 'ingreso', `Venta N° ${v.numero_comprobante}`, v.total, fecha]);

    // Cierre de los días anteriores (el de hoy se cierra a mano en el sistema)
    if (!esHoy) {
      const egresosDia = gastosDia.reduce((a, m) => a + m, 0);
      const cierre = apertura + totalDia - egresosDia;
      await db.run(`UPDATE cajas SET cierre_esperado = $1, cierre_real = $2, diferencia = 0 WHERE id = $3`, [cierre, cierre, cajaId]);
    }
  }

  console.log('Seed OK');
  console.log('-', productos.length, 'productos');
  console.log('-', clientesNombres.length, 'clientes');
  console.log('- 7 días de historial con ventas, producción, gastos y cajas');
}

if (require.main === module) {
  hacerSeed().then(() => process.exit(0)).catch((e) => { console.error('Seed:', e); process.exit(1); });
}

module.exports = hacerSeed;