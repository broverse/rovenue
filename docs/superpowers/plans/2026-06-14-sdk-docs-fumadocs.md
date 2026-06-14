# SDK Documentation Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a public Fumadocs documentation site at `apps/docs` that fully documents the Swift, Kotlin, and React Native SDKs from a single source of truth, then deploy it behind the existing Caddy edge at `docs.rovenue.app`.

**Architecture:** Fumadocs UI + Fumadocs MDX on **React Router v7** (Vite SSR, prerendered to static). One persistent platform tab group (`groupId="platform"`) on every concept page shows React Native / Swift / Kotlin side by side. Static prerender output is served by Caddy, mirroring the dashboard's build-and-serve pattern. No Next.js.

**Tech Stack:** React Router v7, Vite, Fumadocs (`fumadocs-ui`, `fumadocs-core`, `fumadocs-mdx`), Tailwind CSS 4, MDX, Docker + Caddy.

**Spec:** `docs/superpowers/specs/2026-06-14-sdk-docs-fumadocs-design.md`

**Branch:** `docs/sdk-fumadocs` (already checked out).

---

## Source-of-truth API facts (used verbatim across content tasks)

All code samples derive from these verified signatures. Do not invent APIs.

**Imperative API (same shape on all platforms):**
- `configure(apiKey, baseUrl, debug?, appVersion?)`
- `currentUser()` → `User { anonId, knownUserId? }`
- `identify(knownUserId)` — client-local; server merge happens via the customer backend calling `/v1/subscribers/transfer` with the secret key.
- `entitlement(id)` → `Entitlement | null` (cache, no network)
- `entitlementsAll()` → `Entitlement[]` (cache, no network)
- `refreshEntitlements()` (network)
- `creditBalance()` → number (cache, 0 if empty)
- `refreshCredits()` (network)
- `consumeCredits(amount, description?)` → new balance; throws `InsufficientCredits`; server-deduped via internal Idempotency-Key.
- `postAppleReceipt(jws, productId, appAccountToken?)` → `ReceiptResult`
- `postGoogleReceipt(receipt, productId, obfuscatedAccountId?, obfuscatedProfileId?)` → `ReceiptResult`
- `getAppAccountToken()` / `getOrCreateAppAccountToken()` → string (UUID)
- `setForeground(bool)`, `shutdown()`, `setLogHandler(fn)`

**Invariant stated on relevant pages:** the SDK does **not** call StoreKit / Play Billing. The host app performs the purchase and hands the JWS (Apple) or purchase token (Google) to the SDK for server validation.

**Change stream:** Swift `Rovenue.shared.changes` (`AsyncStream<ChangeEvent>`); Kotlin `Rovenue.shared.changes` (`SharedFlow<ChangeEvent>`); RN `Rovenue.addChangeListener(cb)` returns an unsubscribe fn. `ChangeEvent ∈ { EntitlementsChanged, IdentityChanged, CreditBalanceChanged }`.

**RN React hooks:** `useCurrentUser()` → `User | null`; `useEntitlement(id)` → `Entitlement | null`; `useEntitlements()` → `Entitlement[]`; `useCreditBalance()` → number.

**Types:** `User { anonId: string, knownUserId?: string }`; `Entitlement { id, isActive, productIdentifier, store, expiresIso? }`; `ReceiptResult { subscriberId, appUserId, creditBalance }`.

**13 errors (`RovenueError` family):** NotConfigured, InvalidApiKey, ServerError, NetworkUnavailable, Timeout, RateLimited, Storage, UserNotFound, InsufficientCredits, EntitlementInactive, DuplicatePurchase, ReceiptInvalid, Internal.
- RN: subclasses (`NotConfiguredError`, `InvalidApiKeyError`, …, `InternalError`).
- Swift: `RovenueError` enum cases (`.notConfigured`, …).
- Kotlin: `RovenueException` sealed subclasses (`RovenueException.InvalidApiKey`, …).

**Platform invocation styles:**
- RN: `Rovenue.configure(...)`, `await Rovenue.identify(...)`; hooks for reactive reads.
- Swift: `Rovenue.configure(...)`, `await Rovenue.shared.identify(...)`, `Rovenue.shared.changes`.
- Kotlin: `Rovenue.configure(...)`, `Rovenue.shared.identify(...)` (suspend), `Rovenue.shared.changes` (SharedFlow).

---

## File Structure

```
apps/docs/
├── package.json                      @rovenue/docs — real dev/build/start scripts
├── vite.config.ts                    react-router + fumadocs MDX
├── react-router.config.ts            ssr:true + prerender all routes
├── source.config.ts                  Fumadocs MDX collection → content/docs/**
├── tsconfig.json
├── app/
│   ├── root.tsx                      RootProvider (theme + search)
│   ├── app.css                       Tailwind 4 + fumadocs-ui styles
│   ├── routes.ts                     index(home) + docs/* + api/search
│   ├── lib/source.ts                 loader() → page tree
│   ├── lib/layout.shared.tsx         shared nav options
│   ├── components/mdx.tsx            getMDXComponents (+ Tabs/Callout/Steps)
│   ├── routes/home.tsx               landing: hero + "Get Started"
│   ├── routes/docs.tsx               DocsLayout + DocsPage renderer
│   └── routes/search.ts             search endpoint
├── content/docs/                     the MDX tree (Tasks 3–7)
└── Dockerfile                        node build → caddy static serve (Task 9)

deploy/caddy/Caddyfile.docs           static file server (Task 9)
deploy/caddy/Caddyfile                + docs.rovenue.app host block (Task 9)
docker-compose.yml                    + docs service (Task 9)
docs/operations/deployment.md         + docs service/DNS/smoke (Task 9)
```

