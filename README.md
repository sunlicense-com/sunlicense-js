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

## Requirements

Node.js 18 or newer (uses the built-in `fetch`).

## Other clients

SunLicense also provides clients for **Java**, **PHP**, **Python** and **Lua**.

## Links

- Website — https://sunlicense.com
- Documentation — https://docs.sunlicense.hapangama.com
- Issues — https://github.com/sunlicense-com/sunlicense-js/issues

## Licence

MIT © Hapangama
