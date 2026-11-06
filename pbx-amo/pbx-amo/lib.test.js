'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizePhone, buildCallBody, buildUnsortedBody } = require('./lib');

test('normalizePhone приводит КЗ-номера к 7XXXXXXXXXX', () => {
  assert.strictEqual(normalizePhone('8 (707) 123-45-67'), '77071234567');
  assert.strictEqual(normalizePhone('+7 707 123 45 67'), '77071234567');
  assert.strictEqual(normalizePhone('7071234567'), '77071234567');
  assert.strictEqual(normalizePhone('77071234567'), '77071234567');
  assert.strictEqual(normalizePhone(''), '');
  assert.strictEqual(normalizePhone(undefined), '');
});

const answered = {
  call_uid: 'u1',
  direction: 'inbound',
  phone: '77071234567',
  started_at: '2026-11-06T12:00:00Z',
  answered_at: '2026-11-06T12:00:05Z',
  duration_sec: 42,
};
const missed = { ...answered, call_uid: 'u2', answered_at: null, duration_sec: 0 };

test('buildCallBody: отвеченный и пропущенный', () => {
  const [a] = buildCallBody(answered);
  assert.strictEqual(a.call_status, 4);
  assert.strictEqual(a.duration, 42);
  assert.strictEqual(a.phone, '+77071234567');
  assert.strictEqual(a.created_at, 1793966400);
  assert.strictEqual(a.link, undefined);

  const [m] = buildCallBody(missed);
  assert.strictEqual(m.call_status, 6);
  assert.strictEqual(m.call_result, 'Пропущенный');

  const [o] = buildCallBody({ ...missed, direction: 'outbound' });
  assert.strictEqual(o.call_result, 'Не дозвонился');

  const [r] = buildCallBody({ ...answered, recording_url: 'https://x/a.mp3' });
  assert.strictEqual(r.link, 'https://x/a.mp3');
});

test('buildUnsortedBody: структура и pipeline', () => {
  const [u] = buildUnsortedBody(answered, '123');
  assert.strictEqual(u.pipeline_id, 123);
  assert.strictEqual(u.metadata.uniq, 'u1');
  assert.strictEqual(u.metadata.phone, '+77071234567');
  assert.strictEqual(u._embedded.contacts[0].custom_fields_values[0].field_code, 'PHONE');
  assert.strictEqual(buildUnsortedBody(answered)[0].pipeline_id, undefined);
});
