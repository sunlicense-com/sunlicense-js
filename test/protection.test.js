// Tests for core unlock, integrity, the notice and protected files. Run: npm test (node --test)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SunLicense, SunLicenseProtection, Locked, Refused, mask } from '../src/index.js';
import { decodeBase64, detail, digest, normaliseDigest, open } from '../src/protection.js';

// SunLicense's protection test vectors (cloud/docs/specs/protection-test-vectors.json): copy the file again when it changes.
const V = JSON.parse(fs.readFileSync(new URL('./fixtures/protection-test-vectors.json', import.meta.url)));
const KEY = 'AX8P-QW3E-RT5Y-ZZ12';
const UNLOCK = V.wire.compatResponseV2.unlock;

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sunlicense-protection-'));

function make(o = {}) {
  const clock = o.clock || { t: 1762000000000 };
  return {
    clock,
    p: new SunLicenseProtection({
      licenseKey: KEY, fingerprint: 'machine-1', baseUrl: 'https://api.example.test', cacheDirectory: tmpDir(),
      now: () => clock.t, machine: () => 'host-a', ...o.options,
    }),
  };
}

test('HKDF matches RFC 5869 test case 1 and the product keys', () => {
  const t = V.rfc5869TestCase1;
  const okm = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(t.ikmHex, 'hex'), Buffer.from(t.saltHex, 'hex'), Buffer.from(t.infoHex, 'hex'), t.length));
  assert.equal(okm.toString('hex'), t.okmHex);
  for (const k of V.productKeys) {
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(k.orgSecretHex, 'hex'), k.saltAscii, k.infoAscii, 32));
    assert.equal(key.toString('base64'), k.productKeyBase64, k.name);
  }
});

for (const v of V.sealed) {
  test(`sealed vector opens: ${v.name}`, () => {
    const { data, digests } = open(v.sealed, Buffer.from(v.productKeyBase64, 'base64'));
    assert.deepEqual(data, Buffer.from(v.dataBase64, 'base64'));
    assert.deepEqual({ ...digests }, v.digests);
    // and sealing here gives the same bytes for the same nonce
    const nonce = Buffer.from(v.nonceHex, 'hex');
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(v.productKeyBase64, 'base64'), nonce);
    c.setAAD(Buffer.from('SLS1'));
    const ct = Buffer.concat([c.update(v.plaintextUtf8, 'utf8'), c.final(), c.getAuthTag()]);
    assert.equal('SLS1.' + Buffer.concat([nonce, ct]).toString('base64url'), v.sealed);
  });
}

for (const v of V.mustFail) {
  test(`must fail: ${v.name}`, () => {
    assert.throws(() => open(v.sealed, Buffer.from(v.productKeyBase64, 'base64')), Locked);
  });
}

test('digests, normalised input, padded base64url', () => {
  for (const d of V.digests) {
    if (d.inputUtf8) assert.equal(digest(Buffer.from(d.inputUtf8, 'utf8')), d.sha256Hex);
    if (d.inputBase64) assert.equal(digest(Buffer.from(d.inputBase64, 'base64')), d.sha256Hex);
    if (d.input) assert.equal(normaliseDigest(d.input), d.normalised);
  }
  const s = V.sealed[0].sealed;
  const padded = s + '='.repeat((4 - ((s.length - 5) % 4)) % 4);
  assert.ok(open(padded, Buffer.from(V.sealed[0].productKeyBase64, 'base64')));
  assert.throws(() => decodeBase64('a$b'));
});

test('locked until a valid answer with unlock; then unseal works and remembers digests', () => {
  const { p } = make();
  assert.equal(p.unlocked(), false);
  assert.throws(() => p.unseal(V.sealed[0].sealed), Locked);
  p.accept(JSON.stringify(V.wire.compatResponseV2));
  assert.equal(p.unlocked(), true);
  assert.deepEqual(p.unseal(V.sealed[0].sealed), Buffer.from(V.sealed[0].dataBase64, 'base64'));
  assert.deepEqual({ ...p.digests() }, V.sealed[0].digests);
});

test('v1 answers work; valid without unlock and unreadable answers keep what it had', () => {
  const { p } = make();
  p.accept(V.wire.validateResponseV1);
  assert.equal(p.unlocked(), true);
  p.accept('{"valid":true,"code":"VALID"}');
  p.accept('<html>502</html>');
  p.accept({ status: 401 });
  assert.equal(p.unlocked(), true);
});

