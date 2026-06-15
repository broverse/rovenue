# Rovenue Docs Style Guide (overhaul)

Goal: **very detailed, every step simple, types on every page, developer-friendly.** Fumadocs MDX on React Router v7. This guide is the single source of truth for the docs overhaul — every page must follow it.

## Imports (mirror existing pages — check `getting-started/quickstart.mdx` top)
```mdx
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';
import { Steps, Step } from 'fumadocs-ui/components/steps';
```
Only import what the page uses. Match the exact import paths used by existing pages.

## Multi-platform code (ALWAYS)
Every SDK call shown for all three platforms — never one in isolation:
```mdx
<Tabs groupId="platform" persist items={['React Native', 'Swift', 'Kotlin']}>
  <Tab value="React Native">
    ```ts
    import { Rovenue } from '@rovenue/react-native-sdk';
    ```
  </Tab>
  <Tab value="Swift">
    ```swift
    import Rovenue
    ```
  </Tab>
  <Tab value="Kotlin">
    ```kotlin
    import dev.rovenue.sdk.Rovenue
    ```
  </Tab>
</Tabs>
```

## Procedures = Steps (ALWAYS)
Anything with ordered actions uses `<Steps>` with one clear action per `<Step>`:
```mdx
<Steps>
<Step>
### Do the first thing
One or two sentences. Then the Tabs code block.
</Step>
<Step>
### Do the next thing
...
</Step>
</Steps>
```
Keep each step atomic and plainly worded. Prefer more, smaller steps over dense ones.

## Types on EVERY page (key requirement)
Wherever a page uses a type, embed it. Pattern: a short `### Types on this page` section (or inline at first use) with BOTH a fenced `ts` definition AND a field table:

```mdx
### Types on this page

\`\`\`ts
type User = {
  rovenueId: string;       // permanent per-install id (prefix rov_), always present
  appUserId: string | null; // your backend user id, null until identify()
};
\`\`\`

| Field | Type | Description |
|-------|------|-------------|
| `rovenueId` | `string` | Permanent per-install id (prefix `rov_`); never changes. |
| `appUserId` | `string \| null` | Your backend user id; `null` until `identify()`. |

> Swift and Kotlin mirror these with platform-idiomatic names (`User.rovenueId` / `User.appUserId`). See [Types](/docs/reference/types#user).
```
Use the CANONICAL types below verbatim (don't invent fields).

## Callouts
- `<Callout type="info">` — tips, "good to know", links to related pages.
- `<Callout type="warn">` — footguns, security, irreversible actions, ordering requirements.
Every page should have at least one helpful callout and links to the relevant method(s) + type(s).

## Cross-linking
Absolute `/docs/...` links only. Examples: `/docs/reference/methods#identity`, `/docs/reference/types#offerings`, `/docs/guides/identifying-users`. Only link to pages that exist (full page list below). Anchors are the lowercased heading slug.

## Examples
Complete and runnable: real imports, real method names from the canonical surface, realistic values. No pseudo-code, no `...` hand-waving in the critical path.

## Do NOT
- Do not run `git` or the docs build — just edit the assigned `.mdx` files and leave them in the working tree (the orchestrator builds + link-checks + commits centrally).
- Do not edit pages outside your assignment.
- Do not invent SDK methods/types/pages.

---

## CANONICAL SDK SURFACE (TypeScript; Swift/Kotlin mirror with idiomatic naming)

`Rovenue` namespace methods:
- `configure(config: RovenueConfig): void`
- `getVersion(): string`
- `currentUser(): User`
- `identify(appUserId: string): void` — optimistic local + background `POST /v1/identify` (server bind + auto-transfer)
- `logOut(): void` — mints a fresh `rovenueId`, clears `appUserId` + scope-bound caches
- `entitlement(id: string): Entitlement | null`
- `entitlementsAll(): Entitlement[]`
- `refreshEntitlements(): void` (network)
- `creditBalance(): number`
- `refreshCredits(): void` (network)
- `consumeCredits(amount: number, description?: string): number`
- `getOfferings(): Offerings`
- `purchase(pkg: Package): Promise<PurchaseResult>`
- `restorePurchases(): void`
- `getAppAccountToken(): string`
- `setForeground(foreground: boolean): void`
- `shutdown(): void`
- `setLogHandler(handler: (entry: LogEntry) => void): void`
- `addChangeListener(cb: (event: ChangeEvent) => void): () => void`

React Native hooks: `useCurrentUser(): User | null`, `useEntitlement(id): Entitlement | null`, `useEntitlements(): Entitlement[]`, `useCreditBalance(): number`.

Types:
```ts
type RovenueConfig = { apiKey: string; baseUrl: string; debug?: boolean; appVersion?: string };
type User = { rovenueId: string; appUserId: string | null };
type Entitlement = { id: string; isActive: boolean; productIdentifier: string; store: string; expiresIso?: string };
type ProductType = 'subscription' | 'consumable' | 'non_consumable';
type StoreProduct = { id: string; type: ProductType; displayName: string; priceString: string | null; price: number | null; currencyCode: string | null };
type Package = { identifier: string; product: StoreProduct };
type Offering = { identifier: string; isDefault: boolean; packages: Package[] };
type Offerings = { current: Offering | null; all: Record<string, Offering> };
type PurchaseResult = { entitlements: Entitlement[]; creditBalance: number; productId: string; storeTransactionId: string };
type ChangeEvent = 'EntitlementsChanged' | 'IdentityChanged' | 'CreditBalanceChanged';
type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; message: string; timestamp: number };
```
Platform notes: `ChangeEvent` is a Swift enum (`.entitlementsChanged`…) and Kotlin enum (`ENTITLEMENTS_CHANGED`…); the stream is `AsyncStream<ChangeEvent>` (Swift) / `SharedFlow<ChangeEvent>` (Kotlin) / `addChangeListener` (TS).

Errors: public error family `RovenueError` with classes/cases incl. `InvalidApiKey`, `InvalidArgument` (new — empty/invalid input, e.g. empty `identify()`), `NotConfigured`, `NetworkUnavailable`, `Timeout`, `RateLimited`, `ServerError`, `Storage`, `UserNotFound`, `InsufficientCredits`, `EntitlementInactive`, `DuplicatePurchase`, `ReceiptInvalid`, `PurchaseCancelled`, `PurchasePending`, `ProductNotAvailable`, `StoreProblem`, `Internal`. TS classes are `XxxError`; Swift `.xxx` cases; Kotlin `RovenueException.Xxx`.

API keys: public SDK key prefix `rov_pub_`; baseUrl example `https://edge.rovenue.app`.

---

## PAGE LIST (do not link to anything not here)
- `/docs` (index)
- `/docs/getting-started/installation`, `/quickstart`, `/core-concepts`
- `/docs/guides/configuring`, `/identifying-users`, `/entitlements`, `/processing-purchases`, `/credits`, `/reacting-to-changes`, `/app-lifecycle`, `/identity-consent`
- `/docs/platforms/react-native`, `/ios-swift`, `/android-kotlin`
- `/docs/reference/methods`, `/types`, `/errors`
- `/docs/resources/versioning`, `/migrating-from-revenuecat`, `/using-with-ai` (NEW — the LLM page)
- `/docs/integrations/meta-capi`, `/tiktok-events`