---

### Task 1: Scaffold Fumadocs (React Router) into apps/docs

**Files:**
- Replace: `apps/docs/**` (currently a placeholder with only `package.json` + `content/integrations/*.mdx`)
- Modify: root `turbo.json`, `pnpm-workspace.yaml` (verify docs is included)

- [ ] **Step 1: Preserve the existing integrations MDX**

```bash
mkdir -p /tmp/rovenue-docs-keep
cp -r apps/docs/content/integrations /tmp/rovenue-docs-keep/
```

- [ ] **Step 2: Scaffold a known-good Fumadocs React Router app in a temp dir**

Use the official scaffolder so config files are correct-by-construction for the installed Fumadocs version (do NOT hand-transcribe Fumadocs internals).

```bash
cd /tmp
pnpm create fumadocs-app@latest rovenue-docs-scaffold
# When prompted: React.js framework = React Router; Content source = Fumadocs MDX.
```

Expected: a runnable React Router + Fumadocs project at `/tmp/rovenue-docs-scaffold` with `vite.config.ts`, `react-router.config.ts`, `source.config.ts`, `app/root.tsx`, `app/lib/source.ts`, `app/routes/{home,docs}.tsx`, `app/routes/search.ts`, `app/components/mdx.tsx`, and `content/docs/index.mdx`.

- [ ] **Step 3: Move the scaffold into apps/docs**

```bash
cd /Volumes/Development/rovenue
rm -rf apps/docs
mkdir -p apps/docs
cp -r /tmp/rovenue-docs-scaffold/. apps/docs/
rm -rf apps/docs/.git apps/docs/node_modules apps/docs/pnpm-lock.yaml
```

- [ ] **Step 4: Set the package name and scripts**