test('a refused check forgets the unlock, in memory and on disk', () => {
  const { p } = make();
  p.accept(V.wire.compatResponseV2);
  assert.equal(fs.readdirSync(p.cacheDirectory).length, 1);
  p.accept({ valid: false, status: 403, code: 'SUSPENDED' });
  assert.equal(p.unlocked(), false);
  assert.equal(fs.readdirSync(p.cacheDirectory).length, 0);
});

test('the cache unlocks for 7 days on this machine with this key, and nowhere else', () => {
  const dir = tmpDir();
  const clock = { t: 1762000000000 };
  const at = (options = {}) => make({ clock, options: { cacheDirectory: dir, ...options } }).p;
  at().accept(V.wire.compatResponseV2);
  const [name] = fs.readdirSync(dir);
  assert.match(name, /^\.sunlicense-unlock-[0-9a-f]{16}$/);
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  assert.ok(text.startsWith('SLC1.') && !text.includes(UNLOCK));
  assert.equal(at().unlocked(), true);
  assert.equal(at({ machine: () => 'host-b' }).unlocked(), false);
  assert.equal(at({ fingerprint: 'machine-2' }).unlocked(), false);
  assert.equal(at({ licenseKey: 'OTHR-XXXX' }).unlocked(), false);
  clock.t = 1762000000000 + 7 * 86400000 - 60000;
  assert.equal(at().unlocked(), true);
  clock.t = 1762000000000 + 7 * 86400000;
  assert.equal(at().unlocked(), false);
  clock.t = 1762000000000 - 3600000;
  assert.equal(at().unlocked(), false, 'clock turned back');
  // memory only
  const memory = make({ options: { cacheDirectory: null } }).p;
  memory.accept(V.wire.compatResponseV2);
  assert.equal(memory.unlocked(), true);
});

test('the cache file is the same format as the other SDKs (SLC1, nonce || AES-GCM, "millis\\nbase64")', () => {
  const { p, clock } = make();
  p.accept(V.wire.compatResponseV2);
  const [name] = fs.readdirSync(p.cacheDirectory);
  const raw = decodeBase64(fs.readFileSync(path.join(p.cacheDirectory, name), 'utf8').slice(5));
  const key = crypto.createHash('sha256').update(`sunlicense-unlock-cache\0${KEY}\0machine-1\0host-a`).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString();
  assert.equal(plain, `${clock.t}\n${UNLOCK}`);
  assert.equal(name, '.sunlicense-unlock-' + digest(Buffer.from(`sunlicense-unlock-file\0${KEY}`)).slice(0, 16));
});

test('a new license key drops the unlock in memory', () => {
  const { p } = make({ options: { cacheDirectory: null } });
  p.accept(V.wire.compatResponseV2);
  p.license('NEWK-XXXX-XXXX-XXXX', 'machine-1');
  assert.equal(p.unlocked(), false);
});

test('integrity: OK, MODIFIED with the changed files, as validate fields; directories too', () => {
  const { p } = make();
  p.accept(V.wire.compatResponseV2);
  assert.equal(p.integrity(() => 'x'), null, 'nothing unsealed yet');
  p.unseal(V.sealed[2].sealed);
  const files = { 'Main.class': 'main', 'assets/rules.dat': 'rules', 'lib/util.jar': 'util' };
  assert.equal(p.integrity((f) => files[f] ?? null), 'OK');
  assert.deepEqual(p.validateFields(), { integrity: 'OK' });
  files['lib/util.jar'] = 'patched';
  delete files['Main.class'];
  assert.equal(p.integrity((f) => files[f] ?? null), 'MODIFIED');
  assert.equal(p.integrityResult(), 'MODIFIED');
  assert.deepEqual(p.validateFields(), { integrity: 'MODIFIED', integrityDetail: '2 changed: Main.class (missing), lib/util.jar' });

  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'Main.class'), 'main');
  fs.writeFileSync(path.join(dir, 'lib/util.jar'), 'util');
  const digests = { 'Main.class': digest(Buffer.from('main')), 'lib/util.jar': 'SHA256:' + digest(Buffer.from('util')).toUpperCase(), '../escape': 'x' };
  assert.equal(p.integrity(dir, digests), 'MODIFIED');
  assert.equal(p.validateFields().integrityDetail, '1 changed: ../escape (missing)');
  delete digests['../escape'];
  assert.equal(p.integrity(dir, digests), 'OK');
});

test('integrity detail stays within 200 characters', () => {
  const d = detail(Array.from({ length: 40 }, (_, i) => `lib/some-long-library-name-${String(i).padStart(2, '0')}.jar`));
  assert.ok(d.length <= 200);
  assert.match(d, /^40 changed: .*, \+\d+ more$/);
});

