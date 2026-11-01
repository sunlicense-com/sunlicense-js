// Tests for built-in product analytics. Run: npm test (node --test)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SunLicense, SunLicenseAnalytics } from '../src/index.js';
import { SDK_NAME, SDK_VERSION, collect, firstDelay, macVersion, nextDelay } from '../src/analytics.js';

// SunLicense's conformance fixtures (spec 185 §4.8, analytics-service/src/test/resources/conformance/reports.json):
// copy the file again when it changes.
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/conformance-reports.json', import.meta.url)));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunlicense-analytics-'));
}

/** A fetch that records requests and answers with `status` (and Retry-After). */
function recorder(status = 204, retryAfter = null) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { status, headers: new Map(retryAfter == null ? [] : [['retry-after', retryAfter]]) };
  };
  fn.seen = seen;
  return fn;
}

const off = () => undefined;

for (const c of fixtures.cases) {
  test(`conformance: sends the request side of "${c.name}"`, async () => {
    const r = c.report;
    const { productVersion, ...system } = r.metrics;
    const dir = tmpDir();
    if (r.installId) fs.writeFileSync(path.join(dir, '.sunlicense-install-id'), r.installId);
    const fetch = recorder();
    const analytics = SunLicenseAnalytics.create({
      baseUrl: 'https://api.example.test/',
      apiKey: c.licensed ? 'slk_test' : undefined,
      licenseKey: r.licenseKey,
      fingerprint: r.fingerprint,
      productAnalyticsId: r.productAnalyticsId,
      dataDirectory: dir,
      productVersion,
      _collect: () => system,
      _env: off,
      _fetch: fetch,
    });
    assert.equal(await analytics.sendNow(), 204);
    assert.equal(fetch.seen.length, 1);
    const sent = fetch.seen[0];
    assert.equal(sent.url, 'https://api.example.test/api/v2/analytics/report');
    assert.deepEqual(sent.body, { ...r, schema: 1, sdk: { name: SDK_NAME, version: SDK_VERSION } });
    assert.equal(sent.headers.authorization, c.licensed ? 'Bearer slk_test' : undefined);
    assert.equal(sent.headers['content-type'], 'application/json');
    assert.match(sent.headers['user-agent'], /^sunlicense-js\/\d+\.\d+\.\d+ analytics$/);
  });
}

test('collects raw built-in metrics from this machine, nothing personal', async () => {
  const fetch = recorder();
  const analytics = SunLicenseAnalytics.create({ productAnalyticsId: 'pa_test', dataDirectory: tmpDir(), productVersion: 'v1.2.3', _env: off, _fetch: fetch });
  await analytics.sendNow();
  const { body } = fetch.seen[0];
  assert.equal(body.metrics.productVersion, 'v1.2.3');
  assert.equal(body.metrics.runtime, 'node');
  assert.equal(body.metrics.runtimeVersion, process.versions.node);
  assert.equal(body.metrics.platform, 'standalone');
  assert.ok(Number.isInteger(body.metrics.cores) && body.metrics.cores >= 1);
  assert.ok(body.metrics.os && body.metrics.arch);
  const json = JSON.stringify(body);
  for (const personal of [os.hostname(), os.userInfo().username, process.cwd(), os.homedir()]) {
    assert.ok(!json.includes(personal), `report must not contain ${personal}`);
  }
});

test('platform override and macOS / Windows names', () => {
  const m = collect({ name: 'MyEngine', version: '4.2' });
  assert.equal(m.platform, 'myengine');
  assert.equal(m.platformVersion, '4.2');
  assert.equal(macVersion('23.5.0'), '14.5');
  assert.equal(macVersion('19.6.0'), '10.15');
  assert.equal(macVersion('25.0.0'), '26.0');
  assert.equal(macVersion('26.1.0'), '27.1');
  assert.equal(macVersion('nonsense'), null);
});

test('client.analytics uses the client base URL and API key; SunLicense.analytics takes a product analytics id', async () => {
  const client = new SunLicense({ baseUrl: 'https://api.example.test', token: 'slk_x' });
  const a = client.analytics({ licenseKey: 'K', fingerprint: 'f', enabled: false });
  assert.equal(a._endpoint, 'https://api.example.test/api/v2/analytics/report');
  assert.equal(a._apiKey, 'slk_x');
  assert.equal(a.isEnabled(), false);
  a.close();
  const free = SunLicense.analytics('pa_abc', { enabled: false });
  assert.equal(free._productAnalyticsId, 'pa_abc');
  free.close();
});

