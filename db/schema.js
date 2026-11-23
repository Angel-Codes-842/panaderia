const pg = require('pg');
const { Pool } = pg;

// INT8 (BIGINT) viaja como string por defecto; lo parseamos a Number para
// que los ids lleguen como números al frontend (comparaciones estrictas).
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// En Docker la app levanta con DATABASE_URL apuntando al servicio `db`.
// Sin Docker, cae en el Postgres local del host.
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://panaderia:panaderia@localhost:5432/panaderia';

const poolMax = Number.parseInt(process.env.DB_POOL_MAX || '5', 10);
if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 20) {
  throw new Error('DB_POOL_MAX debe ser un entero entre 1 y 20');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'panaderia-app',
});

pool.on('error', (error) => {
  console.error('Error en una conexión inactiva de PostgreSQL:', error);
});

// Fachada de acceso a datos: misma forma que antes (get/all/run), pero async.
const db = {
  DATA_DIR,
  pool,
  async get(sql, params = []) {
    const r = await pool.query(sql, params);
    return r.rows[0];
  },
  async all(sql, params = []) {
    const r = await pool.query(sql, params);
    return r.rows;
  },
  // Igual que `all`, pero devuelve también los nombres de columna (para
  // exportaciones CSV que deben mantener el encabezado aunque no haya filas).
  async allCols(sql, params = []) {
    const r = await pool.query(sql, params);
    return { columnas: r.fields.map((f) => f.name), filas: r.rows };
  },
  async run(sql, params = []) {
    const r = await pool.query(sql, params);
    return r;
  },
  // Transacción con cliente dedicado: `fn` recibe { get, all, run } sobre ese
  // cliente, para que las lecturas y escrituras queden dentro de la transacción.
  async transakt(fn) {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const t = {
        get: async (sql, p = []) => (await cliente.query(sql, p)).rows[0],
        all: async (sql, p = []) => (await cliente.query(sql, p)).rows,
        run: async (sql, p = []) => cliente.query(sql, p),
      };
      const resultado = await fn(t);
      await cliente.query('COMMIT');
      return resultado;
    } catch (e) {
      try { await cliente.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      cliente.release();
    }
  },
};

