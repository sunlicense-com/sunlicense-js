/**
 * Protection for a licensed product: core unlock, tamper reports, the ownership notice and protected files.
 * The same behaviour as the Java SDK's SunLicenseProtection, in JavaScript's idiom.
 *
 * @example
 * const client = new SunLicense({ baseUrl: 'https://api.sunlicense.com', token: process.env.SUNLICENSE_API_KEY });
 * const protection = client.protection({
 *   licenseKey, fingerprint: machineId,
 *   product: 'My Bot', owner: 'Example Studio', terms: 'https://example.com/terms',
 *   productCode: 'my-bot',            // for protected files
 *   cacheDirectory: './data',         // where the 7-day unlock cache lives
 * });
 * console.log(protection.notice());   // one line: product, owner, masked key
 * await client.validate(licenseKey, { fingerprint: machineId });  // sends integrity, keeps or forgets the unlock
 * const core = protection.unseal(SEALED_CORE);                     // throws Locked without a valid unlock
 * protection.integrity(path.dirname(fileURLToPath(import.meta.url)));  // 'OK' / 'MODIFIED', sent with the next check
 * const rules = await protection.protectedFile('rules.dat');      // Standard plan
 *
 * Core unlock: `sunlicense seal` encrypts part of the product (its "core") under a key only SunLicense holds. A
 * valid license check answers with that key (`unlock`); a rejected one (suspended, expired, revoked...) doesn't,
 * and the unlock this install had is forgotten. So a copy whose license check was cut out can't run its core. To
 * keep working through outages the unlock from the last valid check is cached on disk for 7 days, encrypted with a
 * key derived from the license key, the machine id and this machine; an offline license file (.lic) carries it too.
 *
 * Honest limit: someone with a valid license can still extract the unlock and patch their copy; that copy then
 * fails its integrity check and is reported. Protection raises the cost and makes leaks visible.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTrailing } from './util.js';

export const DEFAULT_BASE_URL = 'https://api.sunlicense.com';
/** How long the unlock from the last valid check keeps working without an answer from SunLicense (ms). */
export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const SKEW_MS = 10 * 60 * 1000;
const SEALED_PREFIX = 'SLS1.';
const SEALED_AAD = Buffer.from('SLS1', 'ascii');
const CACHE_PREFIX = 'SLC1.';
const CACHE_FILE = '.sunlicense-unlock-';
const MAX_DETAIL = 200;

/** No unlock: the license wasn't confirmed valid (online, cached or offline), or the data was sealed for another product. */
export class Locked extends Error {
  constructor(message) {
    super(message);
    this.name = 'Locked';
  }
}

/** A protected file SunLicense refused (license not valid, file missing, plan without protected files). */
export class Refused extends Error {
  /** @param {number} status 401/403 refused, 404 no such file, 402 plan without protected files */
  constructor(status, message) {
    super(message);
    this.name = 'Refused';
    this.status = status;
  }
}

const trim = (s) => (s == null || String(s).trim() === '' ? null : String(s).trim());

/** Base64 in any flavour the server may send: url-safe or standard, with or without padding. */
export function decodeBase64(s) {
  const t = stripTrailing(String(s).trim().replace(/-/g, '+').replace(/_/g, '/'), '=');
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) throw new TypeError('not base64');
  return Buffer.from(t, 'base64');
}

/** Lowercase hex SHA-256. */
export function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** A digest as compared: lowercase, without a "sha256:" prefix. */
export function normaliseDigest(d) {
  return String(d).trim().toLowerCase().replace(/^sha256:/, '');
}

/** "AX8P-XXXX-XXXX-XXXX": the first group, the rest as X. */
export function mask(key) {
  const k = trim(key);
  if (!k) return '(none)';
  const groups = k.split('-');
  if (groups.length === 1) return k.slice(0, 4) + 'X'.repeat(Math.max(0, k.length - 4));
  return [groups[0], ...groups.slice(1).map((g) => 'X'.repeat(g.length))].join('-');
}

/** "N changed: a, b, +3 more", at most 200 characters (sent as integrityDetail). */
export function detail(changed) {
  let b = `${changed.length} changed: `;
  let shown = 0;
  for (const c of changed) {
    const next = (shown === 0 ? '' : ', ') + c;
    const reserve = shown + 1 < changed.length ? 16 : 0;
    if (b.length + next.length + reserve > MAX_DETAIL) break;
    b += next;
    shown++;
  }
  if (shown < changed.length) b += (shown === 0 ? '' : ', ') + '+' + (changed.length - shown) + ' more';
  return b.slice(0, MAX_DETAIL);
}

