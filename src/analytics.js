/**
 * Built-in product analytics: every 30 minutes, in the background, this install tells SunLicense its
 * product version, OS, architecture, CPU cores, locale, runtime (Node, Bun, Deno) and platform (a Discord
 * bot, a FiveM server, Electron or standalone). Sellers see the totals on the product's Analytics tab.
 *
 * @example
 * // A licensed product: the same API key, license key and machine id it validates with.
 * const analytics = client.analytics({ licenseKey, fingerprint: machineId, productVersion: '2.3.1',
 *                                      enabled: config.analytics !== false });
 * // A free product: its public product analytics id (Product → Analytics), no license needed.
 * const analytics = SunLicense.analytics('pa_7Hk2mQ9xZr4LbN8vT1wYcD', { dataDirectory: './data' });
 * // On shutdown:
 * analytics.close();
 *
 * It never blocks, delays or fails a license check and never throws: errors are swallowed. Its timers
 * don't keep the process alive. Nothing is sent while the product's `enabled` switch is off or the
 * environment variable SUNLICENSE_ANALYTICS is off/false/0 (FiveM: the convar sunlicense_analytics);
 * each is checked before every report. No personal data is sent: no user names, host names, IP
 * addresses, file paths or player names.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Sent as sdk.name/sdk.version; bump the version with each release. */
export const SDK_NAME = 'js';
export const SDK_VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://api.sunlicense.com';
/** Environment variable (and FiveM convar sunlicense_analytics) that switches analytics off on a machine. */
export const ENV_SWITCH = 'SUNLICENSE_ANALYTICS';

const PATH = '/api/v2/analytics/report';
const INTERVAL = 30 * 60_000;
const MIN_WAIT = 60_000;
const MAX_WAIT = 24 * 3600_000;
const TIMEOUT = 10_000;
const MAX_BODY = 16 * 1024;
const INSTALL_ID_FILE = '.sunlicense-install-id';
/** Report keys every report keeps; feature usage and custom charts go first when a report is too big. */
const CORE_KEYS = ['schema', 'licenseKey', 'fingerprint', 'productAnalyticsId', 'installId', 'sdk', 'metrics'];
const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const OFF = new Set(['off', 'false', '0', 'no', 'disabled']);

export class SunLicenseAnalytics {
  /**
   * Starts reporting in the background (first report in 1–30 minutes). Never throws.
   *
   * @param {object} options
   * @param {string} [options.baseUrl='https://api.sunlicense.com']
   * @param {string} [options.apiKey]  Licensed products: the API key the product validates with (slk_…).
   * @param {string|(() => string)} [options.licenseKey]  Licensed products: the license key (a function is read before each report).
   * @param {string} [options.fingerprint]  Licensed products: the machine id it validates with (`host`).
   * @param {string} [options.productAnalyticsId]  The product's public analytics id (pa_…): all a free product needs.
   * @param {string} [options.dataDirectory]  Where the random install id is kept (file .sunlicense-install-id). Default ~/.sunlicense.
   * @param {string|(() => string)} [options.productVersion]
   * @param {{name: string, version?: string}} [options.platform]  Overrides the detected platform.
   * @param {boolean|(() => boolean)} [options.enabled=true]  The product's own switch; false = nothing is sent.
   * @returns {SunLicenseAnalytics}
   */
  static start(options = {}) {
    try {
      return new SunLicenseAnalytics(options)._begin();
    } catch {
      return new SunLicenseAnalytics({ enabled: false });
    }
  }

  /** A reporter that isn't started: it only sends when you call sendNow() (tests, one-off scripts). */
  static create(options = {}) {
    return new SunLicenseAnalytics(options);
  }