const DDL = `
CREATE TABLE IF NOT EXISTS sucursales (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  direccion TEXT NOT NULL DEFAULT '',
  activa SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS usuarios (
  id BIGSERIAL PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  sucursal_id BIGINT,
  activo SMALLINT NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada TEXT NOT NULL,
  expira TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS productos (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'Otros',
  unidad TEXT NOT NULL DEFAULT 'unidad',
  precio_venta DOUBLE PRECISION NOT NULL DEFAULT 0,
  stock DOUBLE PRECISION NOT NULL DEFAULT 0,
  activo SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS insumos (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  unidad_base TEXT NOT NULL CHECK (unidad_base IN ('kg', 'l', 'unidad')),
  costo_unitario DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
  activo SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recetas (
  producto_id BIGINT PRIMARY KEY REFERENCES productos(id),
  rendimiento DOUBLE PRECISION NOT NULL CHECK (rendimiento > 0),
  margen DOUBLE PRECISION NOT NULL DEFAULT 40 CHECK (margen >= 0),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receta_insumos (
  id BIGSERIAL PRIMARY KEY,
  producto_id BIGINT NOT NULL REFERENCES recetas(producto_id) ON DELETE CASCADE,
  insumo_id BIGINT NOT NULL REFERENCES insumos(id),
  cantidad DOUBLE PRECISION NOT NULL CHECK (cantidad > 0),
  unidad TEXT NOT NULL CHECK (unidad IN ('kg', 'g', 'l', 'ml', 'unidad'))
);

-- Código opcional para buscar o escanear en el punto de venta. Solo es único
-- entre los productos que tienen código.
ALTER TABLE productos ADD COLUMN IF NOT EXISTS codigo TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS lotes (
  id BIGSERIAL PRIMARY KEY,
  producto_id BIGINT NOT NULL REFERENCES productos(id),
  unidades_producidas DOUBLE PRECISION NOT NULL DEFAULT 0,
  fecha TEXT NOT NULL,
  sucursal_id BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clientes (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL DEFAULT '',
  tipo_documento TEXT NOT NULL DEFAULT 'RUC',
  documento TEXT NOT NULL DEFAULT '',
  telefono TEXT DEFAULT '',
  activo SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS configuracion (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  nombre_negocio TEXT NOT NULL DEFAULT 'Panadería',
  ruc TEXT NOT NULL DEFAULT '',
  actividad_economica TEXT NOT NULL DEFAULT '',
  timbrado TEXT NOT NULL DEFAULT '',
  direccion TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  ciudad TEXT NOT NULL DEFAULT '',
  terminos_aceptados TEXT NOT NULL DEFAULT '',
  terminos_fecha TEXT NOT NULL DEFAULT ''
);

ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS logo TEXT NOT NULL DEFAULT '';
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS actividad_economica TEXT NOT NULL DEFAULT '';
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS permitir_venta_sin_stock SMALLINT NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS configuracion_fiscal (
  sucursal_id BIGINT PRIMARY KEY REFERENCES sucursales(id) ON DELETE CASCADE,
  timbrado TEXT NOT NULL DEFAULT '',
  timbrado_vigencia TEXT NOT NULL DEFAULT '',
  establecimiento TEXT NOT NULL DEFAULT '001',
  punto_expedicion TEXT NOT NULL DEFAULT '001',
  numero_desde INT NOT NULL DEFAULT 1,
  numero_hasta INT NOT NULL DEFAULT 9999999
);
-- Todo producto nace con IVA 10% (precios de venta con IVA incluido).
ALTER TABLE productos ADD COLUMN IF NOT EXISTS iva_tasa SMALLINT DEFAULT 10;
ALTER TABLE productos ALTER COLUMN iva_tasa SET DEFAULT 10;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'productos_iva_tasa_check') THEN
    ALTER TABLE productos ADD CONSTRAINT productos_iva_tasa_check
      CHECK (iva_tasa IS NULL OR iva_tasa IN (0, 5, 10));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ventas (
  id BIGSERIAL PRIMARY KEY,
  numero_comprobante INT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'ticket',
  sucursal_id BIGINT NOT NULL DEFAULT 1,
  fecha TEXT NOT NULL,
  forma_pago TEXT NOT NULL DEFAULT 'efectivo',
  cliente_id BIGINT REFERENCES clientes(id),
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  costo DOUBLE PRECISION NOT NULL DEFAULT 0,
  anulada SMALLINT NOT NULL DEFAULT 0
);

-- Descuento aplicado al total, dinero efectivamente cobrado y estado de la
-- cuenta (una venta a crédito queda 'pendiente' hasta cubrir el total).
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS descuento DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS pagado DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS estado_pago TEXT NOT NULL DEFAULT 'pagada';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fiscal_timbrado TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fiscal_vigencia TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fiscal_establecimiento TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fiscal_punto_expedicion TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS emisor_nombre TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS emisor_ruc TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS emisor_actividad TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS emisor_direccion TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS emisor_telefono TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS emisor_ciudad TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS cliente_nombre_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS cliente_documento_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS cliente_tipo_documento_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS motivo_anulacion TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS anulado_por BIGINT REFERENCES usuarios(id);
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS anulado_por_usuario TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS anulado_en TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS venta_pagos (
  venta_id BIGINT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  forma_pago TEXT NOT NULL CHECK (forma_pago IN ('efectivo', 'transferencia', 'tarjeta')),
  monto DOUBLE PRECISION NOT NULL CHECK (monto > 0),
  PRIMARY KEY (venta_id, forma_pago)
);

CREATE TABLE IF NOT EXISTS venta_detalles (
  id BIGSERIAL PRIMARY KEY,
  venta_id BIGINT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id BIGINT NOT NULL REFERENCES productos(id),
  cantidad DOUBLE PRECISION NOT NULL DEFAULT 1,
  precio DOUBLE PRECISION NOT NULL DEFAULT 0,
  costo DOUBLE PRECISION NOT NULL DEFAULT 0
);
ALTER TABLE venta_detalles ADD COLUMN IF NOT EXISTS nombre_producto TEXT NOT NULL DEFAULT '';
ALTER TABLE venta_detalles ADD COLUMN IF NOT EXISTS iva_tasa SMALLINT;
ALTER TABLE venta_detalles ADD COLUMN IF NOT EXISTS iva_base DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE venta_detalles ADD COLUMN IF NOT EXISTS iva_monto DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE venta_detalles ADD COLUMN IF NOT EXISTS descuento DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE venta_detalles ADD COLUMN IF NOT EXISTS importe DOUBLE PRECISION;
UPDATE venta_detalles SET importe = cantidad * precio WHERE importe IS NULL;
ALTER TABLE venta_detalles ALTER COLUMN importe SET DEFAULT 0;
ALTER TABLE venta_detalles ALTER COLUMN importe SET NOT NULL;

CREATE TABLE IF NOT EXISTS cajas (
  id BIGSERIAL PRIMARY KEY,
  fecha TEXT NOT NULL,
  sucursal_id BIGINT NOT NULL DEFAULT 1,
  apertura DOUBLE PRECISION NOT NULL DEFAULT 0,
  cierre_esperado DOUBLE PRECISION,
  cierre_real DOUBLE PRECISION,
  diferencia DOUBLE PRECISION,
  cierre_denominaciones JSONB,
  estado TEXT NOT NULL DEFAULT 'abierta'
);
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS cierre_denominaciones JSONB;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS motivo_reapertura TEXT NOT NULL DEFAULT '';
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS reabierto_por BIGINT REFERENCES usuarios(id);
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS reabierto_por_usuario TEXT NOT NULL DEFAULT '';
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS reabierto_en TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS movimientos_caja (
  id BIGSERIAL PRIMARY KEY,
  caja_id BIGINT NOT NULL REFERENCES cajas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  concepto TEXT NOT NULL,
  monto DOUBLE PRECISION NOT NULL,
  fecha TEXT NOT NULL
);

-- Pagos parciales de una venta a crédito. Cada abono queda con su fecha, la
-- caja donde entró el dinero y el cliente al que pertenece la deuda.
CREATE TABLE IF NOT EXISTS abonos (
  id BIGSERIAL PRIMARY KEY,
  venta_id BIGINT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  cliente_id BIGINT NOT NULL REFERENCES clientes(id),
  sucursal_id BIGINT NOT NULL DEFAULT 1,
  caja_id BIGINT REFERENCES cajas(id),
  monto DOUBLE PRECISION NOT NULL,
  fecha TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proveedores (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  contacto TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  ruc TEXT NOT NULL DEFAULT '',
  rubro TEXT NOT NULL DEFAULT '',
  direccion TEXT NOT NULL DEFAULT '',
  activo SMALLINT NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS gastos (
  id BIGSERIAL PRIMARY KEY,
  concepto TEXT NOT NULL,
  monto DOUBLE PRECISION NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'Otros',
  fecha TEXT NOT NULL,
  sucursal_id BIGINT NOT NULL DEFAULT 1,
  caja_id BIGINT REFERENCES cajas(id)
);

ALTER TABLE gastos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'varios';
ALTER TABLE gastos ADD COLUMN IF NOT EXISTS proveedor_id BIGINT REFERENCES proveedores(id);
ALTER TABLE gastos ADD COLUMN IF NOT EXISTS motivo TEXT NOT NULL DEFAULT '';
ALTER TABLE gastos ADD COLUMN IF NOT EXISTS comprobante TEXT NOT NULL DEFAULT '';
ALTER TABLE gastos ADD COLUMN IF NOT EXISTS forma_pago TEXT NOT NULL DEFAULT 'efectivo';

CREATE TABLE IF NOT EXISTS licencia (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  modo TEXT NOT NULL DEFAULT 'prueba',
  inicio TEXT NOT NULL,
  fin TEXT NOT NULL,
  codigo_prueba TEXT NOT NULL,
  codigo_comprado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id BIGSERIAL PRIMARY KEY,
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  usuario_id BIGINT REFERENCES usuarios(id),
  usuario_nombre TEXT NOT NULL DEFAULT '',
  sucursal_id BIGINT REFERENCES sucursales(id),
  accion TEXT NOT NULL,
  entidad_tipo TEXT NOT NULL,
  entidad_id BIGINT,
  detalles JSONB,
  motivo TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha_sucursal ON ventas(sucursal_id, fecha);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha_anulada ON ventas(fecha, anulada);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comprobante ON ventas(tipo, sucursal_id, numero_comprobante);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_producto_codigo ON productos (codigo) WHERE codigo <> '';
CREATE INDEX IF NOT EXISTS idx_ventas_sucursal ON ventas(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_venta_detalles_venta ON venta_detalles(venta_id);
CREATE INDEX IF NOT EXISTS idx_venta_detalles_producto ON venta_detalles(producto_id);
CREATE INDEX IF NOT EXISTS idx_venta_pagos_venta ON venta_pagos(venta_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_caja ON movimientos_caja(caja_id);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_sucursal_fecha ON gastos(sucursal_id, fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_tipo ON gastos(tipo);
CREATE INDEX IF NOT EXISTS idx_gastos_proveedor ON gastos(proveedor_id);
CREATE INDEX IF NOT EXISTS idx_proveedores_activo ON proveedores(activo);
CREATE INDEX IF NOT EXISTS idx_lotes_fecha ON lotes(fecha);
CREATE INDEX IF NOT EXISTS idx_lotes_sucursal_fecha ON lotes(sucursal_id, fecha);
CREATE INDEX IF NOT EXISTS idx_cajas_sucursal_fecha ON cajas(sucursal_id, fecha);
CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_expira ON sesiones(expira);
CREATE INDEX IF NOT EXISTS idx_abonos_venta ON abonos(venta_id);
CREATE INDEX IF NOT EXISTS idx_abonos_cliente ON abonos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_ventas_credito ON ventas(cliente_id) WHERE anulada = 0;
CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_sucursal ON auditoria(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_accion ON auditoria(accion);
`;

