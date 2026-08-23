# Dashboard production readiness: dead controls, broken links, unreachable pages

**Date:** 2026-08-23
**Status:** Approved, ready for planning
**Source:** production-readiness audit of `apps/dashboard`, 2026-08-23

---

## 1. What this is

The dashboard's data layer is sound. `tsc --noEmit` is clean, 118 test files / 1005 tests are green,
every sidebar link resolves to a real route, and every data hook reaches a real endpoint — the Hono
RPC client is typed against `AppType`, and the five untyped `api()` paths were each verified against
`apps/api/src/routes`.

What is not sound is the edge: roughly seventy defects sitting between a working backend and the
user, plus 166 translation keys that never reached `en.json`. Thirty-one controls render and do
nothing. Two complete, wired pages have no entry point. Four
external links point at an organisation that does not exist. The SDK page hardcodes Rovenue Cloud's
API origin, so a self-hosted install hands its users copy-paste snippets aimed at someone else's
server. Sixteen translation keys render as raw dotted identifiers. There is no error boundary and no
404 page anywhere in the application.

This spec covers those. It changes no data model, no endpoint contract, and no route path.

### 1.1 What this is not

- **Not a redesign.** No visual language changes. Controls are wired, removed, or left alone.
- **Not new product surface.** Nothing here builds a feature that does not already have a backend.
  The one exception is the command palette (§4.1), which is navigation over an existing data
  structure, and it is called out as such.
- **Not full i18n.** `funnel-builder` (20 files) and `rovi` (15 files) contain zero `t()` calls and
  stay that way. See §7.3.
- **Not a docs-writing project.** Where a dashboard concept has no documentation page, the control
  that pointed at it is removed rather than backfilled with prose.

---

## 2. Decisions taken during design

Five decisions were taken. Each is recorded with what it removed from the work, because the removals
are what keep this tractable.

### 2.1 Dead controls: wire what has a backend, remove what does not

The alternative — writing the missing docs pages, endpoints and UI features so that every existing
button becomes real — turns a cleanup into a quarter of product work. The alternative in the other
direction — deleting every dead control — would strip genuinely expected capabilities (creating a
product from the empty state, upgrading a plan, rotating a leaked secret key).

The rule is mechanical: **a control stays only if something already exists for it to call.** That
splits the 31 into 12 wired, 17 removed, 2 replaced, with no judgement calls left for implementation
time. §4 is the full table.

**Removed from scope:** five new documentation pages (experiments runbook, SQL reference, cohorts,
funnels, feature flags), a feature-flag import endpoint, a transaction webhook-redelivery endpoint,
column/sort UI for the live-events table.

### 2.2 One shared toast, not inline messages per call site

Twelve controls are being wired and most need success/failure feedback. Seven `window.alert()` calls
already exist in `experiments/`. Both problems have the same answer, and solving it once is smaller
than solving it twelve times.

A dependency (`sonner`) was considered and rejected: it needs a theme-adaptation layer for the `rv-*`
tokens, which is most of what writing the primitive costs anyway, plus a bundle and a dark/light
audit.

**Removed from scope:** per-call-site inline feedback UI; a new npm dependency.

### 2.3 The Swift install snippet is removed, not corrected

The dashboard's SDK page tells iOS users:

```swift
.package(url: "https://github.com/rovenue/rovenue-ios", from: "0.6.0")
```

Three things are wrong with that line, and the third is not fixable here:

1. The organisation is `broverse`, not `rovenue` (`git remote`).
2. The version is `0.6.0`; the Swift podspec says `0.16.0`.
3. **There is no SPM-consumable Swift package.** `packages/sdk-swift/Package.swift` declares
   `.unsafeFlags(["-L../../target/release"])`. SPM refuses to resolve a dependency package that uses
   `unsafeFlags`, and the path escapes the package directory regardless. There is no separate
   `rovenue-ios` repository; the manifest lives in a monorepo subdirectory, which SPM also cannot
   consume from a git URL.

So the snippet cannot be made true by editing it. CocoaPods is the intended distribution —
`packages/sdk-swift/Rovenue.podspec` downloads a prebuilt zip from GitHub releases — and that is what
the dashboard will show.

