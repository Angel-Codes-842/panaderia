const crypto = require('crypto');
const db = require('../db/schema');

const HORAS_SESION = 12;
const COOKIE = 'panaderia_sesion';
const USUARIO_INICIAL = process.env.INITIAL_ADMIN_USER || 'admin';
const PASSWORD_INICIAL = process.env.INITIAL_ADMIN_PASSWORD || 'admin123';

// Garantiza que siempre haya una forma de entrar al sistema:
// si la base no tiene ningún usuario (instalación nueva, base restaurada
// de una versión vieja), crea el acceso inicial.
async function asegurarUsuarioInicial() {
  const fila = await db.get(`SELECT COUNT(*)::int AS c FROM usuarios`);
  if (fila.c > 0) return false;
  await crearUsuario(USUARIO_INICIAL, PASSWORD_INICIAL);
  return true;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function normalizarUsuario(usuario) {
  return String(usuario || '').trim().toLowerCase();
}

async function crearUsuario(usuario, password, sucursalId = null) {
  const u = normalizarUsuario(usuario);
  const { salt, hash } = hashPassword(password);
  const fila = await db.get(
    `INSERT INTO usuarios (usuario, password_hash, salt, sucursal_id, activo, creado_en) VALUES ($1,$2,$3,$4,1,$5) RETURNING id`,
    [u, hash, salt, sucursalId ?? null, new Date().toISOString()]
  );
  return fila.id;
}

async function usuarioExiste(usuario) {
  const fila = await db.get(`SELECT id FROM usuarios WHERE usuario = $1`, [normalizarUsuario(usuario)]);
  return !!fila;
}

async function cambiarPassword(usuarioId, password) {
  const { salt, hash } = hashPassword(password);
  await db.run(`UPDATE usuarios SET password_hash = $1, salt = $2 WHERE id = $3`, [hash, salt, usuarioId]);
  await db.run(`DELETE FROM sesiones WHERE usuario_id = $1`, [usuarioId]);
}

async function verificarCredenciales(usuario, password) {
  const fila = await db.get(`SELECT * FROM usuarios WHERE usuario = $1 AND activo = 1`, [normalizarUsuario(usuario)]);
  if (!fila || typeof password !== 'string' || !password) return null;
  const { hash } = hashPassword(password, fila.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(fila.password_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: fila.id, usuario: fila.usuario, sucursal_id: fila.sucursal_id ?? null };
}

async function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const ahora = Date.now();
  await db.run(`INSERT INTO sesiones (token, usuario_id, creada, expira) VALUES ($1,$2,$3,$4)`,
    [token, usuarioId, new Date(ahora).toISOString(), new Date(ahora + HORAS_SESION * 3600 * 1000).toISOString()]);
  return token;
}

async function sesionDeToken(token) {
  if (!token) return null;
  const fila = await db.get(`
    SELECT s.expira, u.id, u.usuario, u.sucursal_id
    FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = $1 AND u.activo = 1
  `, [token]);
  if (!fila) return null;
  const ahora = Date.now();
  const expira = new Date(fila.expira).getTime();
  if (expira <= ahora) return null;

  // Mantiene las 12 horas de inactividad, pero evita escribir en PostgreSQL
  // en cada petición autenticada.
  if (expira - ahora <= (HORAS_SESION * 3600 * 1000) / 2) {
    const nuevaExpira = new Date(ahora + HORAS_SESION * 3600 * 1000).toISOString();
    await db.run(`UPDATE sesiones SET expira = $1 WHERE token = $2 AND expira = $3`,
      [nuevaExpira, token, fila.expira]);
  }
  return { id: fila.id, usuario: fila.usuario, sucursal_id: fila.sucursal_id ?? null };
}

async function cerrarSesion(token) {
  if (token) await db.run(`DELETE FROM sesiones WHERE token = $1`, [token]);
}

async function cerrarSesionesDe(usuarioId, menosToken = null) {
  if (menosToken) await db.run(`DELETE FROM sesiones WHERE usuario_id = $1 AND token != $2`, [usuarioId, menosToken]);
  else await db.run(`DELETE FROM sesiones WHERE usuario_id = $1`, [usuarioId]);
}

async function limpiarSesionesVencidas() {
  await db.run(`DELETE FROM sesiones WHERE expira <= $1`, [new Date().toISOString()]);
}

function leerCookies(header) {
  const salida = {};
  for (const parte of String(header || '').split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    salida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return salida;
}

function cookieSesion(token, maxAgeSegundos = HORAS_SESION * 3600) {
  const secure = process.env.HTTPS === '1' ? '; Secure' : '';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSegundos}${secure}`;
}

function cookieVacia() {
  const secure = process.env.HTTPS === '1' ? '; Secure' : '';
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

module.exports = {
  HORAS_SESION, COOKIE, USUARIO_INICIAL, PASSWORD_INICIAL, asegurarUsuarioInicial,
  hashPassword, normalizarUsuario, crearUsuario, usuarioExiste, cambiarPassword, verificarCredenciales,
  crearSesion, sesionDeToken, cerrarSesion, cerrarSesionesDe, limpiarSesionesVencidas,
  leerCookies, cookieSesion, cookieVacia
};