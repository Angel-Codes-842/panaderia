const crypto = require('crypto');
const db = require('../db/schema');

// Licencia del sistema. En modo 'prueba' hay un trial declarado de
// DIAS_PRUEBA (2 meses) con límites visibles. Cuando vence, el sistema pasa a
// solo-lectura: se puede ver todo, pero no registrar ventas nuevas.
const DIAS_PRUEBA = 60;
const DIAS_REPORTE_PRUEBA = 7;

function hoy() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function sumarDias(iso, dias) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const validarCodigo = (codigo, guardado) =>
  typeof codigo === 'string' && typeof guardado === 'string' &&
  guardado.length > 0 && codigo.length === guardado.length &&
  crypto.timingSafeEqual(Buffer.from(codigo), Buffer.from(guardado));

// Dos códigos por instalación:
//  - codigo_prueba: reinicia la prueba de 2 meses (se puede entregar sin
//    riesgo: solo alarga el reloj, y los datos de prueba no valen nada).
//  - codigo_comprado: activa la versión completa. Es el que se guarda para
//    el momento del cobro.

function nuevoCodigo() {
  return crypto.randomBytes(6).toString('hex');
}

// Caché breve de la licencia (menos lecturas a la base en cada request).
// Se invalida de forma explícita cuando cambia (reiniciar/activar).
let cache = null;
let cacheEn = 0;
// En tests se puede desactivar la caché (LICENCIA_CACHE_MS=0) para que un
// cambio externo de licencia se vea de inmediato.
const cacheMsVar = Number(process.env.LICENCIA_CACHE_MS);
const CACHE_MS = Number.isFinite(cacheMsVar) ? cacheMsVar : 30_000;

async function obtener() {
  const ahora = Date.now();
  if (cache && ahora - cacheEn < CACHE_MS) return cache;
  let fila = await db.get(`SELECT * FROM licencia WHERE id = $1`, [1]);
  if (!fila) {
    await db.run(`INSERT INTO licencia (id, modo, inicio, fin, codigo_prueba, codigo_comprado)
                  VALUES (1, 'prueba', $1, $2, $3, $4)`,
      [hoy(), sumarDias(hoy(), DIAS_PRUEBA), nuevoCodigo(), nuevoCodigo()]);
    return obtener();
  }
  cache = fila;
  cacheEn = ahora;
  return fila;
}

function invalidar() {
  cache = null;
}

function diasRestantes({ fin }) {
  const dias = Math.floor((new Date(fin + 'T23:59:59.999Z') - new Date(hoy() + 'T00:00:00Z')) / 86400000);
  return Math.max(0, dias);
}

function esComprado({ modo }) {
  return modo === 'comprado';
}

function expirada({ modo, fin }) {
  return modo === 'prueba' && hoy() > fin;
}

async function permitirEscribir() {
  return !expirada(await obtener());
}

// En prueba, los reportes solo llegan a DIAS_REPORTE_PRUEBA hacia atrás.
async function limiteReporte() {
  const l = await obtener();
  if (esComprado(l)) return null;
  return { desde: sumarDias(hoy(), -(DIAS_REPORTE_PRUEBA - 1)), dias: DIAS_REPORTE_PRUEBA };
}

// Reinicia la prueba: 2 meses DESDE HOY (desbloquea también el solo-lectura).
async function reiniciar(codigo) {
  const l = await obtener();
  if (!validarCodigo(codigo, l.codigo_prueba)) return { ok: false, error: 'El código de reinicio de prueba no es correcto.' };
  await db.run(`UPDATE licencia SET modo = 'prueba', inicio = $1, fin = $2 WHERE id = 1`,
    [hoy(), sumarDias(hoy(), DIAS_PRUEBA)]);
  invalidar();
  return { ok: true };
}

// Activa la versión completa de forma permanente.
async function activar(codigo) {
  const l = await obtener();
  if (!validarCodigo(codigo, l.codigo_comprado)) return { ok: false, error: 'El código de activación no es correcto.' };
  await db.run(`UPDATE licencia SET modo = 'comprado' WHERE id = 1`);
  invalidar();
  return { ok: true };
}

module.exports = {
  DIAS_PRUEBA, DIAS_REPORTE_PRUEBA,
  hoy, sumarDias, validarCodigo,
  obtener, diasRestantes, esComprado, expirada, permitirEscribir, limiteReporte,
  reiniciar, activar,
};