// Crea el esquema (idempotente) y las filas base. Se llama una vez al arrancar.
async function migrar() {
  // Antes del DDL: ¿ya existían las columnas nuevas? Solo en la primera
  // migración hay que completar los datos viejos (si se repitiera en cada
  // arranque, una venta a crédito sin abono se marcaría como pagada).
  const previas = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'ventas' AND column_name = 'pagado') AS pagado,
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'productos' AND column_name = 'codigo') AS codigo
  `);
  const primeraVez = {
    pagado: Number(previas.rows[0].pagado) === 0,
    codigo: Number(previas.rows[0].codigo) === 0,
  };

  await pool.query(DDL);

  // Ventas anteriores a esta versión se cobraron completas.
  if (primeraVez.pagado) await db.run(`UPDATE ventas SET pagado = total, estado_pago = 'pagada'`);

  await db.run(`
    INSERT INTO venta_pagos (venta_id, forma_pago, monto)
    SELECT id, forma_pago, pagado
    FROM ventas
    WHERE forma_pago IN ('efectivo', 'transferencia', 'tarjeta') AND pagado > 0
    ON CONFLICT (venta_id, forma_pago) DO NOTHING
  `);

  // Retirar una sola vez los códigos sintéticos que generaban versiones anteriores.
  const codigoMigrado = await db.get(`SELECT version FROM schema_migrations WHERE version = 8`);
  if (!codigoMigrado) {
    await db.transakt(async (t) => {
      await t.run(`UPDATE productos SET codigo = ''
                   WHERE codigo = 'P' || LPAD(id::text, 4, '0')`);
      await t.run(`INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [8, new Date().toISOString()]);
    });
  }

  await db.run(`INSERT INTO sucursales (id, nombre, direccion) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [1, 'Principal', '']);
  await db.run(`INSERT INTO configuracion (id) VALUES (1) ON CONFLICT DO NOTHING`, []);
  await db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [9, new Date().toISOString()]);

  // Los productos creados antes de la tasa por defecto quedaban sin IVA y
  // bloqueaban la emisión de facturas. Se completan una sola vez con 10%.
  const ivaMigrado = await db.get(`SELECT version FROM schema_migrations WHERE version = 10`);
  if (!ivaMigrado) {
    await db.transakt(async (t) => {
      await t.run(`UPDATE productos SET iva_tasa = 10 WHERE iva_tasa IS NULL`);
      await t.run(`INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [10, new Date().toISOString()]);
    });
  }
  // "Principal" se inserta con id explícito 1; la secuencia BIGSERIAL quedó en 1 y
  // el primer INSERT sin id (crear sucursal) chocaría contra la PK. La sincronizo.
  await db.run(`SELECT setval(pg_get_serial_sequence('sucursales', 'id'), COALESCE((SELECT MAX(id) FROM sucursales), 1))`);
}

async function cerrar() {
  await pool.end();
}

module.exports = db;
module.exports.migrar = migrar;
module.exports.cerrar = cerrar;