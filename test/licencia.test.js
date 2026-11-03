const { test } = require('node:test');
const assert = require('node:assert');
const lic = require('../services/licencia');

test('la prueba declarada dura 2 meses (60 días)', () => {
  assert.equal(lic.DIAS_PRUEBA, 60);
});

test('hoy y sumarDias: aritmética de fechas', () => {
  assert.match(lic.hoy(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(lic.sumarDias('2026-09-28', 21), '2026-10-19');
  assert.equal(lic.sumarDias('2026-09-28', -6), '2026-09-22');
  assert.equal(lic.sumarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(lic.sumarDias('2026-02-28', 1), '2026-03-01');
});

test('validarCodigo: comparación en tiempo constante', () => {
  assert.ok(lic.validarCodigo('abc123', 'abc123'));
  assert.ok(!lic.validarCodigo('abc124', 'abc123'));
  assert.ok(!lic.validarCodigo('abc12', 'abc123'));     // largo distinto
  assert.ok(!lic.validarCodigo('', 'abc123'));
  assert.ok(!lic.validarCodigo('abc123', ''));          // código guardado vacío
  assert.ok(!lic.validarCodigo(null, 'abc123'));
  assert.ok(!lic.validarCodigo(123, 'abc123'));
});

test('esComprado y expirada', () => {
  assert.ok(lic.esComprado({ modo: 'comprado' }));
  assert.ok(!lic.esComprado({ modo: 'prueba' }));
  assert.ok(lic.expirada({ modo: 'prueba', fin: '2020-01-01' }));
  assert.ok(!lic.expirada({ modo: 'prueba', fin: '2999-01-01' }));
  assert.ok(!lic.expirada({ modo: 'comprado', fin: '2020-01-01' })); // comprado nunca expira
});

test('diasRestantes: margen hacia el futuro y 0 cuando venció', () => {
  assert.equal(lic.diasRestantes({ fin: '2000-01-01' }), 0);
  const dentro = lic.diasRestantes({ fin: lic.sumarDias(lic.hoy(), 10) });
  assert.ok(dentro >= 9 && dentro <= 11, `esperado ~10 días, fue ${dentro}`);
  const lejos = lic.diasRestantes({ fin: '2999-01-01' });
  assert.ok(lejos > 1000);
});