The podspec's own `source` URL points at `github.com/rovenue/rovenue/releases/...`, the same
non-existent organisation. That is a packaging bug outside `apps/dashboard`, but it is directly in
the path of "make the install instructions correct", so it is fixed here as a one-line change (§5.1).

**Explicit follow-up, out of scope:** publishing a real SPM distribution needs a mirror repository
with a root `Package.swift` and a binary target, plus release automation. That is its own project.
Until it exists, the dashboard must not imply otherwise.

**Assumption stated:** `github.com/broverse/rovenue` is publicly readable. If it is private, none of
the GitHub links in the dashboard work for end users and the correct fix is different — flag this
before implementing §5.1.

### 2.4 Terms / Privacy / Status links are host-mode conditional

`routes/login.tsx` renders Terms of Service and Privacy Policy links inside the consent sentence the
user is agreeing to, as `href="#"`. The footer adds dead Docs, Status, Privacy and Terms links.
`sdk-content.ts:257` adds a dead `status.rovenue.io` resource card — a subdomain the Caddyfile does
not define, so it falls through the `*.rovenue.io` wildcard to the API and 404s.

Docs has a real target. Terms, Privacy and Status do not, and inventing URLs for a self-hosted AGPL
deployment would be worse than the dead link: a self-hoster's users would be pointed at Rovenue's
legal pages for a service Rovenue does not operate.

So these three become configurable and conditional: `VITE_TERMS_URL`, `VITE_PRIVACY_URL`,
`VITE_STATUS_URL`. When a variable is unset, the link is **not rendered at all** — not rendered
disabled, not rendered pointing at a fallback. Rovenue Cloud sets them at build time; self-host
deployments set them if they have them.

The consent sentence needs care: its i18n string embeds two links via `<Trans>`. When the URLs are
unset the sentence must still read correctly, so `auth.signIn.terms` gets a second variant without
link markup, selected by whether the URLs are configured.

### 2.5 The custom-host guard is narrowed

`__root.tsx` renders an `Unavailable` screen when `lookupFailed && !onCanonicalHost`. The intent is
sound: never serve Rovenue's login form from a third party's domain.

But `onCanonicalHost` derives from `VITE_DASHBOARD_HOST`, and that variable is **not a build arg in
`apps/dashboard/Dockerfile`** — only `VITE_API_URL`, `VITE_HOST_MODE` and `VITE_ALLOW_REGISTRATION`
are. There is no way to set it in the shipped image. Unset, `isCanonicalDashboardHost()` always
returns `false`, so a single transient failure of the custom-host lookup replaces the entire
dashboard with "Unavailable" for that page load.

Two changes, both needed:

- `VITE_DASHBOARD_HOST` becomes a build arg, threaded through `docker-compose.yml` and documented in
  `.env.example`.
- The guard is narrowed to fire only when the canonical host is **known and does not match**. Unknown
  canonical host now falls through to the dashboard. The original protection survives — a deployment
  that configures its canonical host still refuses to render login on foreign domains — while the
  self-lockout mode disappears.

