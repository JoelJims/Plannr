// Part B — recipient numbers must be MASKED in failure logs (contact data must not accumulate on disk
// in the project root). maskPhone keeps the country/first digits + the last 4 and hides the middle.
const H = require('./helpers'); // sets PLANNR_TEST etc. before any app require
const whatsapp = require('../whatsapp');
const { test } = require('node:test');
const assert = require('node:assert');

test('maskPhone: keeps country/first + last 4, hides the middle', () => {
  assert.equal(whatsapp.maskPhone('+919812341427'), '+9198****1427');
  assert.equal(whatsapp.maskPhone('919812341427'), '9198****1427');
  assert.equal(whatsapp.maskPhone('+91 98123 41427'), '+9198****1427'); // separators stripped first
});

test('maskPhone: short / empty / null inputs never leak the whole number', () => {
  assert.equal(whatsapp.maskPhone('+1234'), '+****');
  assert.equal(whatsapp.maskPhone('12345678'), '12****78');
  assert.equal(whatsapp.maskPhone(''), '****');
  assert.equal(whatsapp.maskPhone(null), '****');
});