Edit `apps/docs/package.json` so the workspace recognizes it. Set:
```json
{
  "name": "@rovenue/docs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "react-router dev",
    "build": "react-router build",
    "start": "react-router-serve ./build/server/index.js",
    "postinstall": "fumadocs-mdx",
    "typecheck": "react-router typegen && tsc --noEmit"
  }
}
```
Keep all `dependencies`/`devDependencies` the scaffolder generated (fumadocs-ui, fumadocs-core, fumadocs-mdx, react-router, @react-router/*, tailwindcss, etc.). Match the workspace's existing engines/packageManager if the root enforces them.

- [ ] **Step 5: Restore the integrations content**

```bash
mkdir -p apps/docs/content/docs/integrations
cp /tmp/rovenue-docs-keep/integrations/*.mdx apps/docs/content/docs/integrations/
```
Add frontmatter (`title`, `description`) to each if missing — Fumadocs requires a `title`.

- [ ] **Step 6: Install and verify the dev server boots**

```bash
pnpm install
pnpm --filter @rovenue/docs dev
```
Expected: Vite dev server starts; visiting `/docs` renders the default `index.mdx`. Stop the server (Ctrl-C).

- [ ] **Step 7: Verify the production build succeeds**

```bash
pnpm --filter @rovenue/docs build
```
Expected: build completes, output written under `apps/docs/build/`. No MDX or type errors.

- [ ] **Step 8: Wire Turborepo**

Confirm `turbo.json` has a `build` pipeline that covers `@rovenue/docs` (most monorepos use a global `build` task — verify `apps/docs` is not excluded). If `pnpm-workspace.yaml` globs `apps/*`, docs is already included; otherwise add it.

- [ ] **Step 9: Commit**

```bash
git add apps/docs turbo.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(docs): scaffold Fumadocs on React Router v7 in apps/docs"
```

---

### Task 2: Configure prerender, landing page, and information architecture

**Files:**
- Modify: `apps/docs/react-router.config.ts`
- Modify: `apps/docs/app/routes/home.tsx`
- Modify: `apps/docs/app/lib/layout.shared.tsx`
- Create: `apps/docs/content/docs/meta.json` and one `meta.json` per section folder
- Create: empty section folders under `content/docs/`

- [ ] **Step 1: Enable static prerender of all routes**

Edit `apps/docs/react-router.config.ts` to prerender every docs path so the site can be served statically by Caddy:
```ts
import type { Config } from '@react-router/dev/config';
import { source } from './app/lib/source'; // exposes the page list

export default {
  ssr: true,
  async prerender() {
    // Home + every docs page slug, plus the search index route.
    const docsPaths = source.getPages().map((p) => `/docs/${p.slugs.join('/')}`);
    return ['/', '/docs', ...docsPaths];
  },
} satisfies Config;
```
If `source.getPages()` is not importable at config time in this Fumadocs version, fall back to `prerender: true` (prerender all discoverable routes). Verify after Step 5.

- [ ] **Step 2: Write the landing page**

Replace `apps/docs/app/routes/home.tsx` with a simple hero that links to `/docs`:
```tsx
import { Link } from 'react-router';

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-4xl font-bold">Rovenue SDK</h1>
      <p className="max-w-xl text-fd-muted-foreground">
        Subscriptions, entitlements, and credits for iOS, Android, and React
        Native — one shared core, three native SDKs.
      </p>
      <Link
        to="/docs"
        className="rounded-md bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
      >
        Get Started
      </Link>
    </main>
  );
}
```

- [ ] **Step 3: Set the site title / nav**

In `apps/docs/app/lib/layout.shared.tsx`, set `nav.title` to `Rovenue SDK` and add a GitHub link to the repo if the scaffold supports `links`.

- [ ] **Step 4: Create the section folders and meta.json ordering**

```bash
cd apps/docs/content/docs
mkdir -p getting-started guides platforms reference resources
```

Root `apps/docs/content/docs/meta.json`:
```json
{
  "pages": [
    "index",
    "getting-started",
    "guides",
    "platforms",
    "reference",
    "resources",
    "integrations"
  ]
}
```

`getting-started/meta.json`:
```json
{ "title": "Getting Started", "pages": ["installation", "quickstart", "core-concepts"] }
```

`guides/meta.json`:
```json
{ "title": "Guides", "pages": ["configuring", "identifying-users", "entitlements", "processing-purchases", "credits", "reacting-to-changes", "app-lifecycle", "identity-consent"] }
```

`platforms/meta.json`:
```json
{ "title": "Platforms", "pages": ["react-native", "ios-swift", "android-kotlin"] }
```

`reference/meta.json`:
```json
{ "title": "Reference", "pages": ["methods", "types", "errors"] }
```

`resources/meta.json`:
```json
{ "title": "Resources", "pages": ["versioning", "migrating-from-revenuecat"] }
```

- [ ] **Step 5: Replace the root index with the real Introduction**

Overwrite `apps/docs/content/docs/index.mdx`:
```mdx
---
title: Introduction
description: One shared core, three native SDKs for subscriptions, entitlements, and credits.
---

Rovenue ships three client SDKs — **Swift** (iOS/macOS/tvOS/watchOS),
**Kotlin** (Android/JVM), and **React Native** — all thin façades over one
shared **Rust core** (`librovenue`). The business logic (HTTP transport with
idempotency + retry, an on-device SQLite cache, foreground polling, receipt
validation, entitlements, credits, identity) lives in the core; each façade
exposes it idiomatically.

## What the SDK does

- Checks a user's **entitlements** (cache-first, refreshed in the background).
- Tracks a **credit** balance and spends credits server-side, idempotently.
- Sends store **receipts** to your Rovenue server for validation.
- Manages **identity** (anonymous → known user).

## What the SDK does NOT do

- It does **not** call StoreKit or Play Billing. Your app performs the
  purchase, then hands the resulting Apple JWS or Google purchase token to the
  SDK for server validation.
- It does **not** merge users itself. `identify()` is client-local; account
  merging is a server operation your backend triggers.

Pick your platform in the [Installation](/docs/getting-started/installation)
guide, then follow the [Quick Start](/docs/getting-started/quickstart).
```

- [ ] **Step 6: Verify build + prerender**

```bash
pnpm --filter @rovenue/docs build
```
Expected: build succeeds; prerendered HTML exists for `/`, `/docs`. (Section pages don't exist yet — that's fine; they're added in later tasks.)

- [ ] **Step 7: Commit**

```bash
git add apps/docs
git commit -m "feat(docs): landing page, IA scaffolding, prerender config"
```

---

### Task 3: Getting-started content (platform-tabs pattern established here)

**Files:**
- Create: `apps/docs/content/docs/getting-started/installation.mdx`
- Create: `apps/docs/content/docs/getting-started/quickstart.mdx`
- Create: `apps/docs/content/docs/getting-started/core-concepts.mdx`

- [ ] **Step 1: Write `installation.mdx`**

```mdx
---
title: Installation
description: Add the Rovenue SDK to your React Native, iOS, or Android app.
---

import { Tab, Tabs } from 'fumadocs-ui/components/tabs';

<Tabs groupId="platform" persist items={['React Native', 'Swift', 'Kotlin']}>
  <Tab value="React Native">
    ```sh
    npm install @rovenue/react-native-sdk
    # Expo: the config plugin auto-wires native deps on prebuild.
    ```
    Add the plugin in `app.json`:
    ```json
    { "expo": { "plugins": ["@rovenue/react-native-sdk/app.plugin"] } }
    ```
  </Tab>
  <Tab value="Swift">
    Swift Package Manager — add the package URL in Xcode, or in `Package.swift`:
    ```swift
    .package(url: "https://github.com/rovenue/sdk-swift.git", from: "0.2.0")
    ```
    CocoaPods:
    ```ruby
    pod 'Rovenue'
    ```
  </Tab>
  <Tab value="Kotlin">
    Gradle (`build.gradle.kts`):
    ```kotlin
    dependencies {
      implementation("dev.rovenue:sdk:0.2.0")
    }
    ```
  </Tab>
</Tabs>

See the per-platform [Platforms](/docs/platforms/react-native) guides for
native wiring details (Expo plugin, AppDelegate, Application).
```

- [ ] **Step 2: Write `quickstart.mdx`**

```mdx
---
title: Quick Start
description: Configure the SDK, check an entitlement, and validate a purchase in five minutes.
---

import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Callout } from 'fumadocs-ui/components/callout';

<Steps>
<Step>
### Configure once at startup

<Tabs groupId="platform" persist items={['React Native', 'Swift', 'Kotlin']}>
  <Tab value="React Native">
    ```ts
    import { Rovenue } from '@rovenue/react-native-sdk';

    Rovenue.configure({ apiKey: 'rov_pub_...', baseUrl: 'https://edge.rovenue.app' });
    ```
  </Tab>
  <Tab value="Swift">
    ```swift
    import Rovenue

    Rovenue.configure(apiKey: "rov_pub_...", baseUrl: "https://edge.rovenue.app")
    ```
  </Tab>
  <Tab value="Kotlin">
    ```kotlin
    import dev.rovenue.sdk.Rovenue

    Rovenue.configure(apiKey = "rov_pub_...", baseUrl = "https://edge.rovenue.app")
    ```
  </Tab>
</Tabs>
</Step>

<Step>
### Check an entitlement

<Tabs groupId="platform" persist items={['React Native', 'Swift', 'Kotlin']}>
  <Tab value="React Native">
    ```tsx
    import { useEntitlement } from '@rovenue/react-native-sdk';
    const pro = useEntitlement('pro'); // reactive, cache-first
    ```
  </Tab>
  <Tab value="Swift">
    ```swift
    let pro = await Rovenue.shared.entitlement("pro")
    ```
  </Tab>
  <Tab value="Kotlin">
    ```kotlin
    val pro = Rovenue.shared.entitlement("pro")
    ```
  </Tab>
</Tabs>
</Step>

<Step>
### Validate a purchase

The SDK never calls StoreKit/Play Billing. Run your store's purchase flow,
then hand the token to the SDK:

<Tabs groupId="platform" persist items={['React Native', 'Swift', 'Kotlin']}>
  <Tab value="React Native">
    ```ts
    const result = await Rovenue.postAppleReceipt(jws, 'pro_monthly', appAccountToken);
    // or: Rovenue.postGoogleReceipt(purchaseToken, 'pro_monthly', acctId, profileId)
    ```
  </Tab>
  <Tab value="Swift">
    ```swift
    let result = try await Rovenue.shared.postAppleReceipt(jws, productId: "pro_monthly", appAccountToken: token)
    ```
  </Tab>
  <Tab value="Kotlin">
    ```kotlin
    val result = Rovenue.shared.postGoogleReceipt(purchaseToken, "pro_monthly", acctId, profileId)
    ```
  </Tab>
</Tabs>
</Step>
</Steps>

<Callout type="info">
On success, the SDK refreshes entitlements and credits automatically and emits
a change event. See [Reacting to changes](/docs/guides/reacting-to-changes).
</Callout>
```

- [ ] **Step 3: Write `core-concepts.mdx`**

Cover, in prose with the verified facts (no code required, but a small table):
- Anonymous vs known user: every install starts anonymous (`anonId`); `identify(knownUserId)` attaches your app-side id (client-local — link to identifying-users for the server merge).
- Entitlement vs product: an entitlement is the access grant (`pro`); products map to it.
- Cache-first reads + background refresh: reads return instantly from the SQLite cache; `refresh…` hits the network; foreground polling refreshes automatically.
- Credits: an integer balance, spent server-side and idempotently.
- The "SDK does not call StoreKit/Play Billing" invariant (repeat, it's central).

Frontmatter `title: Core Concepts`, `description: ...`.

- [ ] **Step 4: Verify build**

```bash
pnpm --filter @rovenue/docs build
```
Expected: build succeeds; `/docs/getting-started/{installation,quickstart,core-concepts}` prerender.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/content/docs/getting-started
git commit -m "docs(content): getting-started (install, quickstart, core concepts)"
```

---

### Task 4: Guides content

**Files (create each):**
- `apps/docs/content/docs/guides/configuring.mdx`
- `apps/docs/content/docs/guides/identifying-users.mdx`
- `apps/docs/content/docs/guides/entitlements.mdx`
- `apps/docs/content/docs/guides/processing-purchases.mdx`
- `apps/docs/content/docs/guides/credits.mdx`
- `apps/docs/content/docs/guides/reacting-to-changes.mdx`
- `apps/docs/content/docs/guides/app-lifecycle.mdx`
- `apps/docs/content/docs/guides/identity-consent.mdx`

Every guide page uses the `<Tabs groupId="platform" persist items={['React Native','Swift','Kotlin']}>` pattern from Task 3. Use the exact signatures from the "Source-of-truth API facts" section. Each page: `title`, `description` frontmatter; 1–2 sentences of intro; the tabbed code; a `<Callout>` for the gotcha.

- [ ] **Step 1: `entitlements.mdx`** (full reference exemplar)

```mdx
---
title: Checking Entitlements
description: Read a user's active entitlements and refresh them from the server.
---

import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';

Entitlement reads are **cache-first** — they return instantly and never hit the
network. Call `refreshEntitlements()` to pull the latest from the server.

<Tabs groupId="platform" persist items={['React Native', 'Swift', 'Kotlin']}>
  <Tab value="React Native">
    ```tsx
    import { Rovenue, useEntitlement } from '@rovenue/react-native-sdk';

    function ProBadge() {
      const pro = useEntitlement('pro'); // reactive cache read
      return pro?.isActive ? <Crown /> : null;
    }

    await Rovenue.refreshEntitlements();
    const all = await Rovenue.entitlementsAll();
    ```
  </Tab>
  <Tab value="Swift">
    ```swift
    let pro = await Rovenue.shared.entitlement("pro")     // cache
    if pro?.isActive == true { showCrown() }
    try await Rovenue.shared.refreshEntitlements()         // network
    ```
  </Tab>
  <Tab value="Kotlin">
    ```kotlin
    val pro = Rovenue.shared.entitlement("pro")            // cache
    if (pro?.isActive == true) showCrown()
    Rovenue.shared.refreshEntitlements()                   // network
    ```
  </Tab>
</Tabs>

<Callout type="info">
Entitlements refresh automatically while the app is in the foreground (see
[App lifecycle](/docs/guides/app-lifecycle)). Manual `refresh` is only needed
when you require immediate consistency, e.g. right after a purchase.
</Callout>
```

- [ ] **Step 2: `configuring.mdx`** — `configure(apiKey, baseUrl, debug?, appVersion?)`; explain `debug` enables verbose logging via the log handler; `appVersion` is auto-read on iOS (`CFBundleShortVersionString`) / Android (`versionName`) / Expo (`app.json` version) and only needs overriding for the standalone JVM SDK. Tabbed config snippets.

- [ ] **Step 3: `identifying-users.mdx`** — `currentUser()` and `identify(knownUserId)`. State clearly: `identify` is **client-local** — it tags subsequent events with your id but does not merge accounts. Server-side merge happens when your backend calls `POST /v1/subscribers/transfer` with the **secret** API key (never expose the secret key in the app). Tabbed `currentUser`/`identify` snippets + a `<Callout type="warn">` about the secret key.

- [ ] **Step 4: `processing-purchases.mdx`** — the central invariant first: the SDK does not call StoreKit/Play Billing. Then `postAppleReceipt(jws, productId, appAccountToken?)` (obtain JWS from `Product.purchase()` on iOS; `appAccountToken` is the UUID passed to `.appAccountToken(...)`, cross-checked server-side) and `postGoogleReceipt(receipt, productId, obfuscatedAccountId?, obfuscatedProfileId?)` (token from `Purchase.purchaseToken`; obfuscated ids survive into Play RTDN for refund attribution). Both return `ReceiptResult { subscriberId, appUserId, creditBalance }` and auto-refresh entitlements + credits. Tabbed snippets for both stores. `<Callout>` listing throwable errors: `ReceiptInvalid`, `DuplicatePurchase`.

- [ ] **Step 5: `credits.mdx`** — `creditBalance()` (cache, 0 if empty), `refreshCredits()`, `consumeCredits(amount, description?)` → new balance. State the idempotency guarantee: the SDK generates an Idempotency-Key, so retries of the same call are server-deduped; throws `InsufficientCredits` when the balance is too low. Tabbed snippets. RN: mention `useCreditBalance()` hook.

- [ ] **Step 6: `reacting-to-changes.mdx`** — the change stream per platform: RN `const unsub = Rovenue.addChangeListener(e => …)` plus the four hooks; Swift `for await event in Rovenue.shared.changes { … }`; Kotlin `Rovenue.shared.changes.collect { event -> … }`. List the three `ChangeEvent` values. Kotlin `<Callout type="warn">`: collect `changes` from a coroutine **outside** the SDK's scope (calling `shutdown()` from a collector cancels it).

- [ ] **Step 7: `app-lifecycle.mdx`** — `setForeground(true/false)` drives the internal polling scheduler (foreground = polling on, background = paused); `shutdown()` stops background work. Where to call it: RN via `AppState`; Swift in `AppDelegate`/`SceneDelegate`; Kotlin via `Application`/`ProcessLifecycleOwner`. Tabbed wiring snippets. Note that session events (open/background/close) are recorded automatically.

- [ ] **Step 8: `identity-consent.mdx`** — port the "Identity context & consent" section that already exists verbatim in `packages/sdk-rn/README.md` (the PII field table: email/phone/externalId hashed SHA-256; ip/userAgent/fbp/fbc/ttclid/ttp forwarded verbatim) and the data-processor/controller split (consent is the host app's responsibility; Rovenue never persists `identityContext` at rest; `response_body` truncated to 4096 bytes; camelCase wire format with `ROVENUE_EVENT_WIRE_VERSION: "v1"`). Adapt the type name per platform tab (`identityContext` RN / `IdentityContext` Swift/Kotlin).

- [ ] **Step 9: Verify build**

```bash
pnpm --filter @rovenue/docs build
```
Expected: build succeeds; all eight guide pages prerender; no broken `<Tabs>`/`<Callout>` imports.

- [ ] **Step 10: Commit**

```bash
git add apps/docs/content/docs/guides
git commit -m "docs(content): guides (config, identity, entitlements, purchases, credits, changes, lifecycle, consent)"
```

---

### Task 5: Platform-specific guides

**Files (create each):**
- `apps/docs/content/docs/platforms/react-native.mdx`
- `apps/docs/content/docs/platforms/ios-swift.mdx`
- `apps/docs/content/docs/platforms/android-kotlin.mdx`

These are single-platform pages (no platform tabs needed) covering native wiring.

- [ ] **Step 1: `react-native.mdx`** — package `@rovenue/react-native-sdk` (Expo module). The Expo config plugin (`app.plugin.js`) auto-wires iOS pod + Android Gradle on prebuild; bare RN needs `pod install`. The four React hooks (`useCurrentUser`, `useEntitlement`, `useEntitlements`, `useCreditBalance`) and `Rovenue.addChangeListener`. Foreground wiring via `AppState`. Peer deps: expo >=51 <53, react >=18, react-native >=0.73.

- [ ] **Step 2: `ios-swift.mdx`** — module `Rovenue`; SPM + CocoaPods install; `Rovenue.configure(...)` in `application(_:didFinishLaunchingWithOptions:)`; `Rovenue.shared.setForeground(...)` from scene lifecycle; consuming `Rovenue.shared.changes` with `for await`; `setLogHandler` for debugging. Note the appVersion auto-reads from the bundle.

- [ ] **Step 3: `android-kotlin.mdx`** — package `dev.rovenue.sdk`; Gradle install; `Rovenue.configure(...)` in `Application.onCreate()`; pass `appVersion = packageManager.getPackageInfo(packageName, 0).versionName` for the standalone JVM SDK (the RN bridge forwards it automatically); `setForeground` via `ProcessLifecycleOwner`; the coroutine-scope caveat when collecting `changes`; suspend functions require a coroutine scope.

- [ ] **Step 4: Verify build + commit**

```bash
pnpm --filter @rovenue/docs build
git add apps/docs/content/docs/platforms
git commit -m "docs(content): platform setup guides (RN, iOS/Swift, Android/Kotlin)"
```

---

### Task 6: API reference

**Files (create each):**
- `apps/docs/content/docs/reference/methods.mdx`
- `apps/docs/content/docs/reference/types.mdx`
- `apps/docs/content/docs/reference/errors.mdx`

- [ ] **Step 1: `methods.mdx`** — a table per capability group (Configuration, Identity, Entitlements, Credits, Receipts, Lifecycle, Account token, Logging) using the verified signatures. For methods that differ in async style, show the RN signature in the table and use a platform-tabbed code block beneath each group for the Swift/Kotlin variants. Include columns: Method, Signature, Returns, Throws.

- [ ] **Step 2: `types.mdx`** — document `User`, `Entitlement`, `ReceiptResult`, `ChangeEvent` with field tables. `Entitlement { id: string, isActive: boolean, productIdentifier: string, store: string, expiresIso?: string }`; `User { anonId: string, knownUserId?: string }`; `ReceiptResult { subscriberId: string, appUserId: string, creditBalance: number }`; `ChangeEvent` enum: EntitlementsChanged, IdentityChanged, CreditBalanceChanged.

- [ ] **Step 3: `errors.mdx`** — one table of all 13 errors with three columns mapping the platform representation:

```mdx
---
title: Errors
description: The RovenueError family and how each surfaces per platform.
---

| Meaning | React Native (class) | Swift (enum case) | Kotlin (exception) |
|---|---|---|---|
| Not configured | `NotConfiguredError` | `.notConfigured` | `RovenueException.NotConfigured` |
| Invalid API key | `InvalidApiKeyError` | `.invalidApiKey` | `RovenueException.InvalidApiKey` |
| Server error | `ServerError` | `.serverError` | `RovenueException.ServerError` |
| Network unavailable | `NetworkUnavailableError` | `.networkUnavailable` | `RovenueException.NetworkUnavailable` |
| Timeout | `TimeoutError` | `.timeout` | `RovenueException.Timeout` |
| Rate limited | `RateLimitedError` | `.rateLimited` | `RovenueException.RateLimited` |
| Storage | `StorageError` | `.storage` | `RovenueException.Storage` |
| User not found | `UserNotFoundError` | `.userNotFound` | `RovenueException.UserNotFound` |
| Insufficient credits | `InsufficientCreditsError` | `.insufficientCredits` | `RovenueException.InsufficientCredits` |
| Entitlement inactive | `EntitlementInactiveError` | `.entitlementInactive` | `RovenueException.EntitlementInactive` |
| Duplicate purchase | `DuplicatePurchaseError` | `.duplicatePurchase` | `RovenueException.DuplicatePurchase` |
| Receipt invalid | `ReceiptInvalidError` | `.receiptInvalid` | `RovenueException.ReceiptInvalid` |
| Internal | `InternalError` | `.internal` | `RovenueException.Internal` |
```
(If a Swift case or Kotlin subclass name differs from this mapping, correct it against `packages/sdk-swift/Sources/Rovenue/Errors.swift` and the Kotlin generated bindings while writing — verify, don't assume.)

- [ ] **Step 4: Verify build + commit**

```bash
pnpm --filter @rovenue/docs build
git add apps/docs/content/docs/reference
git commit -m "docs(content): API reference (methods, types, errors)"
```

---

### Task 7: Resources + thin READMEs

**Files:**
- Create: `apps/docs/content/docs/resources/versioning.mdx`
- Create: `apps/docs/content/docs/resources/migrating-from-revenuecat.mdx`
- Modify: `packages/sdk-rn/README.md`, `packages/sdk-swift/README.md`, `packages/sdk-kotlin/README.md`

- [ ] **Step 1: `versioning.mdx`** — explain that all three SDKs track the shared `librovenue` core version; current line is `0.2.x`; semver; breaking changes are announced in release notes. Keep short.

- [ ] **Step 2: `migrating-from-revenuecat.mdx`** — a concept-mapping table (RevenueCat → Rovenue): `Purchases.configure` → `Rovenue.configure`; `getCustomerInfo().entitlements` → `entitlement()`/`entitlementsAll()`; `logIn` → `identify`; `Purchases.purchase` (SDK-driven) → host-app purchase + `postAppleReceipt`/`postGoogleReceipt` (note the key difference: Rovenue does not own the purchase UI). Keep factual and non-disparaging.

- [ ] **Step 3: Trim the three READMEs**

For each of `packages/sdk-rn/README.md`, `packages/sdk-swift/README.md`, `packages/sdk-kotlin/README.md`: keep a one-paragraph blurb + the install snippet, then replace the Quick Start and Identity/Consent bodies with a link:
```md
## Documentation

Full guides, API reference, and the identity/consent policy live at
**https://docs.rovenue.app** — see the
[Quick Start](https://docs.rovenue.app/docs/getting-started/quickstart).
```
Do not delete the install snippet (npm publish / SPM / Maven landing pages rely on it).

- [ ] **Step 4: Verify build + commit**

```bash
pnpm --filter @rovenue/docs build
git add apps/docs/content/docs/resources packages/sdk-rn/README.md packages/sdk-swift/README.md packages/sdk-kotlin/README.md
git commit -m "docs(content): resources + trim SDK READMEs to link to the site"
```

---

### Task 8: Internal link validation

**Files:**
- Modify: `apps/docs/package.json` (add a check script if not present)

- [ ] **Step 1: Add the Fumadocs link-validation check**

Fumadocs ships a `validate-links` integration. Add a script to `apps/docs/package.json`:
```json
"check:links": "fumadocs-mdx && node ./scripts/check-links.mjs"
```
Follow the Fumadocs "Validate Links" integration docs to create `apps/docs/scripts/check-links.mjs` (it uses `printErrors(validateFiles(...))` against the built page tree). If the integration API differs in the installed version, use its documented entry point.

- [ ] **Step 2: Run it**

```bash
pnpm --filter @rovenue/docs check:links
```
Expected: exits 0, no broken internal links. Fix any reported broken `/docs/...` links (most likely a slug typo in a cross-reference).

- [ ] **Step 3: Commit**

```bash
git add apps/docs/package.json apps/docs/scripts
git commit -m "docs(ci): internal link validation for the docs site"
```

---

### Task 9: Deploy — Docker image, Caddy, compose, runbook

**Files:**
- Create: `apps/docs/Dockerfile`
- Create: `deploy/caddy/Caddyfile.docs`
- Modify: `deploy/caddy/Caddyfile`
- Modify: `docker-compose.yml`
- Modify: `docs/operations/deployment.md`

- [ ] **Step 1: Write the Dockerfile** (mirrors `apps/dashboard/Dockerfile`)

`apps/docs/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1

# Builder — install workspace deps, build + prerender the docs site
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* .npmrc* ./
COPY apps/docs/package.json ./apps/docs/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk-rn/package.json ./packages/sdk-rn/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/docs ./apps/docs

RUN pnpm --filter @rovenue/docs build

# Runtime — Caddy serving the prerendered static output
FROM caddy:2-alpine AS runtime
COPY deploy/caddy/Caddyfile.docs /etc/caddy/Caddyfile
COPY --from=builder /app/apps/docs/build/client /srv
EXPOSE 80
```
Note: confirm the React Router static output path. With `ssr: true` + prerender, client assets land in `build/client`. If the installed React Router version emits a different directory, adjust the `COPY --from=builder` source accordingly (verify with `ls apps/docs/build` after Task 2's build).

- [ ] **Step 2: Write `deploy/caddy/Caddyfile.docs`** (mirrors `Caddyfile.dashboard`)

```
# Static file server for the prerendered docs site. Baked into the docs
# image, run on :80 inside the docker network; the edge Caddy reverse-proxies
# docs.rovenue.app here.
:80 {
	root * /srv
	encode zstd gzip
	try_files {path} {path}/index.html /index.html
	file_server
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
	header /index.html Cache-Control "no-cache"
}
```

- [ ] **Step 3: Add the edge host block**

In `deploy/caddy/Caddyfile`, add this block **immediately after** the existing `app.rovenue.app { … }` block and **before** the `rovenue.app, *.rovenue.app, edge.rovenue.app { … }` wildcard (most-specific host wins; the wildcard otherwise routes docs traffic to the API):
```
# -------------------------------------------------------------
# Docs site — explicit host, proxied to the static-serving docs
# container. Must precede the *.rovenue.app wildcard.
# -------------------------------------------------------------
docs.rovenue.app {
	encode zstd gzip
	reverse_proxy docs:80
}
```

- [ ] **Step 4: Add the compose service**

In `docker-compose.yml`, add under `services:` (next to `dashboard`):
```yaml
  # Docs site — built by apps/docs/Dockerfile, served as prerendered static
  # files. No published ports; only Caddy reaches it on the docker network.
  docs:
    build:
      context: .
      dockerfile: apps/docs/Dockerfile
    restart: unless-stopped
```
Add `docs` to the `caddy` service's `depends_on` list (alongside `dashboard`):
```yaml
    depends_on:
      api:
        condition: service_started
      dashboard:
        condition: service_started
      docs:
        condition: service_started
```
(Match the existing `depends_on` condition style in the file.)

- [ ] **Step 5: Update the deployment runbook**

In `docs/operations/deployment.md`:
- Prerequisites: add `docs.rovenue.app` to the DNS A-record list.
- Build step: note `docker compose build` now also builds `docs`.
- Smoke test: add `curl -I https://docs.rovenue.app` → expect `200`.

- [ ] **Step 6: Build the docs image**

```bash
docker compose build docs
```
Expected: image builds; the `pnpm --filter @rovenue/docs build` layer succeeds and `/srv` is populated.

- [ ] **Step 7: Smoke-test serving through Caddy locally**

```bash
docker compose up -d docs caddy
# The edge resolves by Host header; test the docs container directly:
docker compose exec caddy wget -qO- --header="Host: docs.rovenue.app" http://localhost/ | head -20
```
Expected: HTML of the landing page (contains "Rovenue SDK"). Tear down: `docker compose down`.

- [ ] **Step 8: Commit**

```bash
git add apps/docs/Dockerfile deploy/caddy/Caddyfile.docs deploy/caddy/Caddyfile docker-compose.yml docs/operations/deployment.md
git commit -m "feat(deploy): docs site container behind Caddy at docs.rovenue.app"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full clean build**

```bash
pnpm --filter @rovenue/docs build
```
Expected: succeeds; every IA page under `content/docs/**` prerenders. No MDX/type errors.

- [ ] **Step 2: Dev smoke — spot-check the tab persistence**

```bash
pnpm --filter @rovenue/docs dev
```
Open `/docs/guides/entitlements`, switch to Swift, navigate to `/docs/guides/credits` — verify the tab stays on Swift (`groupId="platform"` persistence). Verify search returns SDK pages. Stop the server.

- [ ] **Step 3: Link check**

```bash
pnpm --filter @rovenue/docs check:links
```
Expected: exits 0.

- [ ] **Step 4: Confirm no Next.js dependency**

```bash
grep -ri "next" apps/docs/package.json || echo "OK: no next dependency"
```
Expected: `OK: no next dependency`.

- [ ] **Step 5: Final commit (if any fixes were made)**

```bash
git add -A
git commit -m "docs: final verification fixes for the SDK docs site"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 (Fumadocs/React Router setup, integrations preserved) · Task 2 (landing + IA + prerender) · Tasks 3–7 (all content sections) · Task 7 (thin READMEs) · Task 8 + 10 (link validation) · Task 9 (full deploy: Dockerfile, Caddyfile.docs, edge host block, compose service, runbook) — every spec section maps to a task.
- **Accuracy rule:** all signatures come from the "Source-of-truth API facts" block, which was verified against `librovenue.udl` and the three façades. Where a per-platform name (Swift enum case, Kotlin exception subclass, React Router build dir) cannot be 100% confirmed from this plan, the step says **verify against source** rather than guess.
- **No invented APIs:** the SDK does not call StoreKit/Play Billing — purchase tokens always come from the host app. This is stated on the index, core-concepts, quickstart, and processing-purchases pages.
