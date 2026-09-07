// =============================================================
// Structural authorization sweep — paywalls + funnels (Task 9, Guard 1)
//
// A per-route checklist rots the moment someone adds a route and forgets
// to update it. This instead enumerates routes from Hono's OWN `.routes`
// array (`{ method, path }`) and proves each mutating one is gated BY
// BEHAVIOUR: it actually rejects a role lacking the capability, not that
// its source merely mentions `assertProjectCapability` somewhere (a
// source-text scan would pass on a route that only mentions the symbol in
// a comment, and fail on a gate correctly moved into shared middleware).
//
// CUSTOMER_SUPPORT holds neither `paywalls:write`, `funnels:write`, nor
// `experiments:write` (see lib/capabilities.ts's CAPABILITY_ROLES table),
// so every mutating route that is supposed to be gated must reject a
// CUSTOMER_SUPPORT caller with 403 — and the 403 must come from the
// capability check, not from requireDashboardAuth rejecting an
// unauthenticated caller (a sweep that never authenticates would pass
// perfectly and prove nothing). Every request below carries a real
// Better Auth session cookie for a CUSTOMER_SUPPORT member of the seeded
// project, so a 403 here can only be the capability gate.
//
// Body-validation ordering gotcha (measured empirically, see task-9
// report): `validate("json", schema)` is composed as Hono middleware
// BEFORE the handler, so it runs and can short-circuit with 400 before a
// capability check written inside the handler body ever executes. An
// empty `{}` body would therefore false-positive as an "offender" on
// every gated route whose body schema requires fields (POST /, PATCH
// /:id, PATCH /:id/versions/:versionNo, POST /:id/experiments here, plus
// funnels' POST / and PATCH /:funnelId) — not because the route is
// ungated, but because the request never got far enough to find out.
// BODY_OVERRIDES supplies a schema-satisfying (but otherwise inert) body
// for exactly those routes so the request reaches the capability check;
// every other route (no body schema) gets `{}`.
//
// Path-param gotcha (also measured): `:versionNo` is parsed as a decimal
// integer by `parseVersionNo` BEFORE the capability check runs on the two
// routes that carry it — a non-numeric filler ("does-not-exist") 400s
// there for the same reason as above. PARAM_FILLS substitutes a numeric
// placeholder for that one param name; every other `:param` gets the
// generic non-existent-row filler, which is safe because every other
// route's capability check runs before its row lookup.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { paywallsDashboardRoute } from "./paywalls";
import { funnelsRoute } from "./funnels";

const RUN_ID = Date.now();

const PAYWALLS_MOUNT_PREFIX = "/projects/:projectId/paywalls";
const FUNNELS_MOUNT_PREFIX = "/projects/:projectId/funnels";

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app
    .route(PAYWALLS_MOUNT_PREFIX, paywallsDashboardRoute)
    .route(FUNNELS_MOUNT_PREFIX, funnelsRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `authsurface_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!authsurface";
  const name = `Auth Surface User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(",").map((s) => s.trim().split(";")[0]).join("; ");

  return { userId: signUp.user.id, cookie };
}

async function seedProjectWithRole(
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT",
): Promise<{ cookie: string; projectId: string }> {
  const db = getDb();
  const { userId, cookie } = await createUserAndSession(role.toLowerCase());
  const projectId = `prj_authsurface_${RUN_ID}`;
  await db.insert(projects).values({
    id: projectId,
    name: `Auth Surface Project ${RUN_ID}`,
  });
  await db.insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
  return { cookie, projectId };
}

const seededProjectIds: string[] = [];
afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

// -------------------------------------------------------------
// Sweep machinery
// -------------------------------------------------------------

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const FORBIDDEN = 403;

// A numeric placeholder for path params that are parsed/validated as a
// number BEFORE the capability check runs, so a non-numeric filler would
// 400 there for a reason unrelated to authorization. Every other param
// name falls back to the generic non-existent-row filler below — safe
// because, for every OTHER route on these two routers, the capability
// check runs before any row lookup or param-shape validation.
const NUMERIC_PARAM_FILL = "999999";
const PARAM_FILLS: Readonly<Record<string, string>> = {
  versionNo: NUMERIC_PARAM_FILL,
};
const GENERIC_PARAM_FILL = "does-not-exist";

function fillParams(path: string): string {
  return path.replace(
    /:([A-Za-z0-9_]+)/g,
    (_match, name: string) => PARAM_FILLS[name] ?? GENERIC_PARAM_FILL,
  );
}

// Routes that legitimately need no capability gate, with a reason.
// Never delete a route from the sweep to make it "pass" — add it here
// with its reason instead. An empty list is the healthy state; these
// three are the exception, and the reason is the same for all three:
// each is POST but persists nothing — CUSTOMER_SUPPORT is deliberately
// allowed to reach them (baseline `assertProjectAccess`, not a capability
// gate) because the response is applied client-side through the builder
// VM, never written to the row by the route itself.
const UNGATED_BY_DESIGN: ReadonlyArray<{ method: string; path: string; why: string }> = [
  {
    method: "POST",
    path: "/from-app-store",
    why: "Builds and returns a draft tree; writes nothing (see paywalls.ts's route comment). Read-gated by design so CUSTOMER_SUPPORT can use App Store import to preview, same as generation/translation below.",
  },
  {
    method: "POST",
    path: "/:id/paywall-generate",
    why: "AI one-shot generation returns a config for the dashboard to apply client-side; the route never persists it (see paywalls.ts's route comment). Read-gated (assertProjectAccess), not paywalls:write.",
  },
  {
    method: "POST",
    path: "/:id/translate",
    why: "Auto-translate returns translated strings for the builder VM to merge client-side; the route never persists them (see paywalls.ts's route comment). Read-gated (assertProjectAccess), not paywalls:write.",
  },
];

