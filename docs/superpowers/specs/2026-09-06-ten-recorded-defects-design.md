# The ten defects recorded during ROADMAP §11

Written 2026-09-06, immediately after §11 closed. These ten were found *while*
doing §11 and deliberately not fixed there — each was outside a documentation
batch's remit, and several are wire-visible or touch live data. This spec
resolves all ten, and rules one of them to be a different defect than recorded.

## Why they were deferred, and why that ends here

Deferring them was right: a docs batch that quietly changes what an API returns,
or runs `create_parent` against populated partitions, is a batch nobody can
review. But "recorded on the ROADMAP" is not a resting state — two of these are
security-adjacent, one is a dated failure, and one makes a shipped SDK
unusable in a real consumer app.

They are not one piece of work. They span an API behaviour change, a live-data
migration, a crypto-tool rewrite, an architectural docs change, and three
one-line corrections. The phases below are ordered so a failure in the risky
ones cannot strand the cheap ones.

---

## Phase G — three corrections that are simply wrong today

### G1. `withRovenueAndroid.ts` produces a non-resolving Android build

`packages/sdk-rn/plugin/withRovenueAndroid.ts` emits `includeBuild(<path>)` plus
`implementation("dev.rovenue:sdk:0.1.0")`. Gradle's composite substitution
matches by **project name** (`sdk-kotlin`), not the maven-publish coordinate
(`dev.rovenue:sdk`), so the dependency never resolves. Reproduced during §11;
`packages/sdk-flutter/rovenue_flutter_android/android/settings.gradle` already
carries the required `dependencySubstitution` rule for the identical reason.

Fix: emit the substitution rule alongside `includeBuild`. Verified by building
`examples/android-kotlin` with the plugin's exact emitted wiring, and by a unit
test over the plugin's output.

### G2. `RovenueFFI.xcframework` is required but gitignored

`packages/sdk-swift/Package.swift` requires it; `.gitignore` excludes it. A fresh
clone cannot resolve the Swift package at all, and the prerequisite is documented
nowhere. CI works only because `sdk.yml`'s jobs build it first.

Fix: document it where a consumer will actually hit it — `packages/sdk-swift/README.md`
and the iOS example's README — and make the failure self-explaining rather than a
SwiftPM resolution error. Not committing the binary: it is a build artifact and
the repo is right to ignore it.

### G3. Migration journal timestamps land below the watermark

Migrations 0121–0126 were hand-set to a synthetic future `+86400000`/day cadence,
putting the journal watermark days ahead of wall clock. Every migration
drizzle-kit now generates from real time lands **below** it and is silently
skipped forever on upgrade-path databases. It hit 0125 and 0126 independently in
one batch.

`packages/db/tests/journal-monotonic.test.ts` catches it and does run in CI — but
only after a commit. The defect is that the *generation* step produces a bad
value and a human must notice.

Fix: make `db:migrate:generate` produce a correct `when` rather than requiring a
hand-fix — the generator knows the current maximum. Keep the guard; it is the
backstop, not the mechanism.

---

## Phase H — the two wire-visible API defects

These change what clients receive. They are correct changes, but they are
observable, and that is why they were not smuggled into a docs batch.

### H1. Establish SDK tolerance before changing the wire

Every façade maps an unknown API error code to something. **Before** H2 lands,
confirm what each SDK does with a code it has never seen — RN's `normalizeKind`,
the Swift/Kotlin mappers, Flutter's `_kindByCode`. If any façade throws or
crashes on an unrecognised code rather than falling back, that must be fixed
first, and H2 waits.

This ordering is the whole point. Emitting new codes into a client that cannot
tolerate them would turn a documentation fix into an outage.

### H2. Four codes with no producer, and one produced two ways

`BEARER_REQUIRED`, `INVALID_API_KEY`, `INVALID_API_KEY_FORMAT` and
`API_KEY_KIND_MISMATCH` are in the public `ERROR_CODE` enum, but
`apps/api/src/middleware/api-key-auth.ts` throws bare `HTTPException`s with no
`cause`, so all four collapse to generic `UNAUTHORIZED`/`FORBIDDEN`. A client
cannot distinguish "no bearer token" from "wrong key kind".

Separately, `STRIPE_NOT_CONNECTED` is produced correctly via `cause` in
`billing-portal.ts`, and as a bare string inside a `JSON.stringify` message —
with no `cause` — in `routes/dashboard/funnels.ts` and
`routes/public/funnel-payment.ts`, so those two routes never surface the code.

Fix both by setting `cause`. The error catalog already documents all five as
their real behaviour; those entries get corrected in the same change, so the
catalog and the wire move together rather than one lagging.

---

## Phase I — the two operational defects

### I1. The key-rotation tool does not compile, and its runbook is incomplete