`lib/custom-host.ts` documents the current unset-means-false behaviour as deliberate ("the variable
is an optimisation that skips one request, not a feature switch"). That reasoning holds for
`isCanonicalDashboardHost` itself and it is not being changed; what changes is how `__root.tsx`
combines it with `lookupFailed`.

---

## 3. Shared parts

Three pieces are built first because the page-level work consumes them.

### 3.1 `src/ui/toast.tsx`

Dependency-free provider plus `useToast()`. Follows the existing `ui/` primitive conventions —
`rv-*` tokens, no hardcoded colours, named constants for durations and z-index per the project's
no-magic-values rule.

- `toast.success(message)` / `toast.error(message)` / `toast.info(message)`
- Auto-dismiss with a named default duration; errors persist until dismissed
- `role="status"` with `aria-live="polite"`; errors use `aria-live="assertive"`
- Mounted in `DashboardShell` and `AccountShell` — the two shells every authenticated route renders
  under

Consumers: the twelve wired controls in §4.1, and the seven `window.alert()` call sites in
`components/experiments/experiment-hero.tsx` and
`routes/_authed/projects/$projectId/experiments/new.tsx`.

### 3.2 `src/ui/error-boundary.tsx` and router integration

`createRouter()` gains `defaultErrorComponent` and `defaultNotFoundComponent`. Both render one shared
full-page shell:

- Error: message, "try again" (`router.invalidate()`), "back to project"
- Not found: same shell, different copy, no retry

`__root.tsx`'s existing `Unavailable` component is refactored onto the same shell. Three independent
full-page error screens is the outcome to avoid; there is one, parameterised.

Scope note: this is route-level. A React render error inside a mounted component is caught by
TanStack Router's own boundary and surfaces through `defaultErrorComponent`.

### 3.3 `src/lib/docs-links.ts`

One `DOCS` constant holding `DOCS_URL`, `API_REFERENCE_URL`, `CHANGELOG_URL`, `GITHUB_URL`, the
host-mode-conditional `TERMS_URL` / `PRIVACY_URL` / `STATUS_URL`, and the per-page deep links used in
§4.1.

Current consumers, each of which hardcodes its own copy today: `components/sdk-api/sdk-content.ts`,
`components/apps/mock-data.ts` (which exports a second `DOCS_URL`), `components/dashboard/topbar.tsx`,
`routes/login.tsx`.

This file is also the single application point for the wrong-organisation fixes in §5.1 — after it
exists, no GitHub or docs URL is written anywhere else in the dashboard.

---

## 4. Dead controls

### 4.1 Wired (12)

| Control | File | Target |
|---|---|---|
| Products empty-state "Create product" | `components/products/products-table.tsx:126` | existing `openCreate`, passed down as a prop |
| Account → Usage "Upgrade" | `routes/_authed/account/usage.tsx:59` | navigate to `/projects/$projectId/settings/billing`; the page already derives `projectId` |
| SDK secret "Rotate" | `components/sdk-api/secret-row.tsx:83` | confirm dialog → existing revoke (`projects.ts:520`) → existing `CreateApiKeyDialog` |
| Avatar "Remove" | `components/account/avatar-editor.tsx:43` | `PATCH /dashboard/me { image: null }` |
| Profile "Cancel" | `routes/_authed/account/profile.tsx:198` | reset form to server values |
| Webhook deliveries "Retry" | `routes/_authed/projects/$projectId/apps_.webhooks.tsx` | `POST /dashboard/webhooks/:id/retry` — **backend works, no UI exists**; button added on `DEAD` rows only, matching the endpoint's own guard |
| Products "SDK snippet" | `routes/_authed/projects/$projectId/products.tsx:376` | navigate to `/projects/$projectId/sdk` |
| Transaction inspector copy-id | `components/transactions/transaction-inspector.tsx:87` | `CopyButton` primitive; icon corrected `BookOpen` → `Copy` |
| Access "Guide" | `routes/_authed/projects/$projectId/access.tsx:120` | `docs/guides/entitlements` |
| Offerings "Guide" | `routes/_authed/projects/$projectId/offerings.tsx:140` | `docs/guides/placements-and-paywalls` |
| Topbar search | `components/dashboard/topbar.tsx:39` | command palette — see below |
| Subscriptions "Billing issues → View all" | `components/subscriptions/billing-issues-panel.tsx:39` | navigate to the subscriptions list with `search: { hasIssue: true }` — the param already exists in `SubsSearch` and `validateSearch` (`subscriptions.tsx:65,132`) |

**Command palette.** The only item here that is new UI rather than a reconnection. It is included
because the topbar advertises `⌘K` on every page and no global handler exists — the shortcut is bound
only inside the Rovi prompt input, which requires the Rovi panel to already be open.

Scope is navigation and nothing else: `NAV_SECTIONS` from
`components/dashboard/navigation.ts` is already the exact data structure needed — id, label key,
icon, route. The palette filters it, `⌘K` / `Ctrl+K` opens it, Enter navigates. Subscriber, product
and transaction search are explicitly not in scope. The existing `⌘.` binding in `rovi-provider.tsx`
is untouched; the palette's handler must not swallow it.

### 4.2 Removed (17)

No documentation page exists for the topic:
`experiments/index.tsx:142` "Runbook" · `queries.tsx:357` "SQL reference" · `cohorts.tsx:136` "How
cohorts work" · `funnels.tsx:348` "Funnels guide" · `feature-flags/index.tsx:185` "SDK docs"

No endpoint exists:
`feature-flags/index.tsx:189` "Import" · `transaction-inspector.tsx:163` "Redeliver webhook"

Duplicate of a working control:
`transaction-inspector.tsx:90` "⋯" — `TransactionActionsMenu` sits beside it ·
`transactions.tsx:644` date-range button — `TxFilterBar` already sends `from`/`to`, and the API
accepts them (`filterShape`, `transactions.ts:83`) · `charts/chart-toolbar.tsx:97` "⋯" — chart
deletion is already wired via `onDelete` in `charts.tsx:115`

No behaviour behind it and none planned:
`live-events.tsx:313,317` "Columns" + "Sort" · `dashboard/recent-activity-panel.tsx:74` "⋯" ·
`dashboard/system-health-panel.tsx:33` "Status page" · `subscriptions/expanded-row.tsx:191` "⋯" ·
`queries/results-panel.tsx:315` "Bar" — a chart-type selector with one option; the chart tab it sits
in already works

Dead code that never renders:
`billing/payment-method-row.tsx:47` — the `actions ?? <Button>{t("common.edit")}</Button>` fallback.
The single caller (`settings/payment-methods.tsx:94`) always passes `actions`. The prop becomes
required and the fallback goes.

### 4.3 Replaced (2)

`components/project-setup/step-platforms.tsx:105,137` — the iOS `.p8` and Android service-account
JSON "upload" buttons. `routes/_authed/projects.setup.tsx:86` already documents why they do nothing:
"google & stripe both require uploads / OAuth and remain TODO".

There is no file-upload endpoint for store credentials. The Stores page accepts them as pasted text
(`components/stores/store-credential-card.tsx`), which works.

The fix reuses the pattern the Stripe branch in the same file already uses for create mode: instead
of a button that does nothing, a line of copy pointing at where the real flow lives, becoming a link
to the Stores page once a `projectId` exists.

---

## 5. Independent text and config fixes

These depend on nothing and are sequenced first.

### 5.1 Wrong GitHub organisation

Canonical remote is `github.com/broverse/rovenue`. Wrong in four places:

- `routes/login.tsx:295` → `github.com/rovenue`
- `components/sdk-api/sdk-content.ts:250` community link → `github.com/rovenue`
- `components/sdk-api/sdk-content.ts:27` changelog → `github.com/rovenue/rovenue/releases`
- `packages/sdk-swift/Rovenue.podspec:20` `source` → `github.com/rovenue/rovenue/releases/download/...`

`components/dashboard/topbar.tsx:64` is already correct. After §3.3 the dashboard's three all read
from `DOCS.GITHUB_URL`. The podspec is edited directly.

The SPM snippet at `sdk-content.ts:57,128` is removed rather than corrected — §2.3.

### 5.2 Stale SDK versions

`sdk-content.ts` says `0.6.0`. All three SDKs are actually `0.16.0` — ten minor versions behind:

| SDK | Source of truth |
|---|---|
| React Native | `packages/sdk-rn/package.json` → `version` |
| Swift | `packages/sdk-swift/Rovenue.podspec` → `s.version` |
| Kotlin | `packages/sdk-kotlin/build.gradle.kts:10` → `version = "0.16.0"` |

Constants are updated **and** a unit test is added that reads all three from those manifests and
asserts the dashboard constants match. Hand-maintained version strings drift; this makes the drift a
red test instead of a silent lie.

### 5.3 SDK base URL derived, not hardcoded

`sdk-content.ts:20` hardcodes `https://api.rovenue.io/v1`. Every curl and init snippet on the SDK page
inherits it, so a self-hosted dashboard instructs its users to call Rovenue Cloud.

It becomes derived from `API_BASE_URL` in `lib/api.ts` (i.e. `VITE_API_URL`). The
`.replace(/\/v1$/, "")` workaround in `components/sdk-api/endpoints-card.tsx:119` exists only to undo
the hardcoded suffix and is deleted with it.

### 5.4 Login page links

`routes/login.tsx:165` (the `<Trans>` consent sentence) and `:294-300` (footer). Docs resolves to
`DOCS.DOCS_URL`; Terms, Privacy and Status follow §2.4 — rendered only when configured. The GitHub
link is corrected per §5.1. `sdk-content.ts:257`'s status-page resource card follows the same rule.

### 5.5 `VITE_DASHBOARD_HOST` build arg and the narrowed guard

Per §2.5:

- `apps/dashboard/Dockerfile` — `ARG VITE_DASHBOARD_HOST` / `ENV VITE_DASHBOARD_HOST=...`, alongside
  the three existing ones
- `docker-compose.yml` — `VITE_DASHBOARD_HOST: ${DASHBOARD_HOST:-}` under the dashboard build args
- `.env.example:81` — uncommented and documented
- `routes/__root.tsx` — the `Unavailable` branch fires only when the canonical host is known and does
  not match

---

## 6. Unreachable pages and fake data

### 6.1 Two complete pages with no entry point

`/projects/$projectId/settings/notifications` — a working OWNER/ADMIN editor for project notification
defaults, wired to `useProjectNotificationDefaults`. Absent from `ALL_TABS` in
`routes/_authed/projects/$projectId/settings/route.tsx` and linked from nowhere. It gets a tab, `Bell`
icon, `billingOnly: false`.

`/projects/$projectId/edit` — the project setup wizard in edit mode, fully implemented against
`useUpdateProject`. Nothing navigates to it. It gets an entry point from the project's Settings →
General page.

### 6.2 Hardcoded experiments badge

`components/dashboard/navigation.ts:122` — `badge: "3"` on the Experiments nav item. Always reads
"3". Binding it to a real count means the sidebar issues a query on every project; the badge is
removed instead. `badge: "web"` on Funnels stays — it is a scope label, not a count.

### 6.3 Another product's domain in the funnel dialog

`routes/_authed/projects/$projectId/funnels.tsx:868` renders the new funnel's public URL preview as
`https://funnels.posely.app/{slug}`. The funnel's real publishing domain already flows through the
`domain` prop in `components/funnel-builder/share-tab.tsx`; the dialog uses the same source, and falls
back to a neutral placeholder when no domain is configured rather than naming a third party's host.

### 6.4 The static SQL preview card

`components/charts/sql-preview-card.tsx` renders a fixed string from `charts/mock-data.ts` regardless
of the selected chart, and its "Open in Queries" button navigates without carrying the SQL.

The card is removed. There is no endpoint that produces a chart's underlying SQL, so it cannot be made
truthful, and its one working affordance duplicates the "Open in Queries" button already in the page
header (`charts.tsx:139`).

`SQL_PREVIEW` and the unused `SUBSCRIBERS` / `TIMELINE_MOCK` exports go with it.

### 6.5 Rovi tools that promise what the backend cannot do

`apps/api/src/services/copilot/tools/query-metrics.ts` registers `query_metrics_churn` and
`query_metrics_conversion` and both return "not implemented" strings (`:43`, `:53`). The model is told
it can answer churn and conversion questions; the user gets a failure message, and
`components/rovi/tools/metrics-chart.tsx:40` renders a "not implemented yet" box.

Both are removed from the tool registry (`tools/index.ts`, `tools/query-metrics.ts`, and the name list
in `registry.test.ts`). The model then declines the question honestly instead of calling a tool that
cannot work. `query_metrics_mrr` is unaffected. When the ClickHouse views land, the tools return.

`metrics-chart.tsx`'s fallback branch stays — it is correct defensive rendering for an unknown tool
name.

---

## 7. Translations

### 7.1 Sixteen keys that render as raw identifiers

Missing from `src/i18n/locales/en.json` with no inline fallback, so the dotted key itself reaches the
screen. Verified against plural forms — `_one`/`_other` variants were checked and excluded.

Most visible: `subscriptions.term.trial` / `.ends` / `.recurring` (subscription table rows) and
`products.stats.entitlements` (a Products stat card).

Remainder: `access.grantingProducts.unlink`, `access.delete.productCount`,
`access.delete.confirmLabel`, `access.linkProducts.subtitle`, `account.api.revoke`,
`common.unknownError`, `common.notFound`, `cohorts.retention.retry`, `placements.editor.revision`,
`placements.editor.saved`, `placements.editor.row.label`, `placements.card.rows`,
`placements.delete.confirmLabel`, `subscriptions.actions.scheduleDisabledTooltip`,
`subscriptions.table.toggleRow`, `experiments.new.offering.notEnough`,
`experiments.new.offering.inUse`.

### 7.2 166 inline fallbacks folded into `en.json`

Call sites written as `t("some.key", "Some text")` where the key is absent. They render correctly
today, which is why they went unnoticed — and why `en.json` has quietly stopped being the source of
truth for a third of the application's strings.

The fallback text moves into `en.json` and the second argument is deleted from the call site.

**Guard test — `src/i18n/keys.test.ts`.** Walks `src/`, extracts every `t("...")` key, resolves it
against `en.json` including `_one`/`_other` plural forms, and fails listing any that are missing. This
is the audit script from the readiness review, promoted to a test. Without it §7.1 and §7.2 both
regress within a release or two.

The test must be written to fail on the current tree first, then pass once the keys land — a test
authored after the fix proves nothing about whether it detects the fault.

### 7.3 Deliberately out of scope

`components/funnel-builder/` (20 files) and `components/rovi/` (15 files) contain zero `t()` calls —
they are entirely hardcoded English while the rest of the dashboard is fully translated. Translating
them is larger than everything else in this spec combined.

Separately, some files embed English directly in JSX rather than via `t()` — for example
`settings/payment-methods.tsx` ("Set default", `Expires ${month}/${year}`). The guard test in §7.2
cannot see these, since there is no key to check. Both are recorded as follow-up work.

There is one locale (`en.json`) and no language switcher. `src/i18n/config.ts` documents this as
intentional. Unchanged.

### 7.4 A server-produced English string

`apps/api/src/services/metrics/overview.ts:293` returns `metric: "No webhooks yet"`, which the
dashboard renders verbatim in the System Health panel — bypassing i18n entirely. The API returns a
key or a structured value and the dashboard translates it. Small, but it is the only place a server
string reaches the UI untranslated, and leaving it sets the wrong precedent.

---

## 8. Testing

The existing suite (118 files / 1005 tests) stays green throughout; that is a gate on every step, not
a final check.

New tests:

- **Toast** — renders, auto-dismisses after the configured duration, errors persist, `aria-live`
  correct for both severities
- **Error and not-found boundaries** — a route whose loader throws renders the error screen and its
  retry re-invalidates; an unknown URL renders the 404 screen
- **Command palette** — `⌘K` opens, typing filters `NAV_SECTIONS`, Enter navigates, and `⌘.` still
  reaches Rovi
- **i18n key guard** (§7.2) — must be shown failing before the keys are added
- **SDK version sync** (§5.2) — must be shown failing against the current `0.6.0` constants
- **Custom-host guard** (§2.5) — unknown canonical host renders the dashboard; known-and-mismatched
  renders `Unavailable`

Each of the twelve wired controls gets a behavioural test: clicking dispatches the right mutation or
navigation. Asserting an `onClick` prop exists is not a test — it passes against a handler that does
nothing.

Removed controls get no new tests; their existing tests are deleted with them.

**Acceptance:** `tsc --noEmit` clean, `vitest run` green, and a repo scan finding no `href="#"` and no
`<Button>` without `onClick`, `href`, `type="submit"` or a `Link`/`Menu` wrapper. The scan script from
the readiness review moves to `scripts/` so it can run in CI.

---

## 9. Sequencing

1. **Independent fixes** (§5) — no dependencies, immediate user-visible value
2. **Shared parts** (§3) — toast, boundaries, docs registry
3. **Dead controls** (§4) — consumes all three
4. **Unreachable pages and fake data** (§6)
5. **Translations** (§7)

Ordering rationale: every page-level fix in step 3 touches files that steps 1 and 2 also touch. Doing
pages first means revisiting the same files as the shared parts settle.

---

## 10. Open item

One assumption could not be verified from inside the repository:

**`github.com/broverse/rovenue` is publicly readable** (§2.3, §5.1). Every GitHub link the dashboard
shows — community, changelog, the topbar icon — and the podspec's release-download `source` all
depend on it. If the repository is private, those links are broken for end users regardless of which
organisation they name, and §5.1 needs a different answer (a public mirror, or removing the links).
Confirm before implementing §5.1.

Everything else in this spec was verified against the tree: endpoints against
`apps/api/src/routes`, search params against each route's `validateSearch`, SDK versions against
their manifests, docs targets against `apps/docs/content`, and translation keys against `en.json`
including plural forms.

---

## 11. Addendum — independent verification pass (2026-08-23, second session)

An adversarial re-verification sampled every claim class against the tree. Verdict: **sound to
execute as-is**, with the corrections below. Outside §7.1, zero false claims were found — the
dead-control inventory (~26 of 31 sampled), wire/remove/replace splits, endpoint existence for every
spot-checked wire target, orphan pages, org links, hardcoded origin, and missing boundaries all
held.

**§10 open item — CLOSED.** Anonymous `GET api.github.com/repos/broverse/rovenue` returns 200: the
repository is publicly readable. §5.1 can proceed as written.

**§7.1 correction (the one bad section).** The list contains 21 keys, not sixteen, and all 21 are
missing from `en.json` — but 14 of the 21 call sites pass `{ defaultValue: ... }` and render English
fallback, not raw identifiers. The flagship examples (`subscriptions.term.trial/.ends/.recurring`,
`subscriptions.tsx:209-217`) are among the 14 (an authoring-time error — git blame dates those lines
to May 2026). Only **7 keys genuinely reach the screen raw**: `products.stats.entitlements`
(products.tsx:407), `account.api.revoke` (api-key-row.tsx:23), `common.unknownError`
(cohort-form.tsx:71), `common.notFound` (refund-shield responses:46), `cohorts.retention.retry`
(retention-heatmap.tsx:92), `experiments.new.offering.notEnough` and `.inUse` (new.tsx:776, 1322).
Consequences: (a) the other 14 keys join the §7.2 fold-in rather than the urgent list; (b) the §7.2
count undercounts — the audit recognized only the two-arg `t("k","text")` form and is blind to the
options-object `defaultValue` form (~54 occurrences repo-wide); (c) the proposed guard test MUST
parse both fallback forms or it will misreport.

**Small corrections.**
- `window.alert` call sites: 10 in the two named files (6 in experiment-hero, 4 in
  experiments/new), not seven.
- §8's "no `href="#"`" acceptance scan needs an allowlist: `funnel-builder/settings-tab.tsx:61` and
  `funnel-builder/properties-panel.tsx:668` (declared out of scope) and `login.tsx:215` (legitimate
  `preventDefault` link) all trip it.

**Additions found during verification.**
- `sdk-content.ts:117,130,143` `repoLabel` strings also name the dead org; they render as plain text
  (`sdk-package-card.tsx:68`), not links — sweep them in the §5.1 pass.
- A second `posely.app` leftover in mock data: `components/products/product-drawer.tsx:569`
  (`by furkan@posely.app`) — add to the §6 mock-data cleanup.

**Relationship to the backend fix set.** The server-side production blockers verified the same day
(Google RTDN/entitlement/revenue, Apple refund reversal, expiry sweep, webhook durability, paywall
view counts, asset deletion) live in a separate plan:
`docs/superpowers/plans/2026-08-23-store-billing-correctness.md`. The two work streams are
independent; only the asset-library UI (`force` param wiring after the server-side 409 lands) needs
coordination with this spec's owner because that file carries in-progress edits.
