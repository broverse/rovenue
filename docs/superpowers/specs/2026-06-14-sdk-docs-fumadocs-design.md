# SDK Documentation Site — Design

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Author:** V. Furkan (with Claude)

## Problem

Rovenue ships three client SDKs — Swift (iOS/macOS/tvOS/watchOS), Kotlin
(Android/JVM), and React Native — all façades over one shared Rust core
(`librovenue`, UniFFI). Today the only docs are three per-package READMEs
(Installation + Quick Start + Identity/Consent). `apps/docs` is an unconfigured
placeholder (build/dev scripts are `echo`), holding only two integration MDX
files. There is no discoverable, searchable, cross-platform documentation for
SDK consumers.

## Goal

Stand up a public documentation site at `apps/docs` that fully documents all
three SDKs from a single source of truth, exploiting the fact that the public
API surface is **near-identical across platforms** so that every conceptual
page presents Swift / Kotlin / React Native side by side.

## Decisions (locked)

- **Framework:** Fumadocs (Fumadocs UI + Fumadocs MDX + Fumadocs Core).
- **Server framework:** **React Router v7** (Vite-based SSR) — NOT Next.js.
  Chosen for consistency with the existing Vite + React dashboard and for
  mature, low-risk SSR. Fumadocs officially supports React Router.
- **Scope:** Full setup **and** all content (getting-started, guides,
  platforms, reference, resources).
- **Entry:** A simple landing/home page (hero + "Get Started") at the root,
  then the docs under `/docs`.
- **Delivery model:** Docs site is the single source of truth; per-package
  READMEs become thin and link to the site.
- **Deploy:** In scope. Docs ship as a container behind the existing Caddy
  edge at `docs.rovenue.app`, wired into the root `docker-compose.yml`
  (Coolify-ready), mirroring the dashboard's build-and-serve pattern.

## The Core Insight: One Source, Three Platforms

The public API is the same shape everywhere (verified against
`librovenue.udl`, the three façades, and the RN barrel export):

| Capability | Method (shape) |
|---|---|
| Configure | `configure(apiKey, baseUrl, debug?, appVersion?)` |
| Identity | `currentUser()`, `identify(knownUserId)` (client-local; server merge via backend `/v1/subscribers/transfer`) |
| Entitlements | `entitlement(id)`, `entitlementsAll()`, `refreshEntitlements()` (cache-first reads, refresh hits network) |
| Credits | `creditBalance()`, `refreshCredits()`, `consumeCredits(amount, description?)` (server-deduped via internal Idempotency-Key) |
| Receipts | `postAppleReceipt(jws, productId, appAccountToken?)`, `postGoogleReceipt(receipt, productId, obfuscatedAccountId?, obfuscatedProfileId?)` — **SDK never calls StoreKit/Play Billing; the host app purchases and hands the token to the SDK** |
| Lifecycle | `setForeground(bool)`, `shutdown()` |
| Account token | `getAppAccountToken()` / `getOrCreateAppAccountToken()` |
| Logging | `setLogHandler(...)` |
| Change stream | Swift `AsyncStream<ChangeEvent>` · Kotlin `SharedFlow<ChangeEvent>` · RN `addChangeListener` + React hooks |
| RN-only | `useCurrentUser`, `useEntitlement`, `useEntitlements`, `useCreditBalance` |

Shared types: `User`, `Entitlement`, `ReceiptResult`, `ChangeEvent`
(`EntitlementsChanged` / `IdentityChanged` / `CreditBalanceChanged`).
Shared errors: 13 `RovenueError` variants (`NotConfigured`, `InvalidApiKey`,
`ServerError`, `NetworkUnavailable`, `Timeout`, `RateLimited`, `Storage`,
`UserNotFound`, `InsufficientCredits`, `EntitlementInactive`,
`DuplicatePurchase`, `ReceiptInvalid`, `Internal`).

This justifies the central documentation pattern: a persistent platform tab
group on every concept page.

## Information Architecture

