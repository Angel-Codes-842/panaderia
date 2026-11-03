const TZ_OFFSET_MS = 3 * 3600 * 1000;

// Fecha local del negocio (Paraguay, UTC-3) desplazada N días (negativo = atrás),
// como YYYY-MM-DD.
function fechaOffset(offset) {
  const d = new Date(Date.now() - TZ_OFFSET_MS);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Fecha local del negocio (Paraguay, UTC-3) como YYYY-MM-DD.
function hoy() {
  return fechaOffset(0);
}

function num(v, min = -Infinity, max = Infinity, def = null) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

function entero(v, min = 1, def = null) {
  const n = num(v, min, Infinity, def);
  return Number.isInteger(n) ? n : def;
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.slice(0, max).trim() : '';
}

const FORMAS_PAGO = ['efectivo', 'transferencia', 'tarjeta', 'credito'];

function esFormaPago(v) {
  return FORMAS_PAGO.includes(v) ? v : 'efectivo';
}

function fechaValida(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Error de negocio: el middleware de errores responde con su status (400 por
// defecto) en vez de tratarlo como un fallo interno (500).
function bErr(mensaje, status = 400) {
  const e = new Error(mensaje);
  e.status = status;
  e.esErrorNegocio = true;
  return e;
}

module.exports = { hoy, fechaOffset, num, entero, str, esFormaPago, FORMAS_PAGO, fechaValida, bErr };