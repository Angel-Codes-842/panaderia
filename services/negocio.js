const db = require('../db/schema');
const { bErr, num, str } = require('../lib/ayudas');

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

// Producción simple: registrar cuánto se horneó y sumar stock.

async function producir(productoId, cantidad, fecha, sucursalId = 1) {
  const p = await db.get(`SELECT * FROM productos WHERE id = $1 AND activo = 1`, [productoId]);
  if (!p) throw bErr('Producto no existe');
  if (!cantidad || cantidad <= 0) throw bErr('Ingresá una cantidad válida');

  return db.transakt(async (t) => {
    await t.run(`UPDATE productos SET stock = stock + $1 WHERE id = $2`, [cantidad, p.id]);
    const info = await t.get(
      `INSERT INTO lotes (producto_id, unidades_producidas, fecha, sucursal_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [p.id, cantidad, fecha, sucursalId]
    );
    return { lote_id: info.id, cantidad, unidad: p.unidad, producto_nombre: p.nombre };
  });
}

const UNIDADES_INSUMO = {
  kg: { base: 'kg', factor: 1 },
  g: { base: 'kg', factor: 0.001 },
  l: { base: 'l', factor: 1 },
  ml: { base: 'l', factor: 0.001 },
  unidad: { base: 'unidad', factor: 1 },
};

function validarNombreInsumo(valor) {
  const nombre = str(valor, 100);
  if (!nombre) throw bErr('Ingresá el nombre del insumo');
  return nombre;
}

function validarUnidadBase(valor) {
  if (!['kg', 'l', 'unidad'].includes(valor)) {
    throw bErr('Elegí una unidad base válida para el insumo');
  }
  return valor;
}

function validarCosto(valor) {
  const costo = num(valor, 0, 1e12, null);
  if (costo === null) throw bErr('Ingresá un costo por unidad válido');
  return costo;
}

async function listarInsumos() {
  return db.all(`SELECT id, nombre, unidad_base, costo_unitario
                 FROM insumos WHERE activo = 1 ORDER BY nombre`);
}

async function guardarInsumo(datos, id = null) {
  const nombre = validarNombreInsumo(datos.nombre);
  const costo = validarCosto(datos.costo_unitario);

  if (id === null) {
    const unidad = validarUnidadBase(datos.unidad_base);
    const duplicado = await db.get(`SELECT id FROM insumos WHERE LOWER(nombre) = LOWER($1) AND activo = 1`, [nombre]);
    if (duplicado) throw bErr('Ya existe un insumo con ese nombre');
    const creado = await db.get(
      `INSERT INTO insumos (nombre, unidad_base, costo_unitario) VALUES ($1,$2,$3)
       RETURNING id, nombre, unidad_base, costo_unitario`,
      [nombre, unidad, costo]
    );
    return creado;
  }

  const existente = await db.get(`SELECT id FROM insumos WHERE id = $1 AND activo = 1`, [id]);
  if (!existente) throw bErr('El insumo no existe');
  const duplicado = await db.get(`SELECT id FROM insumos WHERE LOWER(nombre) = LOWER($1) AND id <> $2 AND activo = 1`, [nombre, id]);
  if (duplicado) throw bErr('Ya existe un insumo con ese nombre');
  return db.get(
    `UPDATE insumos SET nombre = $1, costo_unitario = $2
     WHERE id = $3 RETURNING id, nombre, unidad_base, costo_unitario`,
    [nombre, costo, id]
  );
}

async function obtenerReceta(productoId) {
  const producto = await db.get(`SELECT id, nombre, unidad FROM productos WHERE id = $1 AND activo = 1`, [productoId]);
  if (!producto) throw bErr('El producto no existe');
  const receta = await db.get(`SELECT rendimiento, margen FROM recetas WHERE producto_id = $1`, [productoId]);
  const insumos = await db.all(
    `SELECT ri.insumo_id, ri.cantidad, ri.unidad,
            i.nombre AS insumo_nombre, i.unidad_base, i.costo_unitario
     FROM receta_insumos ri JOIN insumos i ON i.id = ri.insumo_id
     WHERE ri.producto_id = $1 ORDER BY ri.id`,
    [productoId]
  );
  const costo = receta ? await calcularCostoReceta(db, productoId) : null;
  return {
    producto,
    receta: receta || null,
    insumos,
    costo,
    ...(costo || {}),
  };
}

async function calcularCostoReceta(t, productoId) {
  const datos = await t.get(
    `SELECT p.id AS producto_id, p.nombre AS producto_nombre, p.unidad AS producto_unidad,
            r.rendimiento, r.margen
     FROM productos p JOIN recetas r ON r.producto_id = p.id
     WHERE p.id = $1 AND p.activo = 1`,
    [productoId]
  );
  if (!datos) throw bErr('El producto no tiene una fórmula guardada');

  const insumos = await t.all(
    `SELECT i.nombre, i.unidad_base, i.costo_unitario, ri.cantidad, ri.unidad
     FROM receta_insumos ri JOIN insumos i ON i.id = ri.insumo_id
     WHERE ri.producto_id = $1 ORDER BY ri.id`,
    [productoId]
  );
  if (!insumos.length) throw bErr('Agregá al menos un ingrediente a la fórmula');

  const detalle = insumos.map((insumo) => {
    const unidad = UNIDADES_INSUMO[insumo.unidad];
    if (!unidad || unidad.base !== insumo.unidad_base) {
      throw bErr(`La unidad de ${insumo.nombre} ya no coincide con su unidad base`);
    }
    const costo = insumo.cantidad * unidad.factor * insumo.costo_unitario;
    return { ...insumo, costo };
  });
  const costoLote = detalle.reduce((total, insumo) => total + insumo.costo, 0);
  const costoUnitario = costoLote / datos.rendimiento;
  return {
    ...datos,
    insumos: detalle,
    costo_lote: costoLote,
    costo_unitario: costoUnitario,
    precio_sugerido: costoUnitario * (1 + datos.margen / 100),
  };
}

async function guardarReceta(productoId, datos) {
  const rendimiento = num(datos.rendimiento, 0.001, 1e9, null);
  if (rendimiento === null) throw bErr('Ingresá un rendimiento válido para la fórmula');
  const margen = num(datos.margen, 0, 1000, null);
  if (margen === null) throw bErr('El margen debe estar entre 0 y 1000%');
  if (!Array.isArray(datos.insumos) || !datos.insumos.length || datos.insumos.length > 100) {
    throw bErr('Agregá entre 1 y 100 ingredientes a la fórmula');
  }

  const producto = await db.get(`SELECT id FROM productos WHERE id = $1 AND activo = 1`, [productoId]);
  if (!producto) throw bErr('El producto no existe');

  const lineas = datos.insumos.map((linea) => {
    const insumoId = num(linea.insumo_id, 1, Number.MAX_SAFE_INTEGER, null);
    const cantidad = num(linea.cantidad, 0.001, 1e9, null);
    const unidad = UNIDADES_INSUMO[linea.unidad];
    if (insumoId === null || cantidad === null || !unidad) {
      throw bErr('Revisá los ingredientes, cantidades y unidades de la fórmula');
    }
    return { insumoId, cantidad, unidad: linea.unidad, base: unidad.base };
  });

  return db.transakt(async (t) => {
    const insumoIds = [...new Set(lineas.map((linea) => linea.insumoId))];
    const activos = await t.all(
      `SELECT id, unidad_base FROM insumos WHERE activo = 1 AND id = ANY($1::bigint[])`,
      [insumoIds]
    );
    if (activos.length !== insumoIds.length) throw bErr('Uno o más insumos no existen o están inactivos');
    const porId = new Map(activos.map((insumo) => [Number(insumo.id), insumo]));
    if (lineas.some((linea) => porId.get(linea.insumoId).unidad_base !== linea.base)) {
      throw bErr('La unidad elegida no corresponde al tipo de insumo');
    }

    await t.run(
      `INSERT INTO recetas (producto_id, rendimiento, margen, actualizado_en)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (producto_id) DO UPDATE
       SET rendimiento = EXCLUDED.rendimiento, margen = EXCLUDED.margen, actualizado_en = NOW()`,
      [productoId, rendimiento, margen]
    );
    await t.run(`DELETE FROM receta_insumos WHERE producto_id = $1`, [productoId]);
    for (const linea of lineas) {
      await t.run(
        `INSERT INTO receta_insumos (producto_id, insumo_id, cantidad, unidad) VALUES ($1,$2,$3,$4)`,
        [productoId, linea.insumoId, linea.cantidad, linea.unidad]
      );
    }
    return calcularCostoReceta(t, productoId);
  });
}

async function aplicarPrecioSugerido(productoId) {
  return db.transakt(async (t) => {
    const costo = await calcularCostoReceta(t, productoId);
    await t.run(`UPDATE productos SET precio_venta = $1 WHERE id = $2`, [costo.precio_sugerido, productoId]);
    return costo;
  });
}

module.exports = {
  hoy,
  producir,
  listarInsumos,
  guardarInsumo,
  obtenerReceta,
  guardarReceta,
  calcularCostoReceta: (productoId) => calcularCostoReceta(db, productoId),
  aplicarPrecioSugerido,
};