import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ProjectSummary } from "@rovenue/shared";
import { getSession } from "../lib/auth";
import { ApiError, rpc, unwrap } from "../lib/api";
import { queryClient } from "../lib/queryClient";
import { dashboardHostEnv, isCanonicalDashboardHost } from "../lib/custom-host";

export type LandingTarget =
  | { kind: "setup" }
  | { kind: "project"; projectId: string; wroteLastProjectId: boolean };

export function resolveLandingTarget(projects: ProjectSummary[]): LandingTarget {
  if (projects.length === 0) return { kind: "setup" };

  const stored =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lastProjectId")
      : null;
  const matched = stored && projects.find((p) => p.id === stored)?.id;
  if (matched) {
    return { kind: "project", projectId: matched, wroteLastProjectId: false };
  }

  const fallback = projects[0]!.id;
  try {
    localStorage.setItem("lastProjectId", fallback);
  } catch {
    // ignore quota / private mode
  }
  return { kind: "project", projectId: fallback, wroteLastProjectId: true };
}

/**
 * Memoised answer for the life of the document.
 *
 * Both `__root.tsx` and the "/" route need to know whether this host is a
 * funnel domain, so landing directly on "/" reaches the resolver twice.
 * The hostname cannot change without a page load, so a second lookup
 * could only return the same answer — or, if the server's 60s negative
 * cache expired between the two calls, a DIFFERENT one, leaving the
 * outlet and the route disagreeing about what this host is. One
 * question, one answer.
 */
let inFlight: Promise<LookupResult> | null = null;

/**
 * `definitive` separates "the server answered" from "we never got an
 * answer". A 404 is an answer — this host is not a funnel. A timeout, a
 * dropped connection or a 5xx is not, and must not be remembered.
 */
interface LookupResult {
  slug: string | null;
  definitive: boolean;
}

/**
 * The root route awaits this before anything paints, and the router
 * declares no pending component — so an unbounded request here is a
 * blank page, not a slow one. An API that REJECTS falls through by
 * design; one that HANGS would not, which is what this bounds.
 */
const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Resolve to a non-definitive miss if `work` outruns the budget.
 *
 * Deliberately a race rather than an `AbortSignal` on the request: the
 * requirement is that the first paint is not blocked, not that the
 * request is cancelled. An abandoned lookup costs one in-flight GET and
 * settles into the void; wiring cancellation through the typed RPC
 * client's option shape bought nothing and broke the request.
 */
function withTimeout(work: Promise<LookupResult>): Promise<LookupResult> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<LookupResult>((resolve) => {
    timer = setTimeout(() => resolve({ slug: null, definitive: false }), LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

async function lookupCustomHostSlug(): Promise<LookupResult> {
  if (typeof window === "undefined") return { slug: null, definitive: true };
  const hostname = window.location.hostname;
  // Skips the request entirely on the canonical host. UNSET means "not
  // known to be canonical" and the lookup runs — see lib/custom-host.ts.
  if (isCanonicalDashboardHost(dashboardHostEnv, hostname)) {
    return { slug: null, definitive: true };
  }
  try {
    const res = await unwrap<{ funnelId: string; slug: string }>(
      rpc.public.host.lookup.$get(
        { query: { host: hostname } },
        { init: { credentials: "omit" } },
      ),
    );
    return { slug: res.slug, definitive: true };
  } catch (err) {
    return {
      slug: null,
      definitive: err instanceof ApiError && err.status === 404,
    };
  }
}

/**
 * Resolve the browser's current hostname to a funnel slug, or null.
 *
 * Runs before the session check because a funnel visitor on a customer's
 * domain has no dashboard session and must not be bounced to /login.
 *
 * A failing lookup returns null and falls through to the dashboard
 * landing: a lookup outage must never stop the dashboard loading.
 *
 * Exported so `__root.tsx` can reuse this exact lookup for its own
 * "render the funnel instead of the router outlet" branch — there is
 * exactly one place in the app that decides whether a host is a
 * customer's funnel domain.
 */
export async function resolveCustomHost(): Promise<LookupResult> {
  // `.catch` is belt-and-braces: nothing in `lookupCustomHostSlug` throws
  // today, but a rejected memo would reject in EVERY route's beforeLoad
  // for the life of the document and take the whole dashboard down.
  //
  // The result is kept even when the lookup FAILED, and that is
  // deliberate. An earlier version cleared it so a transient 5xx could be
  // retried — but the root route and "/" both ask, so a retry meant the
  // two could get different answers and disagree about what this host is:
  // root committing `<Outlet/>` while "/" decided it was a funnel and
  // returned early, leaving a blank screen. One lookup per document, one
  // answer. A failed lookup is surfaced honestly instead (see __root.tsx)
  // rather than silently retried into a contradiction.
  inFlight ??= withTimeout(
    lookupCustomHostSlug().catch(() => ({ slug: null, definitive: false })),
  );
  return inFlight;
}

/** Convenience for callers that only care about the slug. */
export async function resolveCustomHostSlug(): Promise<string | null> {
  return (await resolveCustomHost()).slug;
}

/** Test-only: drop the memoised lookup between cases. */
export function _resetCustomHostSlugForTests(): void {
  inFlight = null;
}

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    // __root.tsx already resolved the same host and, if it's a funnel
    // domain, is rendering `<FunnelRunner>` in place of the router
    // outlet — this route's own component never mounts in that case.
    // This check only exists so the session redirect below doesn't
    // also fire and change the URL out from under that visitor.
    const funnelSlug = await resolveCustomHostSlug();
    if (funnelSlug) return;

    const session = await getSession();
    if (!session.data) {
      throw redirect({ to: "/login", search: { error: undefined } });
    }

    let res: { projects: ProjectSummary[] };
    try {
      res = await queryClient.ensureQueryData({
        queryKey: ["projects"],
        queryFn: () =>
          unwrap<{ projects: ProjectSummary[] }>(rpc.dashboard.projects.$get()),
      });
    } catch (err) {
      const expired = err instanceof ApiError && err.status === 401;
      console.error("[/] failed to load projects", err);
      throw redirect({
        to: "/login",
        search: { error: expired ? "session_expired" : "load_failed" },
      });
    }

    const target = resolveLandingTarget(res.projects);
    if (target.kind === "setup") {
      throw redirect({ to: "/projects/setup" });
    }
    throw redirect({
      to: "/projects/$projectId",
      params: { projectId: target.projectId },
    });
  },
});