/**
 * Opens an `SLS1.` blob: 'SLS1.' + base64url(nonce 12 || AES-256-GCM ciphertext || tag 16), AAD 'SLS1', plaintext
 * JSON {"v":1,"digests":{path: sha256hex},"data":"<base64>"}. Throws Locked on a wrong key or changed data.
 * @returns {{data: Buffer, digests: Record<string, string>}}
 */
export function open(sealed, key) {
  const s = trim(sealed);
  if (!s || !s.startsWith(SEALED_PREFIX)) throw new Locked(`Not sealed data: expected text starting with ${SEALED_PREFIX}`);
  let raw;
  try {
    raw = decodeBase64(s.slice(SEALED_PREFIX.length));
  } catch {
    throw new Locked('Not sealed data: not base64url');
  }
  if (raw.length < 12 + 16) throw new Locked('Not sealed data: too short');
  let plain;
  try {
    const d = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, raw.subarray(0, 12));
    d.setAAD(SEALED_AAD);
    d.setAuthTag(raw.subarray(raw.length - 16));
    plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
  } catch {
    throw new Locked("This data wasn't sealed for this product's unlock (sealed for another product, or re-sealed since).");
  }
  let m;
  try {
    m = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Locked("Not sealed data: sealed content isn't readable");
  }
  if (!m || typeof m.data !== 'string') throw new Locked('Not sealed data: sealed content has no data');
  const digests = {};
  if (m.digests && typeof m.digests === 'object') {
    for (const p of Object.keys(m.digests).sort()) {
      if (typeof m.digests[p] === 'string') digests[p] = m.digests[p].toLowerCase();
    }
  }
  return { data: decodeBase64(m.data), digests: Object.freeze(digests) };
}

/** SHA-256 of the OS, architecture, host name and hardware addresses: what makes a copied cache file useless elsewhere. */
export function machineId() {
  let raw = `${os.platform()}|${os.arch()}`;
  try {
    raw += `|${os.hostname()}`;
  } catch {
    raw += '|?';
  }
  try {
    const macs = new Set();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.add(ni.mac.replace(/:/g, '').toLowerCase());
      }
    }
    raw += '|' + [...macs].sort().join(',');
  } catch {
    raw += '|?';
  }
  return digest(Buffer.from(raw, 'utf8'));
}

function validKeyLength(k) {
  return k.length === 16 || k.length === 24 || k.length === 32;
}

