# SP3 — Custom-domain funnel serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a verified custom domain actually serve its funnel — HTML, host resolution, and Apple Pay registration — on top of the resolver, verification and TLS machinery that already exists.

**Architecture:** The edge stops proxying custom hosts to the API (which serves JSON) and proxies them to the dashboard origin instead; no path split is needed because the SPA calls the API at an absolute `VITE_API_URL`. `GET /host/lookup` gains an optional `?host=` because a cross-origin caller's `Host` header is always the API's own hostname. The SPA root route resolves that host to a slug and renders the funnel runner instead of redirecting to `/login`. The cert poller registers each newly-issued domain with Stripe as a payment-method domain, without clobbering the connection-level status of the canonical domain.

**Tech Stack:** Caddy, Hono, Zod, Redis, PostgreSQL, React (Vite) + TanStack Router, Vitest.

Spec: `docs/superpowers/specs/2026-07-23-sp3-custom-domain-funnel-serving-design.md`

## Global Constraints

- TypeScript strict everywhere. Zod for API input. Responses are `{ data: T }` via `ok()` or `{ error: { code, message } }`.
- Postgres access via Drizzle repositories only (`packages/db/src/drizzle/repositories`). Raw `sql` must qualify columns.
- **No magic values.** A literal carrying meaning — a hostname, a TTL, a status string — gets a named constant next to its siblings. Structured data tables and fixture ids are not magic values.
- All new user-facing strings go through i18n (`apps/dashboard/src/i18n/locales/en.json`). No hardcoded copy in components.
- Conventional commits, one commit per task. **Stay on the current branch (`main`). Do NOT create branches or worktrees.** Another author commits to `main` in parallel — `git add` only the files your task names, never `git add -A`, and run `git status --short` before committing to confirm nothing else is staged (a plain `git commit` commits the whole index).
- Test invocation: packages have no `vitest` script — use `pnpm --filter <pkg> exec vitest run <path>`, never `pnpm --filter <pkg> vitest run <path>`.
- API route tests live in `apps/api/tests/`, a separate directory from `apps/api/src`. Service and worker tests colocate with their source.
- **Every change must be mutation-checked**: after the test passes, revert the production change, confirm the test goes red, then restore. A test that passes on unfixed code proves nothing.
- No new migration is needed anywhere in this plan. Do NOT run `drizzle-kit generate`.

---

### Task 1: `GET /host/lookup` accepts an explicit host

**Files:**
- Modify: `apps/api/src/routes/public/funnels.ts:224-231`
- Test: `apps/api/tests/funnel-host-lookup.test.ts` (create)

**Interfaces:**
- Consumes: `resolveHost(host: string): Promise<{ funnelId: string; slug: string } | null>` from `apps/api/src/services/custom-domains/host-resolver.ts`.
- Produces: `GET /host/lookup?host=<hostname>` → `{ data: { funnelId, slug } }`, 404 when unresolvable.

**Background the implementer needs:**

The endpoint exists and resolves from the `Host` header. Its own comment says it "lets the SDK discover its funnel slug when it's loaded from a custom domain" — but it has **zero callers**, and as written the intended caller could not use it: the dashboard reaches the API at an absolute `VITE_API_URL` (`apps/dashboard/src/lib/api.ts:5`), so on any cross-origin request the `Host` header is the API's own hostname, never the custom domain.

Naming the host from the client is not a privilege escalation. The response is `{ funnelId, slug }`, and that mapping is already public — the funnel is reachable to anyone at `/f/<slug>`. `resolveHost` still resolves only rows that are both `verifiedAt` and `certStatus === "issued"`, so an unverified or half-configured domain returns 404 either way and keeps its negative cache entry.

