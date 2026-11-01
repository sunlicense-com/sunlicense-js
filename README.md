# SunLicense — JavaScript Client

Official JavaScript client for [SunLicense](https://sunlicense.com), a licence management and
anti-piracy system for indie software developers.

SunLicense issues, validates and revokes licence keys for Minecraft plugins, Discord bots,
FiveM scripts, desktop apps and other paid software — with marketplace automation for
BuiltByBit and Polymart.

> **Early release.** Licence validation works today. The wider client surface — activations,
> entitlements and offline verification — is in active development.

## Install

```bash
npm install sunlicense
```

## Usage

```js
import { SunLicense } from 'sunlicense';

const client = new SunLicense({
  baseUrl: 'https://your-instance.example.com',
  token: process.env.SUNLICENSE_TOKEN, // optional
});

const result = await client.validate('LICENCE-KEY-HERE');

if (result.valid) {
  console.log('Licence is valid');
} else {
  console.log('Rejected:', result.status, result.data);
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | — | **Required.** Base URL of your SunLicense instance |
| `token` | `string` | — | API token, if your endpoint requires one |
| `timeoutMs` | `number` | `10000` | Request timeout in milliseconds |

## Built-in analytics

Reports anonymous usage statistics for your product's **Analytics** tab (installs, versions, OS, runtime,
platform), plus your own feature usage and charts. Like bStats, for every product.

```js
import { SunLicense } from 'sunlicense';

// A licensed product: the API key, license key and machine id it validates with.
const analytics = client.analytics({ licenseKey, fingerprint: machineId, productVersion: '2.3.1',
                                     enabled: config.analytics !== false });
// A free product, no license: its public product analytics id (Product → Analytics).
const analytics = SunLicense.analytics('pa_7Hk2mQ9xZr4LbN8vT1wYcD', { dataDirectory: './data' });

analytics.feature('auto-sell');                                  // feature usage
analytics.simplePie('storage', () => config.storage);            // custom charts
analytics.singleLine('servers', () => client.guilds.cache.size);
analytics.close();                                               // on shutdown
```

Charts: `simplePie`, `advancedPie`, `drilldownPie`, `singleLine`, `multiLine`, `simpleBar`, `advancedBar`,
`removeChart`. Ids and feature names: `[a-z0-9][a-z0-9._-]{0,47}`. Callbacks run before each report; one that
throws or returns nothing is left out. Timers are `unref()`'d, so they never keep your process alive.

**What is sent** (raw values; SunLicense groups them, e.g. `5.15.0-1051-oracle` into Linux 5.15): your
product version, the OS and its version, CPU architecture, CPU cores, locale, runtime (`node`, `bun` or `deno`) and version, the platform (`discord` with the discord.js/Eris version, `fivem`/`redm` with the server build, `electron`, else `standalone`),
the SDK's name and version, and the identity: licensed = license key + machine id (with the API key), free =
the product analytics id + a random install id kept in `.sunlicense-install-id` in `dataDirectory` (default `~/.sunlicense`). The country comes from SunLicense's edge, not
from the SDK. Nothing personal is sent: no user, host, server or player names, IP addresses or file paths.

**Switching it off.** Nothing is sent, not even an empty report, while any of these says so (checked before
every report): your product's own switch (`enabled: false`, or a function read before each report); the environment variable `SUNLICENSE_ANALYTICS=off` (also
`false` or `0`); on FiveM the convar `sunlicense_analytics`.

The first report goes 1 to 30 minutes after start (random), then one every 30 minutes. When
SunLicense answers with `Retry-After` (analytics switched off for the product, rate limits) it waits that long,
at most 24 hours. Reporting never runs on the license check's path, never delays or fails a check, and swallows
its own errors.

Docs: https://docs.sunlicense.com/guide/sdks#built-in-analytics

## Requirements

Node.js 18 or newer (uses the built-in `fetch`).

## Other clients

SunLicense also provides clients for **Java**, **PHP**, **Python** and **Lua**.

## Links

- Website — https://sunlicense.com
- Documentation — https://docs.sunlicense.hapangama.com
- Issues — https://github.com/sunlicense-com/sunlicense-js/issues

## Changelog

- **0.1.0**: built-in product analytics (opt-out), feature usage and custom charts: `client.analytics()`, `SunLicense.analytics()`.

## Tests

```bash
npm test
```

## Licence

MIT © Hapangama