test('opt-out: product switch, SUNLICENSE_ANALYTICS, unreadable switch; nothing is sent', async () => {
  const cases = [
    { enabled: false },
    { enabled: () => false },
    { enabled: () => { throw new Error('config gone'); } },
    { _env: (n) => (n === 'SUNLICENSE_ANALYTICS' ? 'off' : undefined) },
    { _env: (n) => (n === 'SUNLICENSE_ANALYTICS' ? ' FALSE ' : undefined) },
    { _env: (n) => (n === 'SUNLICENSE_ANALYTICS' ? '0' : undefined) },
  ];
  for (const extra of cases) {
    const fetch = recorder();
    const a = SunLicenseAnalytics.create({ productAnalyticsId: 'pa_x', dataDirectory: tmpDir(), _env: off, _fetch: fetch, ...extra });
    assert.equal(a.isEnabled(), false);
    assert.equal(await a.sendNow(), 0);
    assert.equal(fetch.seen.length, 0);
  }
  // switched back on at runtime
  let on = false;
  const fetch = recorder();
  const a = SunLicenseAnalytics.create({ productAnalyticsId: 'pa_x', dataDirectory: tmpDir(), enabled: () => on, _env: off, _fetch: fetch });
  assert.equal(await a.sendNow(), 0);
  on = true;
  assert.equal(await a.sendNow(), 204);
});

test('no identity: nothing sent; licensed needs API key, license key and machine id', async () => {
  const fetch = recorder();
  assert.equal(await SunLicenseAnalytics.create({ _env: off, _fetch: fetch }).sendNow(), 0);
  assert.equal(await SunLicenseAnalytics.create({ apiKey: 'slk', fingerprint: 'f', _env: off, _fetch: fetch }).sendNow(), 0);
  let key = null;
  const later = SunLicenseAnalytics.create({ apiKey: 'slk', fingerprint: 'f', licenseKey: () => key, _env: off, _fetch: fetch });
  assert.equal(await later.sendNow(), 0);
  key = ' AX8P-4Q2M ';
  assert.equal(await later.sendNow(), 204);
  assert.equal(fetch.seen[0].body.licenseKey, 'AX8P-4Q2M');
  assert.equal(fetch.seen[0].body.installId, undefined);
});

test('never throws: network errors, a throwing fetch, broken suppliers', async () => {
  const a = SunLicenseAnalytics.create({
    productAnalyticsId: 'pa_x', dataDirectory: tmpDir(), productVersion: () => { throw new Error('x'); },
    _env: off, _fetch: () => { throw new Error('boom'); },
  });
  assert.equal(await a.sendNow(), -1);
  const b = SunLicenseAnalytics.create({ productAnalyticsId: 'pa_x', dataDirectory: tmpDir(), _env: off, _fetch: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(await b.sendNow(), -1);
  assert.doesNotThrow(() => SunLicenseAnalytics.start(null).close());
});

test('schedule: first report in 1-30 minutes, then 30 minutes, Retry-After between 1 minute and 24 hours', () => {
  assert.equal(firstDelay(() => 0), 60_000);
  assert.equal(firstDelay(() => 0.999999), 30 * 60_000);
  assert.equal(nextDelay(204, '86400'), 30 * 60_000);
  assert.equal(nextDelay(-1, null), 30 * 60_000);
  assert.equal(nextDelay(400, null), 30 * 60_000);
  assert.equal(nextDelay(429, '120'), 120_000);
  assert.equal(nextDelay(429, '5'), 60_000);
  assert.equal(nextDelay(403, '999999'), 24 * 3600_000);
  assert.equal(nextDelay(503, 'Wed, 21 Oct 2026 07:28:00 GMT'), 30 * 60_000);
});

test('install id is created once and kept in the data directory', async () => {
  const dir = tmpDir();
  const fetch = recorder();
  await SunLicenseAnalytics.create({ productAnalyticsId: 'pa_x', dataDirectory: dir, _env: off, _fetch: fetch }).sendNow();
  await SunLicenseAnalytics.create({ productAnalyticsId: 'pa_x', dataDirectory: dir, _env: off, _fetch: fetch }).sendNow();
  const id = fs.readFileSync(path.join(dir, '.sunlicense-install-id'), 'utf8');
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(fetch.seen[0].body.installId, id);
  assert.equal(fetch.seen[1].body.installId, id);
});

test('a report over 16 KB keeps only the built-in parts', async () => {
  const fetch = recorder();
  const a = SunLicenseAnalytics.create({ productAnalyticsId: 'pa_x', dataDirectory: tmpDir(), _env: off, _fetch: fetch });
  const features = {};
  for (let i = 0; i < 2000; i++) features[`feature-${i}`] = i + 1;
  a._add({ write: (r) => { r.features = features; } });
  a._add({ write: () => { throw new Error('broken section'); } });
  assert.equal(await a.sendNow(), 204);
  assert.equal(fetch.seen[0].body.features, undefined);
  assert.ok(fetch.seen[0].body.metrics);
});

test('reports in the background to a real HTTP server, and close() stops it', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      bodies.push({ path: req.url, ua: req.headers['user-agent'], body: JSON.parse(data) });
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const a = SunLicenseAnalytics.start({ baseUrl: `http://127.0.0.1:${port}`, productAnalyticsId: 'pa_bg', dataDirectory: tmpDir(), _env: off, _firstDelayMs: 10 });
  for (let i = 0; i < 100 && bodies.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  a.close();
  server.close();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].path, '/api/v2/analytics/report');
  assert.equal(bodies[0].body.productAnalyticsId, 'pa_bg');
  assert.equal(bodies[0].body.sdk.name, 'js');
});