  constructor(options = {}) {
    const o = options || {};
    this._endpoint = String(o.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') + PATH;
    this._apiKey = clean(o.apiKey, 512);
    this._licenseKey = supplier(o.licenseKey);
    this._fingerprint = clean(o.fingerprint, 255);
    this._productAnalyticsId = clean(o.productAnalyticsId, 64);
    this._productVersion = supplier(o.productVersion);
    this._platform = o.platform && o.platform.name ? o.platform : null;
    this._enabled = o.enabled === undefined ? () => true : typeof o.enabled === 'function' ? o.enabled : () => !!o.enabled;
    const dir = o.dataDirectory || path.join(safe(() => os.homedir()) || '.', '.sunlicense');
    this._installIdFile = path.join(String(dir), INSTALL_ID_FILE);
    // Test seams (not part of the public API).
    this._env = o._env || ((name) => safe(() => process.env[name]));
    this._fetch = o._fetch || ((...args) => fetch(...args));
    this._random = o._random || Math.random;
    this._firstDelay = o._firstDelayMs;
    this._collect = o._collect;
    this._sections = [];
    this._closed = false;
    this._timer = null;
    this._lastOutcome = null;
    this._debug = o.debug === true;
  }

  /** True unless the product's switch or SUNLICENSE_ANALYTICS turns it off. */
  isEnabled() {
    return !this._optedOut();
  }

  /** Stops reporting. Call it when the product shuts down. */
  close() {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  /**
   * Sends one report now and resolves to the HTTP status (204 = stored, 0 = nothing sent because analytics
   * is off or the product isn't identified, -1 = no answer). Never rejects. For tests and scripts; a
   * product leaves it to the schedule.
   */
  async sendNow() {
    try {
      return (await this._send()).status;
    } catch {
      return -1;
    }
  }

  /** @internal Something that adds to each report (feature usage, custom charts) and hears whether it was taken. */
  _add(section) {
    this._sections.push(section);
    return this;
  }

  _begin() {
    if (!this._productAnalyticsId && !(this._apiKey && this._fingerprint)) {
      this._outcome('no-identity', 'no product analytics id, and no API key and machine id: not reporting');
      return this;
    }
    this._schedule(this._firstDelay ?? firstDelay(this._random));
    return this;
  }

  _schedule(ms) {
    if (this._closed) return;
    this._timer = setTimeout(() => this._tick(), ms);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  async _tick() {
    let next = INTERVAL;
    try {
      const answer = await this._send();
      next = nextDelay(answer.status, answer.retryAfter);
    } catch (e) {
      this._outcome('error', 'report failed: ' + e);
    } finally {
      this._schedule(next);
    }
  }

  async _send() {
    if (this._closed) return { status: 0 };
    if (this._optedOut()) {
      this._outcome('off', 'analytics is switched off; nothing sent');
      return { status: 0 };
    }
    const report = this._report();
    if (!report) {
      this._outcome('no-identity', 'no license key yet and no product analytics id; nothing sent');
      return { status: 0 };
    }
    let body = JSON.stringify(report);
    if (Buffer.byteLength(body) > MAX_BODY) {
      for (const key of Object.keys(report)) if (!CORE_KEYS.includes(key)) delete report[key];
      body = JSON.stringify(report);
    }
    const headers = {
      'content-type': 'application/json',
      'user-agent': `sunlicense-${SDK_NAME}/${SDK_VERSION} analytics`,
    };
    if (report.licenseKey) headers.authorization = `Bearer ${this._apiKey}`;
    let answer;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await this._fetch(this._endpoint, { method: 'POST', headers, body, signal: controller.signal });
      answer = { status: res.status, retryAfter: res.headers && res.headers.get ? res.headers.get('retry-after') : null };
      try { await res.arrayBuffer?.(); } catch { /* body not needed */ }
    } catch {
      answer = { status: -1, retryAfter: null };
    } finally {
      clearTimeout(timer);
    }
    const accepted = answer.status === 204;
    for (const s of this._sections) {
      try { s.sent?.(accepted); } catch { /* a section's bookkeeping never stops reporting */ }
    }
    if (accepted) this._outcome('204', 'report accepted');
    else if (answer.status < 0) this._outcome('no-answer', "SunLicense didn't answer; next report in 30 minutes");
    else this._outcome('http-' + answer.status, `report answered HTTP ${answer.status}; next in ${nextDelay(answer.status, answer.retryAfter) / 1000} s`);
    return answer;
  }

  _optedOut() {
    if (isOff(this._env(ENV_SWITCH))) return true;
    if (typeof globalThis.GetConvar === 'function' && isOff(safe(() => globalThis.GetConvar('sunlicense_analytics', 'on')))) return true;
    try {
      return !this._enabled();
    } catch {
      return true; // a config that can't be read counts as off
    }
  }

  /** The report body, or null when this install can't say who it is yet. */
  _report() {
    const key = clean(get(this._licenseKey), 128);
    const licensed = !!(key && this._apiKey && this._fingerprint);
    if (!licensed && !this._productAnalyticsId) return null;
    const r = { schema: 1 };
    if (licensed) {
      r.licenseKey = key;
      r.fingerprint = this._fingerprint;
    }
    if (this._productAnalyticsId) {
      r.productAnalyticsId = this._productAnalyticsId;
      r.installId = this._installId(); // also with a license: an unknown key then still counts
    }
    r.sdk = { name: SDK_NAME, version: SDK_VERSION };
    const metrics = {};
    put(metrics, 'productVersion', clean(get(this._productVersion), 64));
    Object.assign(metrics, this._systemMetrics());
    r.metrics = metrics;
    for (const s of this._sections) {
      try { s.write(r); } catch { /* a broken section is left out, the built-in metrics still go */ }
    }
    return r;
  }

  _systemMetrics() {
    if (!this._metrics) {
      this._metrics = this._collect ? this._collect() : collect(this._platform || detectPlatform());
    }
    return this._metrics;
  }

  _installId() {
    if (this._id) return this._id;
    try {
      const stored = fs.readFileSync(this._installIdFile, 'utf8').trim();
      if (INSTALL_ID.test(stored)) return (this._id = stored);
    } catch { /* missing or unreadable: make a new one */ }
    this._id = randomUUID();
    try {
      fs.mkdirSync(path.dirname(this._installIdFile), { recursive: true });
      fs.writeFileSync(this._installIdFile, this._id);
    } catch { /* read-only disk: this run still has an id */ }
    return this._id;
  }

  _outcome(kind, message) {
    if (kind !== this._lastOutcome) {
      this._lastOutcome = kind;
      if (this._debug) console.debug('SunLicense analytics: ' + message);
    }
  }
}

/** First report after a random 1–30 minutes, so a fleet restarted together doesn't report together. */
export function firstDelay(random = Math.random) {
  return (60 + Math.floor(random() * (29 * 60 + 1))) * 1000;
}

/** 30 minutes after a 204 or no answer; else the server's Retry-After, between 1 minute and 24 hours. */
export function nextDelay(status, retryAfter) {
  if (status === 204 || retryAfter == null) return INTERVAL;
  const seconds = Number(String(retryAfter).trim());
  if (!Number.isFinite(seconds) || String(retryAfter).trim() === '') return INTERVAL;
  return Math.min(MAX_WAIT, Math.max(MIN_WAIT, Math.max(0, seconds) * 1000));
}

export function isOff(value) {
  return value != null && OFF.has(String(value).trim().toLowerCase());
}

/** Raw values; the server maps them to families and majors. */
export function collect(platform) {
  const m = {};
  const type = safe(() => os.type()) || '';
  const release = safe(() => os.release());
  if (/darwin/i.test(type)) {
    put(m, 'os', 'Mac OS X');
    put(m, 'osVersion', clean(macProductVersion() || macVersion(release), 64));
  } else if (/windows/i.test(type)) {
    // os.version() is "Windows 11 Pro" / "Windows Server 2022 Datacenter": the edition is dropped server-side
    put(m, 'os', clean(windowsName(safe(() => os.version())), 64) || 'Windows');
    put(m, 'osVersion', clean(release, 64));
  } else {
    put(m, 'os', clean(type, 64));
    put(m, 'osVersion', clean(release, 64));
  }
  const arch = safe(() => process.arch);
  put(m, 'arch', clean(arch === 'ia32' ? 'x86' : arch, 64));
  const cores = safe(() => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length));
  if (Number.isInteger(cores) && cores > 0) m.cores = Math.min(1024, cores);
  put(m, 'locale', clean(safe(() => Intl.DateTimeFormat().resolvedOptions().locale), 64));
  const [runtime, runtimeVersion] = detectRuntime();
  m.runtime = runtime;
  put(m, 'runtimeVersion', clean(runtimeVersion, 64));
  if (platform) {
    put(m, 'platform', clean(platform.name && String(platform.name).toLowerCase(), 32));
    put(m, 'platformVersion', clean(platform.version, 64));
  }
  return m;
}

/** The macOS version from the system's version file (only the version is read and sent). */
function macProductVersion() {
  const plist = safe(() => fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8'));
  const match = plist && /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  return match ? match[1] : null;
}

/** From the kernel version: Darwin 23.5.0 is macOS 14.5, Darwin 25.0.0 macOS 26.0, Darwin 19.6.0 macOS 10.15. */
export function macVersion(darwin) {
  const match = /^(\d+)\.(\d+)/.exec(String(darwin || ''));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 25) return `${major + 1}.${minor}`;
  return major >= 20 ? `${major - 9}.${minor}` : major >= 5 ? `10.${major - 4}` : null;
}

function windowsName(version) {
  const match = /^windows\s+(server\s+)?(\d{1,4})\b/i.exec(String(version || ''));
  return match ? `Windows ${match[1] ? 'Server ' : ''}${match[2]}` : null;
}

function detectRuntime() {
  if (typeof globalThis.Bun !== 'undefined') return ['bun', safe(() => globalThis.Bun.version)];
  if (typeof globalThis.Deno !== 'undefined') return ['deno', safe(() => globalThis.Deno.version.deno)];
  return ['node', safe(() => process.versions.node)];
}

/** What the product runs on: a FiveM/RedM server, a Discord bot, Electron, else standalone. */
export function detectPlatform() {
  try {
    if (typeof globalThis.GetConvar === 'function' && typeof globalThis.GetCurrentResourceName === 'function') {
      const game = safe(() => globalThis.GetConvar('gamename', 'gta5'));
      const build = /v\d+\.\d+\.\d+\.(\d+)/.exec(safe(() => globalThis.GetConvar('version', '')) || '');
      return { name: game === 'rdr3' ? 'redm' : 'fivem', version: build ? build[1] : null };
    }
    const electron = safe(() => process.versions.electron);
    if (electron) return { name: 'electron', version: electron };
    for (const lib of ['discord.js', 'eris', 'oceanic.js', 'discordeno']) {
      const version = packageVersion(lib);
      if (version) return { name: 'discord', version };
    }
  } catch { /* fall through */ }
  return { name: 'standalone', version: null };
}

/** The version of a package the product has installed (resolved from the working directory), or null. */
function packageVersion(name) {
  return safe(() => createRequire(path.join(process.cwd(), 'index.js'))(`${name}/package.json`).version);
}

// ---- values ----

/** Trimmed, control characters removed, cut at max; null when empty. */
export function clean(value, max) {
  if (value == null) return null;
  // eslint-disable-next-line no-control-regex
  let s = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!s) return null;
  if (s.length > max) {
    const end = /[\ud800-\udbff]/.test(s[max - 1]) ? max - 1 : max;
    s = s.slice(0, end).trim();
  }
  return s || null;
}

function supplier(value) {
  return typeof value === 'function' ? value : () => value;
}

function get(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function put(m, key, value) {
  if (value != null) m[key] = value;
}

export default SunLicenseAnalytics;
