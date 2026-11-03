const db = require('../db/schema');
const { bErr } = require('../lib/ayudas');

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

// Producción simple: registrar cuánto se horneó y sumar stock.
// Sin recetas ni costos de materias primas.

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

module.exports = { hoy, producir };