test('notice: product, owner, masked key, terms; never the full key', () => {
  const { p } = make({ options: { product: 'My Bot', owner: 'Example Studio', terms: 'https://example.com/terms' } });
  assert.equal(p.notice(), 'My Bot is licensed software by Example Studio. License AX8P-XXXX-XXXX-XXXX. Terms: https://example.com/terms');
  assert.equal(make().p.notice(), 'This product is licensed software. License AX8P-XXXX-XXXX-XXXX.');
  assert.equal(mask(null), '(none)');
  assert.equal(mask('ABCDEFGHIJ'), 'ABCDXXXXXX');
});

test('protected files: API key, license and machine headers; refusals say why', async () => {
  let seen;
  let answer = { status: 200, body: 'RULES' };
  const fetch = async (url, init) => {
    seen = { url, headers: init.headers };
    return { status: answer.status, arrayBuffer: async () => new TextEncoder().encode(answer.body).buffer };
  };
  const { p } = make({ options: { productCode: 'my bot', apiKey: 'sk_test', fetch } });
  assert.equal((await p.protectedFile('rules.dat')).toString(), 'RULES');
  assert.equal(seen.url, 'https://api.example.test/api/v2/protected-files/my%20bot/rules.dat');
  assert.deepEqual(seen.headers, { license: KEY, authorization: 'Bearer sk_test', fingerprint: 'machine-1' });
  answer = { status: 403, body: '{"code":"SUSPENDED"}' };
  await assert.rejects(p.protectedFile('rules.dat'), (e) => e instanceof Refused && e.status === 403 && /SUSPENDED/.test(e.message));
  answer = { status: 503, body: '' };
  await assert.rejects(p.protectedFile('rules.dat'), (e) => !(e instanceof Refused));
  await assert.rejects(make({ options: { fetch } }).p.protectedFile('x'), TypeError);
});

test('offline .lic: signed unlock works; bad signature, other key, expired or past refresh do not', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const lic = (payload, key = privateKey) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    return bytes.toString('base64url') + '.' + crypto.sign(null, bytes, key).toString('base64url');
  };
  const base = { format: 'sunlicense-offline/1', licenseKey: KEY, issuedAt: '2025-11-01T00:00:00Z', refreshAfter: '2025-11-20T00:00:00Z',
    policy: { expiresAt: '2026-01-01T00:00:00Z' }, unlock: UNLOCK };
  const at = () => make({ clock: { t: Date.parse('2025-11-10T00:00:00Z') }, options: { cacheDirectory: null } }).p;
  let p = at();
  assert.equal(p.acceptOffline(lic(base), pub), true);
  assert.equal(p.unlocked(), true);
  assert.equal(at().acceptOffline(lic(base, crypto.generateKeyPairSync('ed25519').privateKey), pub), false, 'signature');
  assert.equal(at().acceptOffline(lic({ ...base, licenseKey: 'OTHR-XXXX' }), pub), false, 'another key');
  assert.equal(at().acceptOffline(lic({ ...base, policy: { expiresAt: '2025-11-05T00:00:00Z' } }), pub), false, 'expired');
  assert.equal(at().acceptOffline(lic({ ...base, refreshAfter: '2025-11-09T00:00:00Z' }), pub), false, 'refresh');
  assert.equal(at().acceptOffline(lic({ ...base, unlock: undefined }), pub), false, 'no unlock');
  assert.equal(at().acceptOffline('garbage', pub), false);
});

test('client.validate sends integrity and keeps or forgets the unlock', async () => {
  const sent = [];
  const answers = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const a = answers.shift();
    return { ok: a.status < 300, status: a.status, json: async () => a.body };
  };
  try {
    const client = new SunLicense({ baseUrl: 'https://api.example.test', token: 'sk_test' });
    const p = client.protection({ cacheDirectory: tmpDir(), machine: () => 'host-a' });
    assert.equal(p.apiKey, 'sk_test');
    answers.push({ status: 200, body: V.wire.compatResponseV2 });
    const r = await client.validate(KEY, { fingerprint: 'machine-1' });
    assert.equal(r.valid, true);
    assert.equal(p.unlocked(), true);
    assert.equal(p.licenseKey, KEY);
    assert.equal(sent[0].integrity, undefined);
    p.unseal(V.sealed[0].sealed);
    assert.equal(p.integrity(() => 'not the jar'), 'MODIFIED');
    answers.push({ status: 403, body: { valid: false, status: 403, code: 'SUSPENDED' } });
    assert.equal((await client.validate(KEY, { fingerprint: 'machine-1' })).valid, false);
    assert.equal(sent[1].integrity, 'MODIFIED');
    assert.equal(sent[1].integrityDetail, '1 changed: plugin.jar');
    assert.equal(p.unlocked(), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