`validate` and `z` are already imported in this file (lines 21-22). Use them; do not read the query parameter raw.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/funnel-host-lookup.test.ts`. Read a sibling in `apps/api/tests/` first and follow its app-construction and mocking idiom — that directory has an established harness and inventing a second one is a defect. Mock the host resolver module.

The assertions the test must make:

```ts
  it("resolves the host named in the query parameter", async () => {
    resolveHostMock.mockResolvedValue({ funnelId: "fnl_1", slug: "quiz" });
    // GET /host/lookup?host=quiz.acme.com
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ funnelId: "fnl_1", slug: "quiz" });
    // The query parameter must win — this is the whole point of the change.
    expect(resolveHostMock).toHaveBeenCalledWith("quiz.acme.com");
  });

  it("falls back to the Host header when no query parameter is given", async () => {
    resolveHostMock.mockResolvedValue({ funnelId: "fnl_1", slug: "quiz" });
    // GET /host/lookup with Host: quiz.acme.com and no ?host=
    expect(res.status).toBe(200);
    expect(resolveHostMock).toHaveBeenCalledWith("quiz.acme.com");
  });

  it("404s when the host does not resolve", async () => {
    resolveHostMock.mockResolvedValue(null);
    // GET /host/lookup?host=not-ours.example.com
    expect(res.status).toBe(404);
  });

  it("404s when the query parameter is present but empty", async () => {
    // An empty ?host= must not silently fall back to the Host header —
    // that would resolve the API's own hostname and return whatever
    // funnel happened to be bound to it.
    //
    // CORRECTED (found by the implementer): a status-only assertion here
    // is VACUOUS. With a constant mock and no distinguishing Host header,
    // both `??` and `||` produce a 404 and the test passes either way,
    // proving nothing. Send a Host header set to a DIFFERENT value and
    // assert the argument — that is what pins the contract.
    resolveHostMock.mockResolvedValue(null);
    // GET /host/lookup?host=  with header Host: other-tenant.example.com
    expect(res.status).toBe(404);
    expect(resolveHostMock).toHaveBeenCalledWith("");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/api exec vitest run tests/funnel-host-lookup.test.ts
```

Expected: the query-parameter case FAILS — `resolveHost` is called with the `Host` header value, not the query value.

- [ ] **Step 3: Implement**

Replace the handler at `apps/api/src/routes/public/funnels.ts:224-231` with:

```ts
  .get(
    "/host/lookup",
    validate("query", z.object({ host: z.string().optional() })),
    async (c) => {
      const { host: queried } = c.req.valid("query");
      // The query parameter wins. A cross-origin caller's `Host` header is
      // the API's own hostname, so the header alone cannot answer "which
      // funnel is this custom domain?" — which is what this endpoint is
      // for. The header stays as the same-origin fallback.
      //
      // Client-named hosts are safe here: the response is {funnelId, slug},
      // a mapping already public at /f/<slug>, and `resolveHost` still only
      // resolves rows that are verified AND cert-issued.
      const host = queried ?? c.req.header("host") ?? "";
      const resolved = await resolveHost(host);
      if (!resolved) {
        throw new HTTPException(404, { message: "Unknown host" });
      }
      return c.json({ data: resolved });
    },
  )
```

Note `queried ?? …` rather than `queried || …`: an explicitly empty `?host=` must resolve to `""` and 404, not silently fall back to the header.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/api exec vitest run tests/funnel-host-lookup.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Mutation-check**

Change `queried ?? c.req.header("host")` to just `c.req.header("host")`, re-run Step 4, and confirm the query-parameter test goes red while the header test stays green. Then change it to `queried || c.req.header("host")` and confirm the empty-parameter test goes red. Restore and confirm 4/4.

Record all three observed outcomes. The second mutation is the one that proves the `??` was deliberate.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/public/funnels.ts apps/api/tests/funnel-host-lookup.test.ts
git status --short
git commit -m "feat(api): /host/lookup accepts an explicit host, not just the Host header"
```

---

### Task 2: register a custom domain with Stripe when its cert is issued

**Files:**
- Modify: `apps/api/src/services/stripe/apple-pay-domain.ts:90-141`
- Modify: `apps/api/src/workers/custom-domain-cert-poller.ts:76-85`
- Test: `apps/api/src/services/stripe/apple-pay-domain.test.ts` (exists — add cases)
- Test: `apps/api/src/workers/custom-domain-cert-poller.integration.test.ts` (exists — add cases)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `registerApplePayDomain(projectId: string, domainName?: string): Promise<ApplePayDomainOutcome>` — second parameter defaults to `env.FUNNEL_PAYMENT_DOMAIN`, so every existing caller is unchanged.

**Background the implementer needs:**

Stripe will not render an Apple Pay button on a host that is not registered as a payment-method domain. Today `registerApplePayDomain(projectId)` reads `env.FUNNEL_PAYMENT_DOMAIN` and registers that one host, so a customer who binds their own domain watches Apple Pay — working on the canonical host — silently vanish on theirs.

**The trap this task must avoid.** The function ends by calling `stripeConnectionRepo.updateApplePayDomainStatus(db, connection.id, status)` (`apple-pay-domain.ts:136-141`). That column is on the **connection** row, one per project, while a project can now have many registered domains. Left as-is, a custom domain's verdict overwrites the canonical domain's, and the dashboard would report Apple Pay broken on the canonical host because some customer's domain had not finished Apple's checks.

The column keeps its meaning — the status of the canonical `FUNNEL_PAYMENT_DOMAIN` — and the write is guarded on the domain being that host. Guard it inside the function rather than adding a parameter, so the rule sits at the only place that could break it.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/services/stripe/apple-pay-domain.test.ts`. Read the file first and follow its existing mock setup.

```ts
  it("registers the domain it is given, not the env default", async () => {
    await registerApplePayDomain("proj_1", "quiz.acme.com");
    expect(createMock).toHaveBeenCalledWith({ domain_name: "quiz.acme.com" });
  });

  it("does not write the connection-level status for a non-canonical domain", async () => {
    // That column describes the canonical FUNNEL_PAYMENT_DOMAIN. A custom
    // domain's verdict must not overwrite it, or the dashboard reports
    // Apple Pay broken on the canonical host because someone else's
    // domain is still pending.
    await registerApplePayDomain("proj_1", "quiz.acme.com");
    expect(updateApplePayDomainStatusMock).not.toHaveBeenCalled();
  });

  it("still writes the connection-level status for the canonical domain", async () => {
    await registerApplePayDomain("proj_1");
    expect(updateApplePayDomainStatusMock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/stripe/apple-pay-domain.test.ts
```

Expected: the second case FAILS — the status write happens unconditionally today.

- [ ] **Step 3: Implement the signature and the guard**

In `apps/api/src/services/stripe/apple-pay-domain.ts`, change the signature and the domain resolution at lines 90-101:

```ts
export async function registerApplePayDomain(
  projectId: string,
  // Defaults to the canonical funnel host so every existing caller is
  // unchanged. The custom-domain cert poller passes a verified customer
  // hostname instead.
  domainName: string | undefined = env.FUNNEL_PAYMENT_DOMAIN,
): Promise<ApplePayDomainOutcome> {
  if (!domainName) {
    // Deliberately not derived from DASHBOARD_URL. Registering a host the
    // paywall is not served from succeeds at the API level and then Apple
    // Pay silently never appears — the failure this whole path exists to
    // prevent. An operator names the host or nothing is registered.
    log.warn("no domain to register for Apple Pay; skipping", { projectId });
    return "skipped";
  }
```

Then guard the status write at lines 136-141:

```ts
    const status = applePayVerdict(domain);
    // `applePayDomainStatus` lives on the CONNECTION row — one per project —
    // and means "the canonical FUNNEL_PAYMENT_DOMAIN's status". A project
    // can now have many registered domains, so a custom domain's verdict
    // must not be written here: it would overwrite the canonical host's
    // status and make the dashboard report Apple Pay broken there.
    if (domainName === env.FUNNEL_PAYMENT_DOMAIN) {
      await drizzle.stripeConnectionRepo.updateApplePayDomainStatus(
        drizzle.db,
        connection.id,
        status,
      );
    }
```

Leave the logging below it unchanged — a custom domain that registers but is not yet `active` must still be loud.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm --filter @rovenue/api exec vitest run src/services/stripe/apple-pay-domain.test.ts
```

Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Write the failing cert-poller tests**

Add to `apps/api/src/workers/custom-domain-cert-poller.integration.test.ts`. Read the file first and follow its existing seeding and mocking idiom.

```ts
  it("registers the hostname with Stripe on the issued transition", async () => {
    // seed a verified row whose probe returns issued
    await runCertPoller();
    expect(registerApplePayDomainMock).toHaveBeenCalledWith(
      PROJECT_ID,
      "quiz.acme.com",
    );
  });

  it("does not register on the failed transition", async () => {
    // seed a verified row whose probe returns failed
    await runCertPoller();
    expect(registerApplePayDomainMock).not.toHaveBeenCalled();
  });

  it("leaves certStatus issued when registration throws", async () => {
    // Best-effort by design: a domain that serves its funnel without an
    // Apple Pay registration is degraded; a domain stuck at `issuing`
    // because a Stripe call failed is broken.
    registerApplePayDomainMock.mockRejectedValue(new Error("stripe down"));
    await runCertPoller();
    const row = await readRow();
    expect(row.certStatus).toBe("issued");
  });
```

- [ ] **Step 6: Run to verify they fail**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/api exec vitest run src/workers/custom-domain-cert-poller.integration.test.ts
```

Expected: the first case FAILS — nothing calls the registration yet.

- [ ] **Step 7: Call it from the issued branch**

In `apps/api/src/workers/custom-domain-cert-poller.ts`, inside the `result.status === "issued"` branch, after `invalidateHost(row.hostname)` and before `issued++`:

```ts
        // Stripe will not render an Apple Pay button on a host that is not
        // a registered payment-method domain, so a customer's own domain
        // would silently lose Apple Pay that works on the canonical host.
        // Registration is idempotent (it lists before creating).
        //
        // Best-effort on purpose: a failure here leaves a domain that
        // serves its funnel without Apple Pay — degraded. Rethrowing would
        // leave it stuck at `issuing` — broken.
        try {
          await registerApplePayDomain(row.projectId, row.hostname);
        } catch (err) {
          log.error("apple pay domain registration failed for a custom domain", {
            hostname: row.hostname,
            projectId: row.projectId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
```

Add the import from `../services/stripe/apple-pay-domain`.

- [ ] **Step 8: Run to verify they pass**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/api exec vitest run src/workers/custom-domain-cert-poller.integration.test.ts
```

Expected: PASS, including every pre-existing case.

- [ ] **Step 9: Mutation-check both halves**

First: remove the `if (domainName === env.FUNNEL_PAYMENT_DOMAIN)` guard, re-run Step 4, confirm the "does not write the connection-level status" case goes red. Restore.

Second: change the `try/catch` in the poller to let the error propagate, re-run Step 8, confirm the "leaves certStatus issued when registration throws" case goes red. Restore.

Record all four observed outcomes.

- [ ] **Step 10: Typecheck**

```bash
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/stripe/apple-pay-domain.ts \
        apps/api/src/services/stripe/apple-pay-domain.test.ts \
        apps/api/src/workers/custom-domain-cert-poller.ts \
        apps/api/src/workers/custom-domain-cert-poller.integration.test.ts
git status --short
git commit -m "feat(api): register a custom domain for Apple Pay when its cert issues"
```

---

### Task 3: the SPA serves the funnel on a custom host

**Files:**
- Create: `apps/dashboard/src/lib/custom-host.ts`
- Create: `apps/dashboard/src/lib/custom-host.test.ts`
- Modify: `apps/dashboard/src/routes/index.tsx`
- Modify: `apps/dashboard/src/routes/__root.tsx`
- Test: `apps/dashboard/src/routes/index.test.tsx` (create)

**Interfaces:**
- Consumes: `GET /host/lookup?host=<hostname>` → `{ data: { funnelId, slug } }` from Task 1.
- Produces: `isCanonicalDashboardHost(env: CustomHostEnv, hostname: string): boolean`.

**Background the implementer needs:**

`apps/dashboard/src/routes/index.tsx` redirects to `/login` when there is no session. A funnel visitor arriving on a custom domain therefore lands on a Rovenue login screen. The root route needs a funnel branch that runs **before** the session check.

The decision logic goes in a pure function following the idiom `apps/dashboard/src/lib/host-mode.ts` already establishes: a function taking an env-shaped object, tested directly, with the module constant derived from `import.meta.env` at load. Read that file before writing this one — it exists specifically so tests need not stub `import.meta.env`.

`VITE_DASHBOARD_HOST` is an **optimisation, not a switch**. When it is unset the lookup runs anyway and the outcome is identical — one extra request on the canonical landing, against a 60-second server-side negative cache. That ordering is deliberate: a self-hoster who never sets the variable still gets working custom domains rather than a silent failure that only appears in production. Do not invert it into a feature flag.

The runner component is `FunnelRunner` from `apps/dashboard/src/runner/funnel-runner`, used today by `apps/dashboard/src/routes/f.$slug.tsx` as `<FunnelRunner slug={slug} />`.

- [ ] **Step 1: Write the failing test for the pure function**

Create `apps/dashboard/src/lib/custom-host.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isCanonicalDashboardHost } from "./custom-host";

describe("isCanonicalDashboardHost", () => {
  it("is true when the hostname matches the configured dashboard host", () => {
    expect(
      isCanonicalDashboardHost({ VITE_DASHBOARD_HOST: "app.rovenue.io" }, "app.rovenue.io"),
    ).toBe(true);
  });

  it("is false for a different hostname", () => {
    expect(
      isCanonicalDashboardHost({ VITE_DASHBOARD_HOST: "app.rovenue.io" }, "quiz.acme.com"),
    ).toBe(false);
  });

  it("is false when the variable is unset, so the lookup still runs", () => {
    // Unset must NOT mean "everything is canonical" — that would make
    // custom domains silently fail for any operator who never set the
    // variable. The lookup is the safe default; the variable only skips it.
    expect(isCanonicalDashboardHost({}, "app.rovenue.io")).toBe(false);
  });

  it("ignores case and a port suffix", () => {
    expect(
      isCanonicalDashboardHost({ VITE_DASHBOARD_HOST: "App.Rovenue.IO:5173" }, "app.rovenue.io"),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/lib/custom-host.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the pure function**

Create `apps/dashboard/src/lib/custom-host.ts`:

```ts
// =============================================================
// Custom-host detection
// =============================================================
//
// A funnel bound to a customer's own domain is served by this same SPA
// (the edge proxies custom hosts to the dashboard origin). The root
// route needs to know whether it is running on the canonical dashboard
// host or on someone's custom domain.
//
// Pure function + env-shaped argument, mirroring lib/host-mode.ts, so
// tests never have to stub `import.meta.env`.

export interface CustomHostEnv {
  VITE_DASHBOARD_HOST?: string | undefined;
}

/** Strip an optional :port and lowercase, matching the API-side
 * normalisation in services/custom-domains/host-resolver.ts. */
function normalize(host: string): string {
  return host.split(":")[0]?.toLowerCase() ?? "";
}

/**
 * Whether `hostname` is the canonical dashboard host.
 *
 * An UNSET `VITE_DASHBOARD_HOST` returns false — meaning "not known to be
 * canonical", so the caller performs the host lookup. That direction is
 * deliberate: the variable is an optimisation that skips one request, not
 * a feature switch. Treating unset as canonical would make custom domains
 * silently fail for anyone who never configured it.
 */
export function isCanonicalDashboardHost(
  env: CustomHostEnv,
  hostname: string,
): boolean {
  const configured = env.VITE_DASHBOARD_HOST;
  if (!configured) return false;
  return normalize(configured) === normalize(hostname);
}

export const dashboardHostEnv: CustomHostEnv = {
  VITE_DASHBOARD_HOST: import.meta.env.VITE_DASHBOARD_HOST as string | undefined,
};
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/lib/custom-host.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Write the failing root-route test**

Create `apps/dashboard/src/routes/index.test.tsx`. Read `apps/dashboard/src/routes/_authed/projects/$projectId/charts.test.tsx` first — it is the only existing route test and establishes the harness (mocking child components, wrapping in providers). Follow it rather than inventing a second harness. Mock `FunnelRunner` so the assertion is about which branch was taken, not about the runner's internals.

Assertions the test must make:

```ts
  it("renders the funnel runner on a host that resolves", async () => {
    // hostname = "quiz.acme.com", lookup resolves { slug: "quiz" }
    expect(await screen.findByTestId("mock-funnel-runner")).toBeTruthy();
    // The bug being fixed: a funnel visitor must not be bounced to login.
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("keeps the dashboard landing behaviour on the canonical host", async () => {
    // VITE_DASHBOARD_HOST matches the hostname
    expect(screen.queryByTestId("mock-funnel-runner")).toBeNull();
    // and the lookup is skipped entirely
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("keeps the dashboard landing behaviour when the host resolves to nothing", async () => {
    // lookup 404s
    expect(screen.queryByTestId("mock-funnel-runner")).toBeNull();
  });
```

- [ ] **Step 6: Run to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/routes/index.test.tsx
```

Expected: the first case FAILS — the route redirects instead of rendering the runner.

- [ ] **Step 7: Add the funnel branch to the root route**

`apps/dashboard/src/routes/index.tsx` currently has a `beforeLoad` that throws redirects and no `component`. Add a resolver that runs first, return its result as loader data, and give the route a component that renders the runner when a slug was resolved.

```tsx
import { FunnelRunner } from "../runner/funnel-runner";
import { dashboardHostEnv, isCanonicalDashboardHost } from "../lib/custom-host";

/**
 * Resolve the browser's current hostname to a funnel slug, or null.
 *
 * Runs before the session check because a funnel visitor on a customer's
 * domain has no dashboard session and must not be bounced to /login.
 *
 * A failing lookup returns null and falls through to the dashboard
 * landing: a lookup outage must never stop the dashboard loading.
 */
export async function resolveCustomHostSlug(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const hostname = window.location.hostname;
  // Skips one request on the canonical host. UNSET means "not known to be
  // canonical" and the lookup runs — see lib/custom-host.ts.
  if (isCanonicalDashboardHost(dashboardHostEnv, hostname)) return null;
  try {
    const res = await unwrap<{ funnelId: string; slug: string }>(
      rpc.host.lookup.$get({ query: { host: hostname } }),
    );
    return res.slug;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const funnelSlug = await resolveCustomHostSlug();
    if (funnelSlug) return { funnelSlug };

    // ... existing session + projects + redirect logic, unchanged ...

    return { funnelSlug: null };
  },
  component: LandingRoute,
});

function LandingRoute() {
  const { funnelSlug } = Route.useRouteContext();
  if (funnelSlug) return <FunnelRunner slug={funnelSlug} />;
  return null; // canonical host always redirects out of beforeLoad
}
```

Keep every existing line of the session/projects/redirect logic exactly as it is — only the early funnel branch and the `component` are new. If the RPC client's path for this endpoint differs from `rpc.host.lookup`, use the real one and note the correction in your report.

**CORRECTED after the final review — the instruction that stood here caused a Critical bug.** It said "do not fall back to an untyped `api()` shim", pattern-matched from an earlier task without checking that this route family is the exception. `lib/api.ts` bakes `credentials: "include"` into the typed client, and the public funnel routes carry `cors({ origin: "*" })`; browsers reject a wildcard origin together with a credentialed request, so in a real browser the lookup threw and every custom domain fell back to the login page — the exact bug this sub-project removes. MSW intercepts before any CORS check, so no test saw it. `apps/dashboard/src/runner/runner-api.ts` documents the hazard in its header and deliberately avoids `rpc` for these routes. Keep the typing and pass `{ init: { credentials: "omit" } }` as the request's second argument; the client's `{ credentials: "include", ...init }` spread lets it through.

- [ ] **Step 7b: Write the failing test for non-funnel paths on a custom host**

Spec item 5: on a host that resolves to a funnel, **every** path must render the runner, not a dashboard screen. SPA fallback means `https://customer-domain.com/login` returns `index.html` and the router would otherwise render Rovenue's login form on a customer's domain. It is not an auth hole — sessions are bound to the canonical origin — but it is wrong.

Add to `apps/dashboard/src/routes/index.test.tsx`:

```ts
  it("renders the funnel runner for a non-root path on a resolving host", async () => {
    // hostname = "quiz.acme.com" resolves; navigate to "/login"
    expect(await screen.findByTestId("mock-funnel-runner")).toBeTruthy();
    expect(screen.queryByTestId("login-form")).toBeNull();
  });

  it("still renders the login form on the canonical host", async () => {
    // VITE_DASHBOARD_HOST matches; navigate to "/login"
    expect(await screen.findByTestId("login-form")).toBeTruthy();
  });
```

Adjust the `login-form` test id to whatever `apps/dashboard/src/routes/login.tsx` actually renders — read it first and use a real selector rather than inventing one.

- [ ] **Step 7c: Implement the catch-all**

Put the branch in `apps/dashboard/src/routes/__root.tsx` rather than repeating it per route: resolve the host once, and when it yields a slug render `<FunnelRunner slug={slug} />` in place of the router `<Outlet />`. The canonical host renders the `<Outlet />` exactly as today.

Reuse `resolveCustomHostSlug` from Step 7 — do not write a second copy of the lookup. If placing it in `__root.tsx` makes the root route's own branch redundant, remove the duplication and say so in your report; one resolution point is better than two that can disagree.

- [ ] **Step 8: Run to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/routes/index.test.tsx src/lib/custom-host.test.ts
```

Expected: PASS.

- [ ] **Step 9: Mutation-check**

Change the branch so the lookup result is ignored and the route always falls through to the session check — the old broken behaviour. Re-run Step 8 and confirm the "renders the funnel runner" case goes red while the canonical-host case stays green. Restore and confirm green. Record both outcomes.

- [ ] **Step 10: Document the new env var**

Add `VITE_DASHBOARD_HOST` to `.env.example` beside the existing `DASHBOARD_URL` entry (line 65), with a comment saying it is optional, that it only skips one lookup request on the canonical host, and that leaving it unset does not break custom domains.

- [ ] **Step 11: Typecheck and build**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm build --filter @rovenue/dashboard
```

Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add apps/dashboard/src/lib/custom-host.ts \
        apps/dashboard/src/lib/custom-host.test.ts \
        apps/dashboard/src/routes/index.tsx \
        apps/dashboard/src/routes/__root.tsx \
        apps/dashboard/src/routes/index.test.tsx \
        .env.example
git status --short
git commit -m "feat(dashboard): serve the funnel on a custom host instead of redirecting to login"
```

---

### Task 4: point the edge at the dashboard, and verify the whole change

**Files:**
- Modify: `deploy/caddy/Caddyfile:78-88`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: custom hosts served by the dashboard origin.

**Background the implementer needs:**

`deploy/caddy/Caddyfile`'s on-demand `:443` block proxies to `api:3000`, which serves JSON. It must proxy to the dashboard origin instead — the same origin `Caddyfile.dashboard` describes, which already does SPA fallback and serves Stripe's Apple Pay association file with the right `Content-Type` (`Caddyfile.dashboard:22`).

No path split is needed: the SPA calls the API at an absolute `VITE_API_URL`, so its API traffic never transits this block.

**Do not touch `on_demand_tls`.** Its `ask` endpoint still points at the API (`Caddyfile:32`) and is the gate that stops Caddy issuing a certificate for a hostname that is not a verified `custom_domains` row. Changing where the block proxies must not change what it is allowed to serve.

Find the dashboard service's name and port from `docker-compose.yml` rather than guessing.

- [ ] **Step 1: Change the proxy target**

In the `:443` block, replace the `reverse_proxy api:3000 { … }` with a proxy to the dashboard service, keeping `encode zstd gzip` and the `tls { on_demand }` directive unchanged. Update the block's comment so it says what it now serves and why the ask-endpoint still points at the API.

- [ ] **Step 2: Validate the config syntactically**

```bash
docker run --rm -v "$PWD/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```

Expected: `Valid configuration`. If the image tag differs from what `docker-compose.yml` pins, use the pinned one.

- [ ] **Step 3: Manual verification — this cannot be automated**

No automated test in this repo exercises the edge configuration, so this step is the only check that the change works. Do not report it as done without the actual output.

Bring the stack up, then from inside the compose network issue a request to the on-demand block with a `Host` header for a verified custom domain and confirm an **HTML document** comes back rather than JSON:

```bash
docker compose up -d
docker compose exec caddy wget -qO- --header="Host: <a-verified-custom-domain>" http://localhost/ | head -20
```

Record what you observe. If no verified `custom_domains` row exists in the dev database, say so and instead confirm the block returns the dashboard's `index.html` for any host — the routing change is what this step verifies, not the resolver, which Task 1's tests already cover.

If the environment cannot run the stack, report this step **BLOCKED** with what you tried. Do not report it as passed.

- [ ] **Step 4: Run every changed-area suite on a quiet machine**

```bash
export DATABASE_URL="postgresql://rovenue:rovenue@localhost:5433/rovenue"
pnpm --filter @rovenue/api exec vitest run tests/funnel-host-lookup.test.ts src/services/stripe/ src/workers/custom-domain-cert-poller.integration.test.ts
pnpm --filter @rovenue/dashboard exec vitest run src/lib/custom-host.test.ts src/routes/index.test.tsx
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Record pass/fail counts per suite verbatim. Do not summarise a red run as green; if something fails, show the output and say whether this work caused it.

- [ ] **Step 5: Append the ledger entry**

Append to `.superpowers/sdd/progress-sp1-sp2.md` — **not** `.superpowers/sdd/progress.md`, which is shared with a parallel workstream and has been clobbered three times. Record the commits, each task's mutation-check outcome, the Step 3 manual-verification output, and anything left open.

Note `.superpowers/` is gitignored. If `git add` refuses the path, **do not force-add it** — report that the ledger could not be committed and leave it on disk. That is the correct outcome.

- [ ] **Step 6: Commit the Caddyfile**

```bash
git add deploy/caddy/Caddyfile
git status --short
git commit -m "fix(deploy): serve custom funnel domains from the dashboard origin"
```

---

## Notes for the reviewer

- Task 1's `??` is deliberate and mutation-checked: an explicitly empty `?host=` must 404 rather than fall back to the `Host` header, which on a cross-origin call is the API's own hostname.
- Task 2's connection-status guard is the subtle part. A diff that registers custom domains without guarding `updateApplePayDomainStatus` should be rejected: it makes one customer's pending domain report Apple Pay as broken on the canonical host.
- Task 2's registration is best-effort by design. Reject a diff that lets a Stripe failure propagate and leave the row stuck at `issuing`.
- Task 3's `VITE_DASHBOARD_HOST` must remain an optimisation. Reject a diff where leaving it unset disables custom-domain serving.
- Task 4 Step 3 cannot be automated. A task report that omits the actual manual-verification output is incomplete.
- Every task carries a mutation-check step. A report that omits the mutation-check outcome is incomplete regardless of how many tests pass.
