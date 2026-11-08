import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTrailing } from '../src/util.js';

test('stripTrailing drops only trailing copies of the character', () => {
  assert.equal(stripTrailing('https://api.sunlicense.com///', '/'), 'https://api.sunlicense.com');
  assert.equal(stripTrailing('YWJj==', '='), 'YWJj');
  assert.equal(stripTrailing('////', '/'), '');
  assert.equal(stripTrailing('a/b', '/'), 'a/b');
});

test('stripTrailing is linear on long inputs', () => {
  const s = '/'.repeat(200000) + 'x';
  const t0 = Date.now();
  assert.equal(stripTrailing(s, '/'), s);
  assert.ok(Date.now() - t0 < 100);
});