function isUngatedByDesign(method: string, path: string): boolean {
  return UNGATED_BY_DESIGN.some((u) => u.method === method && u.path === path);
}

// A schema-satisfying (but otherwise inert) body for every mutating route
// whose `validate("json", schema)` middleware runs BEFORE the handler's
// capability check and would 400 on `{}` before that check is ever
// reached. Every other mutating route has no body schema, so it gets the
// default `{}` in the sweep below.
const PAYWALLS_BODY_OVERRIDES: Readonly<Record<string, unknown>> = {
  "POST /": {
    identifier: "sweep-test",
    name: "Sweep Test",
    offeringId: GENERIC_PARAM_FILL,
    remoteConfig: { defaultLocale: "en", locales: { en: {} } },
  },
  "PATCH /:id": { name: "Sweep Test" },
  "PATCH /:id/versions/:versionNo": { label: "sweep" },
  "POST /:id/experiments": {
    name: "Sweep Test",
    variantB: { kind: "duplicate", name: "Variant B" },
  },
};

const FUNNELS_BODY_OVERRIDES: Readonly<Record<string, unknown>> = {
  "POST /": { name: "Sweep Test" },
  "PATCH /:funnelId": { name: "Sweep Test" },
};

interface RouteUnderTest {
  method: string;
  path: string;
}

interface RouterFixture {
  label: string;
  router: { routes: ReadonlyArray<RouteUnderTest> };
  mount: string;
  bodyOverrides: Readonly<Record<string, unknown>>;
}

describe("structural authorization sweep — paywalls + funnels mutations", () => {
  it("every paywall/funnel mutation route rejects CUSTOMER_SUPPORT with 403", async () => {
    const { cookie, projectId } = await seedProjectWithRole("CUSTOMER_SUPPORT");
    seededProjectIds.push(projectId);

    const app = buildApp();

    // Positive control: prove the session cookie actually authenticates
    // and the membership actually resolves, BEFORE trusting any 403 below
    // as a capability rejection. CUSTOMER_SUPPORT is the read-access
    // floor (assertProjectAccess's default minimumRole), so a read route
    // must succeed with this exact cookie — if requireDashboardAuth were
    // rejecting the caller outright (bad cookie, no membership row), every
    // route below would 401/403 for that unrelated reason and the sweep
    // would pass without ever exercising a capability check.
    const readCheck = await app.request(`/projects/${projectId}/paywalls`, {
      method: "GET",
      headers: { cookie },
    });
    expect(readCheck.status).toBe(200);

    const fixtures: RouterFixture[] = [
      {
        label: "paywalls",
        router: paywallsDashboardRoute,
        mount: `/projects/${projectId}/paywalls`,
        bodyOverrides: PAYWALLS_BODY_OVERRIDES,
      },
      {
        label: "funnels",
        router: funnelsRoute,
        mount: `/projects/${projectId}/funnels`,
        bodyOverrides: FUNNELS_BODY_OVERRIDES,
      },
    ];

    const offenders: string[] = [];
    let mutatingRoutesChecked = 0;
    let ungatedRoutesSkipped = 0;

    for (const { label, router, mount, bodyOverrides } of fixtures) {
      // Hono's `.routes` lists one entry PER MIDDLEWARE/HANDLER attached to
      // a method+path (e.g. `validate()` + the async handler both appear),
      // so the same route can show up two or three times. Dedupe by
      // method+path first — otherwise "how many mutating routes did the
      // sweep enumerate" over-counts, and the sweep fires redundant
      // requests at the same route.
      const seen = new Set<string>();
      const distinctRoutes = router.routes.filter((r) => {
        const key = `${r.method} ${r.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      for (const r of distinctRoutes) {
        if (!MUTATING_METHODS.has(r.method)) continue;

        if (isUngatedByDesign(r.method, r.path)) {
          ungatedRoutesSkipped += 1;
          continue;
        }

        mutatingRoutesChecked += 1;
        const key = `${r.method} ${r.path}`;
        const body = bodyOverrides[key] ?? {};
        // Hono composes a mounted sub-router at exactly its mount path for
        // "/" — appending it verbatim would double up the trailing slash
        // and 404 before the route even matches.
        const filledPath = r.path === "/" ? "" : fillParams(r.path);

        const res = await app.request(`${mount}${filledPath}`, {
          method: r.method,
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        const text = await res.clone().text();
        // A 403 for the wrong reason (e.g. "Not a member of this
        // project" from a broken seed) is just as much a false pass as a
        // 200 — the sweep exists to prove the CAPABILITY check fired, not
        // merely that the status code happened to be 403.
        const isCapabilityRejection =
          res.status === FORBIDDEN && text.includes("lacks capability");
        if (!isCapabilityRejection) {
          offenders.push(`${label} ${r.method} ${r.path} -> ${res.status} ${text}`);
        }
      }
    }

    // Report the shape of the sweep itself — a guard that silently
    // enumerated zero routes (or an implausibly small number) is a
    // finding about the sweep, not a pass. See the task-9 report for the
    // actual counts this produced against the current route set.
    expect(mutatingRoutesChecked).toBeGreaterThan(0);
    // eslint-disable-next-line no-console -- deliberate: counts belong in
    // the test run's own output, not just the report written by hand.
    console.log(
      `authorization-surface sweep: ${mutatingRoutesChecked} mutating routes checked, ` +
        `${ungatedRoutesSkipped} skipped as UNGATED_BY_DESIGN`,
    );

    expect(offenders).toEqual([]);
  });
});
