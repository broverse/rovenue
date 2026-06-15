# Rovenue React Native SDK

Open-source subscription management SDK for React Native. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking.

## Installation

```sh
npm install @rovenue/sdk-rn
# or
yarn add @rovenue/sdk-rn
```

## Quick Start

```ts
import { Rovenue } from '@rovenue/sdk-rn';

Rovenue.configure({ publicApiKey: 'rov_pub_...' });

const pro = await Rovenue.entitlement('pro');
if (pro.isActive) { /* unlock features */ }
```

## Documentation

Full guides, API reference, and the identity & consent policy live at
**https://docs.rovenue.app** — start with the
[Quick Start](https://docs.rovenue.app/docs/getting-started/quickstart).
