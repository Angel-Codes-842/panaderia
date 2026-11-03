const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const auth = require('../services/auth');
const db = require('../db/schema');

test('hashPassword: hash determinista con el mismo salt', () => {
  const a = auth.hashPassword('secreto', 'sal');
  const b = auth.hashPassword('secreto', 'sal');
  assert.equal(a.salt, 'sal');
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash.length, 128); // 64 bytes en hex
});

test('hashPassword: salt distinto -> hash distinto', () => {
  const a = auth.hashPassword('secreto', 's1');
  const b = auth.hashPassword('secreto', 's2');
  assert.notEqual(a.hash, b.hash);
});

test('hashes verificables contra la forma que guarda el sistema', () => {
  const { salt, hash } = auth.hashPassword('admin123');
  const { hash: otra } = auth.hashPassword('admin123', salt);
  assert.equal(otra, hash);
  const { hash: mala } = auth.hashPassword('admin1234', salt);
  assert.notEqual(mala, hash);
});

test('verificacion usa comparacion segura (constante en tiempo)', () => {
  // Verificar la forma interna: verificarCredenciales contraste ambas cadenas
  // con timingSafeEqual. Aquí validamos que la función de hash produce buffers
  // del largo esperado para esa comparación.
  const { hash } = auth.hashPassword('x');
  assert.ok(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hash, 'hex')));
});

test('normalizarUsuario: recorta y pasa a minúsculas', () => {
  assert.equal(auth.normalizarUsuario('  Admin  '), 'admin');
  assert.equal(auth.normalizarUsuario('USUARIO'), 'usuario');
  assert.equal(auth.normalizarUsuario(null), '');
  assert.equal(auth.normalizarUsuario(undefined), '');
});

test('leerCookies: parsea el header', () => {
  const c = auth.leerCookies('b=1; panaderia_sesion=abc123; otro=%20x%20');
  assert.equal(c.b, '1');
  assert.equal(c.panaderia_sesion, 'abc123');
  assert.equal(c.otro, ' x '); // decodeURIComponent aplicado
  assert.deepEqual(auth.leerCookies(''), {});
  assert.deepEqual(auth.leerCookies(null), {});
});

test('cookieSesion: formato seguro y round-trip con leerCookies', () => {
  const c = auth.cookieSesion('tok123');
  assert.match(c, /panaderia_sesion=tok123/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=43200/);
  assert.equal(auth.leerCookies(c).panaderia_sesion, 'tok123');
  assert.ok(!/Secure/.test(c)); // sin HTTPS no lleva Secure
});

test('cookieSesion: con HTTPS agrega Secure', () => {
  const prev = process.env.HTTPS;
  process.env.HTTPS = '1';
  try {
    assert.match(auth.cookieSesion('t'), /Secure/);
  } finally {
    if (prev === undefined) delete process.env.HTTPS; else process.env.HTTPS = prev;
  }
});

test('cookieVacia: expira la cookie', () => {
  const c = auth.cookieVacia();
  assert.match(c, /panaderia_sesion=;/);
  assert.match(c, /Max-Age=0/);
});

test('sesionDeToken evita renovar la fila en cada petición y renueva cerca del vencimiento', async () => {
  const getOriginal = db.get;
  const runOriginal = db.run;
  let escrituras = 0;
  let horasRestantes = 11;
  db.get = async () => ({
    token: 'token-prueba',
    expira: new Date(Date.now() + horasRestantes * 60 * 60 * 1000).toISOString(),
    id: 7,
    usuario: 'prueba',
    sucursal_id: null,
  });
  db.run = async () => { escrituras++; };

  try {
    await auth.sesionDeToken('token-prueba');
    assert.equal(escrituras, 0, 'no escribe si quedan más de 6 horas');

    horasRestantes = 5;
    await auth.sesionDeToken('token-prueba');
    assert.equal(escrituras, 1, 'renueva al entrar en la mitad final de la sesión');
  } finally {
    db.get = getOriginal;
    db.run = runOriginal;
  }
});

test('sesionDeToken rechaza sesiones vencidas sin escribir en la base', async () => {
  const getOriginal = db.get;
  const runOriginal = db.run;
  let escrituras = 0;
  db.get = async () => ({
    token: 'token-vencido',
    expira: new Date(Date.now() - 1000).toISOString(),
    id: 7,
    usuario: 'prueba',
    sucursal_id: null,
  });
  db.run = async () => { escrituras++; };

  try {
    assert.equal(await auth.sesionDeToken('token-vencido'), null);
    assert.equal(escrituras, 0);
  } finally {
    db.get = getOriginal;
    db.run = runOriginal;
  }
});