```
content/docs/
├── index.mdx                        Introduction — Rust-core + façade model, what the SDK does / does NOT do
│
├── getting-started/
│   ├── meta.json                    { "pages": ["installation","quickstart","core-concepts"] }
│   ├── installation.mdx             platform-tabbed install (npm / SPM+CocoaPods / Gradle)
│   ├── quickstart.mdx               configure → check entitlement → process a purchase, in ~5 min
│   └── core-concepts.mdx            anon vs known user, entitlement vs product, cache-first + refresh,
│                                    "the SDK does not call StoreKit/Play Billing"
│
├── guides/                          task-oriented, all platform-tabbed
│   ├── meta.json
│   ├── configuring.mdx              configure(), appVersion auto-read, debug flag
│   ├── identifying-users.mdx        identify / currentUser + the backend transfer merge model
│   ├── entitlements.mdx             cache reads, refreshEntitlements, reacting to changes
│   ├── processing-purchases.mdx     postAppleReceipt (StoreKit 2 JWS) / postGoogleReceipt + appAccountToken
│   ├── credits.mdx                  creditBalance / consumeCredits + idempotency semantics
│   ├── reacting-to-changes.mdx      AsyncStream / SharedFlow / addChangeListener / React hooks
│   ├── app-lifecycle.mdx            setForeground, foreground polling, session events
│   └── identity-consent.mdx         PII SHA-256 hashing + data-processor/controller split (ported from READMEs)
│
├── platforms/                       platform-specific setup nuances
│   ├── meta.json
│   ├── react-native.mdx             Expo config plugin, hooks, bare RN notes
│   ├── ios-swift.mdx                SPM + CocoaPods, AppDelegate/SceneDelegate foreground wiring
│   └── android-kotlin.mdx           Gradle, Application wiring, coroutine-scope caveat for `changes`
│
├── reference/                       API reference — platform-tabbed tables
│   ├── meta.json
│   ├── methods.mdx                  every method: signature, params, return, throws (per platform)
│   ├── types.mdx                    User, Entitlement, ReceiptResult, ChangeEvent
│   └── errors.mdx                   13 RovenueError variants × (RN class / Swift enum / Kotlin exception)
│
└── resources/
    ├── meta.json
    ├── versioning.mdx               SDK version alignment with the shared core
    └── migrating-from-revenuecat.mdx   positioning / migration mapping (optional but valuable)
```

Sidebar order is controlled by `meta.json` in each folder. Root `meta.json`
orders the top-level sections.

## The Platform-Tabs Pattern

Every concept/guide page uses a persistent tab group keyed by `groupId="platform"`
so a reader's choice (e.g. Swift) sticks across all pages:

```mdx
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';

<Tabs groupId="platform" persist items={['React Native', 'Swift', 'Kotlin']}>
  <Tab value="React Native"> ```tsx … ``` </Tab>
  <Tab value="Swift">        ```swift … ``` </Tab>
  <Tab value="Kotlin">       ```kotlin … ``` </Tab>
</Tabs>
```

Auto-generated table of contents and built-in search (Orama) come for free
from Fumadocs UI.

## Site Architecture (apps/docs)

