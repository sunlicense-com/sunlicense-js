/**
 * SunLicense — official JavaScript client.
 *
 * Early release. The validation call below works against the SunLicense REST API;
 * the wider client surface (activations, entitlements, offline verification) is in
 * active development.
 *
 * Docs: https://docs.sunlicense.hapangama.com
 */

import { SunLicenseAnalytics } from './analytics.js';

export { SunLicenseAnalytics } from './analytics.js';
export const VERSION = '0.1.0';

/**
 * A SunLicense API client.
 *
 * @example
 * const client = new SunLicense({ baseUrl: 'https://your-instance.example.com' });
 * const result = await client.validate('LICENCE-KEY-HERE');
 * if (result.valid) console.log('ok');
 */
export class SunLicense {
  /**
   * @param {object} options
   * @param {string} options.baseUrl  Base URL of your SunLicense instance.
   * @param {string} [options.token]  API token, if your endpoint requires one.
   * @param {number} [options.timeoutMs=10000]  Request timeout in milliseconds.
   */
  constructor({ baseUrl, token, timeoutMs = 10000 } = {}) {
    if (!baseUrl) throw new TypeError('SunLicense: "baseUrl" is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Validate a licence key.
   *
   * @param {string} licenseKey
   * @param {object} [context]  Optional context, e.g. { product, host }.
   * @returns {Promise<{valid: boolean, status: number, data: any}>}
   */
  async validate(licenseKey, context = {}) {
    if (!licenseKey) throw new TypeError('SunLicense: "licenseKey" is required');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = { 'content-type': 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;

      const response = await fetch(`${this.baseUrl}/api/v2/license/validate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ license: licenseKey, ...context }),
        signal: controller.signal,
      });

      let data = null;
      try {
        data = await response.json();
      } catch {
        // Non-JSON response; leave data as null and let the caller inspect status.
      }

      return { valid: response.ok, status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Starts built-in product analytics for a licensed product, with this client's base URL and API key:
   * a report every 30 minutes in the background (see SunLicenseAnalytics). Never throws.
   *
   * @param {object} options  `licenseKey` and `fingerprint` (the values you validate with), plus any
   *   SunLicenseAnalytics.start option (`productVersion`, `enabled`, `productAnalyticsId`, `dataDirectory`, …).
   * @returns {SunLicenseAnalytics}
   */
  analytics(options = {}) {
    return SunLicenseAnalytics.start({ baseUrl: this.baseUrl, apiKey: this.token, ...options });
  }

  /**
   * Starts built-in product analytics for a free product with its public product analytics id
   * (Product → Analytics in the dashboard). No license or API key needed. Never throws.
   *
   * @param {string} productAnalyticsId  pa_…
   * @param {object} [options]  Any SunLicenseAnalytics.start option.
   * @returns {SunLicenseAnalytics}
   */
  static analytics(productAnalyticsId, options = {}) {
    return SunLicenseAnalytics.start({ ...options, productAnalyticsId });
  }
}

export default SunLicense;