`scripts/rotate-encryption-key.ts` does `import prisma, {...} from "@rovenue/db"`
— a Prisma-era leftover in a Drizzle codebase — and lists a `stripeCredentials`
column dropped by migration 0087. Exactly one typecheck error surfaces (TS1192),
because after the failed default import `prisma` is `any` and every downstream
access passes silently.

**The larger finding: `ENCRYPTION_KEY` protects three tables, not one.**
- `projects.appleCredentials` / `googleCredentials` — the tagged `{v,enc}` wrapper
- `copilot_credentials.apiKeyEncrypted` — a raw `encrypt()` string
- `integration_connections.credentialsCipher` — raw `encrypt(JSON.stringify(...))`

The two raw-string columns use a **different wire shape**, so
`isEncryptedCredential` does not apply to them and they need their own path.
`docs/runbooks/secret-rotation.md`, written during §11, describes only `projects`
— a rewrite following that runbook literally would leave two tables unrotated,
which in a key-compromise incident is worse than a tool that fails loudly.

Fix: rewrite against Drizzle covering all three tables and both wire shapes;
correct the runbook. Verification runs against a disposable database with
synthetic `OLD_KEY`/`NEW_KEY` pairs — never the shared dev instance, and never
real credentials.

### I2. Partition management stops at 2028-12 on fresh installs

`revenue_events` and `credit_ledger` have 60 static partitions (2024-01 →
2028-12) from migrations 0015/0016, and are absent from `partman.part_config`
because fresh installs skip 0019 — **deliberately**, with a documented reason:
partman v5 names children `_pYYYYMMDD` while the migrations named them
`_YYYY_MM`, so `create_parent` tries to attach an overlapping range and Postgres
aborts the call.

The skip was a considered decision. Its consequence was not recorded: **any
insert dated 2029-01-01 or later has no partition to land in.** That is a dated
failure, not a hypothetical.

Fix: register both parents with `p_start_partition` set **past the last existing
partition**, so partman's premake loop never intersects the pre-created range and
the overlap cannot occur. Naming is then split (`_YYYY_MM` historically,
`_pYYYYMMDD` onward), which is cosmetic — partman's maintenance works from
catalog bounds, not names.

Rejected: hand-inserting a `part_config` row. It bypasses `create_parent`
entirely and depends on pg_partman's internal table shape, which a future
upgrade may change.

`outgoing_webhooks` stays unregistered — that is deliberate and documented; its
retention predicate is composite and a hand-rolled worker owns it.

---

## Phase J — the two documentation defects

### J1. Three RN method groups are undocumented

`apps/docs/content/docs/reference/methods.mdx` has no section for Paywalls,
Remote Config or Attributes, all of which `packages/sdk-rn` exports. This is
absent coverage, not false coverage — the distinction §11 held throughout.

### J2. Search is visible and silently returns nothing

`apps/docs`'s production image is Caddy serving static files, so
`app/routes/search.ts`'s server loader is unreachable. `RootProvider` defaults
`search.enabled` to true and is hard-wired to `/api/search`, so a reader sees a
search box that opens and finds nothing — worse than no search box.

The installed `fumadocs-core@16.10.2` already supports this without a server:
`createFromSource(...).staticGET()` exports an index at build time, and
`oramaStaticClient({ from })` consumes it in the browser. Three steps: emit the
index into the static output, point the provider at it, and stop depending on the
server route in production.

The one unknown is the exported index's size for this doc set. If it is large
enough to hurt first load, say so with numbers rather than shipping it silently.

---

## Phase K — the recorded defect that is not the real defect

The ROADMAP records: `examples/sample-rn-expo` is pinned below its own SDK's
floor (`expo ~51`/`RN 0.74.5` against a declared `>=52`/`>=0.76`), so it cannot
be bundled or built.

**That blames the wrong thing.** The root's React Native 0.86.0 is not an
unrelated package — it is `sdk-rn`'s own unbounded peer floor auto-resolved by
pnpm to the newest publish. And the floor itself has never been exercised:
`packages/sdk-rn`'s tests stub out `react-native` and `expo-modules-core`
entirely, the `rn` CI job never links a real RN, `example-rn` is deliberately
typecheck-only, and `core/native.ts` still carries a live code path for Expo SDK
51 — below the declared floor.

So the real defect is: **the SDK declares a peer floor nothing has ever built
against.** Upgrading the example would make it the first build to test that
claim, with unknown native and codegen fallout — a migration project, not a fix.

This spec does not attempt that upgrade. It rewrites the ROADMAP entry to name
the actual defect, and does the bounded part: make resolution deterministic so
the hoisted version stops drifting with every install.

---

## Global constraints

- No magic values; named constants declared once.
- Every guard added must be watched failing before it is trusted.
- Nothing that writes to the shared local Postgres. Verification for I1 and I2
  uses a disposable database.
- H2 does not land until H1 confirms every façade tolerates unknown codes.
- Where a fix cannot be completed honestly, say so and record why — the failure
  this whole effort exists to remove is claiming more than is true.
