# Rovenue React Native SDK

Open-source subscription management SDK for React Native. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking.

## Installation

```sh
npm install @rovenue/react-native-sdk
# or
yarn add @rovenue/react-native-sdk
```

## Quick Start

```ts
import { Rovenue } from '@rovenue/react-native-sdk';

Rovenue.configure({ apiKey: 'rov_pub_...', baseUrl: 'https://edge.rovenue.app' });

const pro = await Rovenue.entitlement('pro');
if (pro?.isActive) { /* unlock features */ }
```

## Documentation

Full guides, API reference, and the identity & consent policy live at
**https://docs.rovenue.app** — start with the
[Quick Start](https://docs.rovenue.app/docs/getting-started/quickstart).