export class SunLicenseProtection {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]  Default https://api.sunlicense.com.
   * @param {string} [options.apiKey]  Your API key (protected files).
   * @param {string} [options.licenseKey]  The license key this install checks with.
   * @param {string} [options.fingerprint]  The machine id it checks with.
   * @param {string} [options.productCode]  The product's code in SunLicense (protected files).
   * @param {string} [options.product]  Product name for notice().
   * @param {string} [options.owner]  Owner (seller) name for notice().
   * @param {string} [options.terms]  Terms link notice() ends with.
   * @param {string|null} [options.cacheDirectory]  Where the unlock cache is kept; null = memory only. Default ~/.sunlicense.
   */
  constructor(options = {}) {
    this.baseUrl = stripTrailing(String(options.baseUrl || DEFAULT_BASE_URL), '/');
    this.apiKey = trim(options.apiKey);
    this.licenseKey = trim(options.licenseKey);
    this.fingerprint = trim(options.fingerprint);
    this.productCode = trim(options.productCode);
    this.productName = trim(options.product);
    this.owner = trim(options.owner);
    this.terms = trim(options.terms);
    this.cacheDirectory = options.cacheDirectory === undefined ? path.join(os.homedir(), '.sunlicense') : options.cacheDirectory;
    this._now = options.now || Date.now;
    this._machine = options.machine || machineId;
    this._fetch = options.fetch || ((...a) => fetch(...a));
    this._unlock = null;
    this._digests = Object.freeze({});
    this._integrity = null;
    this._integrityDetail = null;
  }

  // ---- license and answers ----

  /** The license key and machine id this install checks with; a different key drops the unlock held in memory. */
  license(licenseKey, fingerprint) {
    const key = trim(licenseKey);
    if (key == null || key !== this.licenseKey) this._unlock = null;
    this.licenseKey = key;
    this.fingerprint = trim(fingerprint);
  }

  /**
   * Reads a license check's answer (the JSON body, as text or parsed, of /api/v2/license/validate or
   * /api/v1/validate). A valid answer with `unlock` keeps and caches it; a definite "no" (valid: false) forgets it.
   * Anything unreadable is ignored (treat that like no answer). Never throws.
   */
  accept(body) {
    let parsed = body;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      try {
        parsed = JSON.parse(String(body));
      } catch {
        return;
      }
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.valid === true) this.acceptAnswer(true, typeof parsed.unlock === 'string' ? parsed.unlock : null);
    else if (parsed.valid === false) this.acceptAnswer(false);
  }

  /** Same as accept() for an answer already read: valid with its unlock (or null), or rejected. */
  acceptAnswer(valid, unlockBase64 = null) {
    if (!valid) {
      this.rejected();
      return;
    }
    if (!trim(unlockBase64)) return; // valid, but the product has nothing sealed: keep what we have
    let key;
    try {
      key = Buffer.from(String(unlockBase64).trim(), 'base64');
    } catch {
      return;
    }
    if (!validKeyLength(key)) return;
    this._unlock = key;
    this._writeCache(key);
  }

  /** SunLicense said no: the unlock (in memory and on disk) is gone until the next valid check. */
  rejected() {
    this._unlock = null;
    const file = this._cacheFile();
    if (file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // nothing to forget
      }
    }
  }

  /**
   * Takes the unlock from an offline license file (.lic): checks its Ed25519 signature with the organization's
   * public key (base64 X.509), that it is for this license key and not expired or past its refresh window. Returns
   * false (and changes nothing) when the file isn't usable or carries no unlock.
   */
  acceptOffline(file, publicKeyBase64) {
    const payload = verifiedOffline(file, publicKeyBase64);
    if (!payload) return false;
    if (this.licenseKey && typeof payload.licenseKey === 'string'
        && this.licenseKey.toLowerCase() !== payload.licenseKey.trim().toLowerCase()) return false;
    const now = this._now();
    const at = (s) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);
    const issued = at(payload.issuedAt);
    if (issued != null && issued > now + SKEW_MS) return false;
    const expires = at(payload.policy && payload.policy.expiresAt);
    if (expires != null && now >= expires) return false;
    const refresh = at(payload.refreshAfter);
    if (refresh != null && now >= refresh) return false;
    if (typeof payload.unlock !== 'string') return false;
    const k = Buffer.from(payload.unlock.trim(), 'base64');
    if (!validKeyLength(k)) return false;
    this._unlock = k; // the file is its own cache: nothing written to disk
    return true;
  }

  /** True when an unlock is available: from this run's valid check, the offline file, or the cache (≤ 7 days). */
  unlocked() {
    return this._key() != null;
  }

  // ---- core unlock ----

  /**
   * Decrypts data sealed with `sunlicense seal` (an `SLS1.` string). Throws Locked without an unlock, or when the
   * data was sealed for another product. Remembers the digests sealed with it for integrity().
   * @returns {Buffer}
   */
  unseal(sealed) {
    const key = this._key();
    if (!key) throw new Locked('No valid license check yet: the protected part of this product stays locked.');
    const opened = open(Buffer.isBuffer(sealed) ? sealed.toString('utf8') : sealed, key);
    this._digests = opened.digests;
    return opened.data;
  }

  /** The digests sealed with the last data unseal() opened (path → lowercase hex SHA-256). */
  digests() {
    return this._digests;
  }

  /**
   * Compares the sealed digests with the product's files: `source` is a directory (paths resolve inside it) or a
   * function(path) → Buffer|string|null. `digests` defaults to the ones sealed with the last unseal(). Returns 'OK'
   * or 'MODIFIED', or null when nothing was sealed with digests; the result goes with the next license check.
   */
  integrity(source, digests = this._digests) {
    if (!digests || Object.keys(digests).length === 0) return null;
    const reader = typeof source === 'function' ? source : directoryReader(source || process.cwd());
    const changed = [];
    for (const p of Object.keys(digests).sort()) {
      let bytes = null;
      try {
        bytes = reader(p);
      } catch {
        bytes = null;
      }
      if (bytes == null) changed.push(`${p} (missing)`);
      else if (digest(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes) !== normaliseDigest(digests[p])) changed.push(p);
    }
    if (changed.length === 0) {
      this._integrity = 'OK';
      this._integrityDetail = null;
    } else {
      this._integrity = 'MODIFIED';
      this._integrityDetail = detail(changed);
    }
    return this._integrity;
  }

  /** The latest integrity() result, or null before any. */
  integrityResult() {
    return this._integrity;
  }

  /** Fields to add to the next license check's JSON body: integrity and, when modified, integrityDetail. */
  validateFields() {
    const fields = {};
    if (this._integrity) {
      fields.integrity = this._integrity;
      if (this._integrityDetail) fields.integrityDetail = this._integrityDetail;
    }
    return fields;
  }

  // ---- ownership notice ----

  /**
   * One line for the start-up log: product, owner, masked license key and terms link, e.g. "My Bot is licensed
   * software by Example Studio. License AX8P-XXXX-XXXX-XXXX. Terms: https://…". Never the full key or the buyer's name.
   */
  notice() {
    let b = `${this.productName || 'This product'} is licensed software`;
    if (this.owner) b += ` by ${this.owner}`;
    b += `. License ${mask(this.licenseKey)}.`;
    if (this.terms) b += ` Terms: ${this.terms}`;
    return b;
  }

  // ---- protected files ----

  /**
   * Downloads a protected file uploaded to the product (Standard plan). SunLicense sends it only while the license
   * is valid. Rejects with Refused when it says no, with another Error when it can't be reached.
   * @returns {Promise<Buffer>}
   */
  async protectedFile(name, { timeoutMs = 15000 } = {}) {
    if (!this.productCode) throw new TypeError('SunLicense: set productCode to download protected files');
    if (!this.licenseKey) throw new Refused(401, 'No license key');
    const url = `${this.baseUrl}/api/v2/protected-files/${encodeURIComponent(this.productCode)}/${encodeURIComponent(name)}`;
    const headers = { 'x-license-key': this.licenseKey };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.fingerprint) headers['x-fingerprint'] = this.fingerprint;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await this._fetch(url, { method: 'GET', headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status === 200) return body;
    if (res.status >= 500 || res.status === 429) {
      throw new Error(`SunLicense returned HTTP ${res.status} for protected file ${name}`);
    }
    let code = null;
    try {
      const j = JSON.parse(body.toString('utf8'));
      code = typeof j.code === 'string' ? j.code : typeof j.detail === 'string' ? j.detail : null;
    } catch {
      // keep the status only
    }
    throw new Refused(res.status, `SunLicense refused protected file ${name} (HTTP ${res.status}${code ? `, ${code}` : ''})`);
  }

  // ---- the unlock cache: one file per license key, AES-GCM under a key bound to the key, the machine id and this machine ----

  _key() {
    if (this._unlock) return this._unlock;
    const k = this._readCache();
    if (k) this._unlock = k;
    return k;
  }

  _cacheFile() {
    if (this.cacheDirectory == null || !this.licenseKey) return null;
    const id = digest(Buffer.from(`sunlicense-unlock-file\0${this.licenseKey}`, 'utf8')).slice(0, 16);
    return path.join(this.cacheDirectory, CACHE_FILE + id);
  }

  _cacheKey() {
    const binding = `sunlicense-unlock-cache\0${this.licenseKey}\0${this.fingerprint || ''}\0${this._machine()}`;
    return crypto.createHash('sha256').update(binding, 'utf8').digest();
  }

  _writeCache(key) {
    const file = this._cacheFile();
    if (!file) return;
    try {
      const plain = Buffer.from(`${Math.floor(this._now())}\n${key.toString('base64')}`, 'utf8');
      const nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', this._cacheKey(), nonce);
      const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, CACHE_PREFIX + Buffer.concat([nonce, ct]).toString('base64url'));
      fs.renameSync(tmp, file);
    } catch {
      // memory only
    }
  }

  _readCache() {
    const file = this._cacheFile();
    if (!file) return null;
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (!text.startsWith(CACHE_PREFIX)) return null;
      const raw = decodeBase64(text.slice(CACHE_PREFIX.length));
      const d = crypto.createDecipheriv('aes-256-gcm', this._cacheKey(), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(raw.length - 16));
      const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
      const nl = plain.indexOf('\n');
      const saved = Number(plain.slice(0, nl));
      const now = this._now();
      if (!Number.isFinite(saved) || saved > now + SKEW_MS || now >= saved + CACHE_TTL_MS) return null;
      const k = Buffer.from(plain.slice(nl + 1), 'base64');
      return validKeyLength(k) ? k : null;
    } catch {
      return null; // another machine, another license key, or a damaged file
    }
  }
}

function directoryReader(dir) {
  const root = path.resolve(dir);
  return (name) => {
    const p = path.resolve(root, name);
    if (p !== root && !p.startsWith(root + path.sep)) return null;
    try {
      return fs.statSync(p).isFile() ? fs.readFileSync(p) : null;
    } catch {
      return null;
    }
  };
}

function verifiedOffline(file, publicKeyBase64) {
  if (!file || !trim(publicKeyBase64)) return null;
  const parts = String(file).trim().split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = decodeBase64(parts[0]);
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyBase64.trim(), 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, payload, key, decodeBase64(parts[1]))) return null;
    const parsed = JSON.parse(payload.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
