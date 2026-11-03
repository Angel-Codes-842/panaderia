const { test } = require('node:test');
const assert = require('node:assert');
const { hoy, num, entero, str, esFormaPago, fechaValida, bErr } = require('../lib/ayudas');

test('hoy devuelve YYYY-MM-DD', () => {
  assert.match(hoy(), /^\d{4}-\d{2}-\d{2}$/);
});

test('num: números válidos, strings y rechazos', () => {
  assert.equal(num(5), 5);
  assert.equal(num('12.5'), 12.5);
  assert.equal(num('  '), null);
  assert.equal(num('abc'), null);
  assert.equal(num(Infinity), null);
  assert.equal(num(NaN), null);
  assert.equal(num(50, 0, 100), 50);
  assert.equal(num(150, 0, 100), null);
  assert.equal(num(-1, 0), null);
  assert.equal(num(10, 0, 100, 99), 10); // valor por defecto solo cuando inválido
  assert.equal(num('', 0), null);
});

test('entero: solo enteros en rango', () => {
  assert.equal(entero(3), 3);
  assert.equal(entero('7'), 7);
  assert.equal(entero(3.5), null);
  assert.equal(entero(0), null);          // por defecto min=1
  assert.equal(entero(0, 0), 0);          // min explícito 0
  assert.equal(entero(-5), null);
  assert.equal(entero('x'), null);
});

test('str: recorta, normaliza vacío y solo acepta strings', () => {
  assert.equal(str('  hola  '), 'hola');
  assert.equal(str('a'.repeat(500), 10), 'a'.repeat(10));
  assert.equal(str(''), '');
  assert.equal(str('   '), '');
  assert.equal(str(null), '');
  assert.equal(str(123), '');
});

test('esFormaPago: normaliza y cae a efectivo', () => {
  assert.equal(esFormaPago('efectivo'), 'efectivo');
  assert.equal(esFormaPago('transferencia'), 'transferencia');
  assert.equal(esFormaPago('tarjeta'), 'tarjeta');
  assert.equal(esFormaPago('pichincha'), 'efectivo');
  assert.equal(esFormaPago(undefined), 'efectivo');
});

test('fechaValida: solo YYYY-MM-DD', () => {
  assert.equal(fechaValida('2026-09-28'), '2026-09-28');
  assert.equal(fechaValida('2026/09/28'), null);
  assert.equal(fechaValida('28-09-2026'), null);
  assert.equal(fechaValida('2026-13-45'), '2026-13-45'); // formato, no validez de calendario
  assert.equal(fechaValida(null), null);
});

test('bErr identifica errores de negocio para devolver mensajes accionables', () => {
  const error = bErr('Configurá el IVA del producto antes de emitir la factura.');
  assert.equal(error.message, 'Configurá el IVA del producto antes de emitir la factura.');
  assert.equal(error.status, 400);
  assert.equal(error.esErrorNegocio, true);
});