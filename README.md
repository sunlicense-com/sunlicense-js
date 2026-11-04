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

## Protection: core unlock, tamper reports, ownership notice

`sunlicense seal <file> --product <code> [--digest <files>]` (the [CLI](https://docs.sunlicense.com/cli/)) encrypts
part of your product, its *core*, on SunLicense's servers under a key only they hold, and prints the sealed text
(`SLS1.…`) you ship. A valid license check answers with that key (`unlock`); a refused one (suspended, expired,
revoked) doesn't, and this SDK forgets the one it had. So a copy whose license check was cut out can't run its core.
The unlock from the last valid check is cached for 7 days (in `cacheDirectory`, default `~/.sunlicense`), encrypted under a key bound to the license key,
the machine id and this machine, so outages don't stop your customers.

```js
const client = new SunLicense({ baseUrl: 'https://api.sunlicense.com', token: process.env.SUNLICENSE_API_KEY });
const protection = client.protection({ licenseKey, fingerprint: machineId,
  product: 'My Bot', owner: 'Example Studio', terms: 'https://example.com/terms', cacheDirectory: './data' });
console.log(protection.notice());                               // product, owner, masked key
await client.validate(licenseKey, { fingerprint: machineId });  // sends integrity, keeps or forgets the unlock
const core = protection.unseal(SEALED_CORE);                    // Buffer; throws Locked without a valid unlock
protection.integrity(appDir);                                   // 'OK' / 'MODIFIED', sent with the next check
```

The [discord.js template](https://github.com/sunlicense-com/example-discord-bot-js) does all of this, sealing at build time.

- `unseal(sealed)`: the core, or throws `Locked` without a valid unlock (or for data sealed for another product).
- `integrity(...)`: compares the files whose digests were sealed with the core (`--digest`) with what is running;
  `OK` or `MODIFIED` (with the changed files) is sent with the next check, where Sentinel sees it.
- `notice()`: `My Bot is licensed software by Example Studio. License AX8P-XXXX-XXXX-XXXX. Terms: …`; never the full
  key or the buyer's name.
- `await protection.protectedFile(name)`: a file uploaded to the product (Standard plan), sent only while the license is valid.
- `accept(body)` and `protection.validateFields()`: for your own HTTP code; the client does both when you create the protection from it.
- `acceptOffline(file, publicKey)`: the unlock from a valid [offline license file](https://docs.sunlicense.com/guide/offline-licenses).
- Only `node:crypto`: Node 18+, Bun, Deno and FiveM's server JavaScript.

Honest limit: someone with a valid license can still extract the unlock and patch their copy; that copy then fails
its integrity check and is reported. Protection raises the cost and makes leaks visible. Wire format and test
vectors: `test/fixtures/protection-test-vectors.json` (a copy of SunLicense's); docs:
https://docs.sunlicense.com/guide/protection

## Requirements

Node.js 18 or newer (uses the built-in `fetch`).

## Other clients

SunLicense also provides clients for **Java**, **PHP**, **Python** and **Lua**.

## Links

- Website — https://sunlicense.com
- Documentation — https://docs.sunlicense.hapangama.com
- Issues — https://github.com/sunlicense-com/sunlicense-js/issues

## Changelog

- **0.2.0**: core unlock, tamper reports, the ownership notice and protected files: `client.protection()`, `SunLicenseProtection`.
- **0.1.0**: built-in product analytics (opt-out), feature usage and custom charts: `client.analytics()`, `SunLicense.analytics()`.

## Tests

```bash
npm test
```

## Licence

MIT © Hapangama