Scaffold with `npm create fumadocs-app` using the **React Router** template
(or follow Fumadocs' manual React Router installation), then adapt into the
monorepo:

```
apps/docs/
├── package.json            react-router + @react-router/* + fumadocs-ui + fumadocs-mdx + fumadocs-core
├── vite.config.ts          react-router plugin + fumadocs MDX integration
├── react-router.config.ts  SSR config (ssr: true)
├── source.config.ts        Fumadocs MDX collection — points at content/docs/**
├── app/
│   ├── root.tsx            RootProvider (theme + search), global layout
│   ├── routes.ts           route table
│   ├── routes/
│   │   ├── home.tsx        landing: hero + "Get Started" → /docs
│   │   └── docs.tsx        /docs/* — renders the Fumadocs DocsLayout + page tree
│   └── lib/source.ts       loader() → page tree for the sidebar
└── content/docs/           the .mdx tree above
```

- The existing `apps/docs/content/integrations/*.mdx` files are moved under
  `content/docs/` (or kept as a separate `integrations` section) so nothing is
  lost.
- `package.json` scripts replace the `echo` placeholders with real
  `dev` / `build` / `start` commands.
- Turborepo `turbo.json` gains a real `build` for `@rovenue/docs`.
- Deploy is covered in the **Deployment** section below.

## Components / Units

1. **Docs app shell** (`apps/docs/app/*`) — React Router routes, root layout,
   Fumadocs providers, the loader that builds the page tree. One job: render
   MDX content with navigation + search.
2. **MDX content tree** (`content/docs/**`) — the actual documentation. Each
   file is self-contained and independently reviewable.
3. **Shared MDX snippets** — where the same prose/code repeats (e.g. the
   consent table), factor into a reusable MDX include rather than copy-paste.
4. **Thin READMEs** — each SDK README trimmed to a short blurb + install + a
   link to the relevant docs site section.

## Content Sourcing (accuracy)

All code samples and reference tables are derived from the real source:
`librovenue.udl`, `packages/sdk-rn/src/**`, `packages/sdk-swift/Sources/**`,
`packages/sdk-kotlin/src/main/**`. No invented APIs. The "SDK does not call
StoreKit/Play Billing" and "identify is client-local" invariants are stated
explicitly on the relevant pages, matching the README guarantees.

## Deployment

The site deploys behind the existing infrastructure, mirroring the dashboard's
proven build-and-serve pattern (`apps/dashboard/Dockerfile` +
`deploy/caddy/Caddyfile.dashboard` + a Caddy host block + a compose service).

**Serving mode — static, served by Caddy (recommended).**
React Router v7 docs content is fully static; we prerender all routes to static
HTML (React Router prerender / Fumadocs static build) and serve them with Caddy,
exactly like the dashboard. This reuses a proven pattern, adds no long-running
Node process, and is the cheapest, lowest-failure-mode option. React Router
remains the build framework (honoring the "not Next.js" decision); SSR-at-runtime
buys nothing for static docs.
(Alternative, documented but not chosen: a Node container running
`react-router-serve` for true runtime SSR, reverse-proxied by Caddy. Flip to
this only if a future need for per-request rendering appears.)

**1. Dockerfile** — `apps/docs/Dockerfile`, multi-stage, monorepo build context:
- Builder (`node:22-alpine` + pnpm): install workspace deps, build + prerender
  the docs site to a static `dist`/`build/client` directory.
- Runtime (`caddy:2-alpine`): copy the static output to `/srv`, copy a docs
  Caddyfile, `EXPOSE 80`.
- Note: `apps/dashboard/Dockerfile` already COPYs `apps/docs/package.json` into
  its install layer, so the workspace is already aware of the docs package.

**2. Static-serving Caddyfile** — `deploy/caddy/Caddyfile.docs`, modeled on
`Caddyfile.dashboard`: `root * /srv`, `try_files {path} /index.html`,
`file_server`, long-cache fingerprinted assets, `no-cache` for HTML.

**3. Compose service** — add a `docs` service to the root `docker-compose.yml`:
```yaml
docs:
  build:
    context: .
    dockerfile: apps/docs/Dockerfile
  restart: unless-stopped
```
No published ports (only Caddy reaches it on the docker network), no env vars
baked at build time (docs are content-only; unlike the dashboard there is no
`VITE_API_URL` to inline).

**4. Edge routing** — add an explicit host block to `deploy/caddy/Caddyfile`
**above** the `*.rovenue.app` wildcard (most-specific host wins in Caddy; the
wildcard currently routes to `api`, so without this `docs.rovenue.app` would
hit the API):
```
docs.rovenue.app {
    encode zstd gzip
    reverse_proxy docs:80
}
```
Place it next to the existing `app.rovenue.app` block.

**5. DNS** — add an A record for `docs.rovenue.app` → host (or a CNAME to the
canonical surface). Add it to the prerequisites in the deployment runbook.
Certs are issued automatically by Caddy via standard ACME (the hostname is
explicit, not on-demand), reusing the persisted `caddy-data` volume.

**6. Runbook** — update `docs/operations/deployment.md`: new `docs` service in
the build/start steps, the new DNS record in prerequisites, and a smoke-test
line (`curl -I https://docs.rovenue.app` returns 200).

## Out of Scope

- Auto-generating reference from the UDL (UniFFI renames per platform; hand-
  curated tables are more reliable). Noted as possible future work.
- Runtime SSR for docs (the Node `react-router-serve` container) — documented
  as an alternative above but not built; static serving is chosen.
- API server (REST) reference — this project is SDK docs only.
- i18n / translations.

## Success Criteria

- `pnpm --filter @rovenue/docs dev` serves the site locally; `build` produces
  output without errors.
- All IA pages exist with real, source-accurate content (no stubs).
- Platform tabs work and persist across pages; search returns SDK pages.
- Each SDK README is trimmed and links to the site.
- No Next.js dependency anywhere in `apps/docs`.
- `docker compose build docs` succeeds; `docker compose up docs caddy` serves
  the site, reachable through Caddy at the `docs.rovenue.app` host block.
- Deployment runbook updated (service, DNS, smoke test).

## Testing

- Build + dev server smoke (site compiles, routes resolve, no MDX errors).
- A link-validation pass (Fumadocs `validate-links` integration) to catch
  broken internal links.
- Manual spot-check that code samples match the real method signatures.
- Docker image builds and the static output is served; Caddy host block routes
  `docs.rovenue.app` to the docs container (local smoke via `Host:` header).
