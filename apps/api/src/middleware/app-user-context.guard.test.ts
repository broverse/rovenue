import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// =============================================================
// The un-erasure invariant, enforced rather than audited
// =============================================================
//
// An erased (soft-deleted) subscriber must never be written to. The
// resolver computes `deadEnded`, `appUserContext` puts it on the
// context as `subscriberDeadEnded`, and each route decides what to do
// with it.
//
// The ORIGINAL bug was not a missing flag. The flag existed and was
// silently discarded by a wrapper that destructured only
// `{ subscriber }` -- so every route behind the middleware wrote onto
// soft-deleted rows while looking correct. A later review re-enumerated
// the mounts and callers by hand and found them all correct, but a
// hand audit protects only the tree it was run against: nothing stopped
// the NEXT route from mounting the middleware, writing, and never
// reading the flag.
//
// This test is that missing stop. A file that mounts the middleware or
// calls the resolvers directly must reference the dead-ended signal in
// real code, or be named below with a reason.
//
// WHAT WOULD FOOL IT: it proves a file LOOKS at the signal, not that it
// acts correctly on it -- a route could read `deadEnded` and ignore the
// result. It also cannot see an allow-listed read-only route that later
// grows a write path, which is why every exemption states the read-only
// claim explicitly: that sentence is what a reviewer re-checks when the
// handler changes. Behavioural coverage lives in the per-route
// `*-dead-ended` suites.

// The WHOLE of src/, not an enumerated list of directories. An earlier
// version named three roots, then four; a review then pointed out that
// `src/queues` was still uncovered and structurally the same hazard as
// `src/workers`. Enumerating directories means re-deciding this every
// time the tree grows a new one, and the cost of forgetting is silent.
// Scanning everything cannot be forgotten, and it is not slower in any
// way that matters here.
const SCAN_ROOTS = ["src"];

const MIDDLEWARE_SYMBOL = "appUserContext";
const RESOLVER_SYMBOLS = [
  "resolveOrCreateSubscriber",
  "resolveSubscriberForWrite",
] as const;
const GUARD_SYMBOLS = ["deadEnded", "subscriberDeadEnded"] as const;

/**
 * Files that reach the resolver or the middleware and deliberately do
 * NOT branch on the signal. Every entry states why -- a bare path would
 * be unreadable six months from now, and the reason is what a reviewer
 * re-checks when the handler changes.
 */
const ALLOWED_WITHOUT_GUARD: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "src/routes/v1/billing-portal.ts",
    reason:
      "Read-only against Postgres: a domain-verification read, a " +
      "stripeCustomerId read, and a Stripe API call scoped to the " +
      "subscriber's EXISTING customer. It writes no row and stamps no " +
      "metadata that a webhook resolves back onto the subscriber, so " +
      "there is no path here that re-populates an erased row.",
  },
  {
    file: "src/routes/v1/virtual-currencies.ts",
    reason:
      "Only the appUserContext handler is exempt: GET /me reads balances " +
      "for the already-resolved subscriber id and writes nothing. This " +
      "file DOES hold a write -- POST /:appUserId/:code/transactions " +
      "debits a balance -- but that route takes requireSecretKey and " +
      "resolveSubscriber, never appUserContext, so it is out of this " +
      "invariant's scope rather than exempt from it. Said explicitly " +
      "because a reviewer checking a bare \"writes nothing\" claim " +
      "against this file would find a write and distrust the wrong line.",
  },
];

function stripComments(source: string): string {
  // A comment mentioning `deadEnded` must not satisfy the invariant --
  // that is exactly the shape of a route that documents the concern and
  // then forgets to act on it.
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // TRAILING comments count, not only whole-line ones: an
      // earlier version stripped `^\s*//…` alone, so
      // `const s = c.get("subscriber"); // deadEnded: n/a here`
      // satisfied the check — the exact "documents the concern, then
      // forgets to act on it" shape this is supposed to exclude. The
      // `(?<!:)` keeps a URL's `://` intact. Over-stripping (a `//`
      // inside a string literal) can only REMOVE text, which makes the
      // invariant stricter, never weaker.
      .replace(/(?<!:)\/\/.*$/gm, "")
  );
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      if (entry.includes(".test.")) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
}

function touchesSubscriberWritePath(code: string): boolean {
  if (code.includes(MIDDLEWARE_SYMBOL)) return true;
  return RESOLVER_SYMBOLS.some((symbol) => code.includes(symbol));
}

function readsGuardSignal(code: string): boolean {
  return GUARD_SYMBOLS.some((symbol) => code.includes(symbol));
}

describe("appUserContext un-erasure invariant", () => {
  const files = SCAN_ROOTS.flatMap(collectSourceFiles);
  const allowed = new Set(ALLOWED_WITHOUT_GUARD.map((e) => e.file));

  it("finds files to check at all", () => {
    // Without this, a broken scan root would make every assertion below
    // vacuously true -- the failure mode of every source-scanning test.
    const reaching = files.filter((f) =>
      touchesSubscriberWritePath(stripComments(readFileSync(f, "utf8"))),
    );
    expect(reaching.length).toBeGreaterThan(5);
  });

  it("every route reaching an erasable subscriber reads the signal or is exempt", () => {
    // Catches: a new route mounts appUserContext (or calls the resolver)
    // and writes without ever consulting deadEnded -- the original bug,
    // reintroduced.
    const offenders = files.filter((file) => {
      if (allowed.has(file)) return false;
      const code = stripComments(readFileSync(file, "utf8"));
      return touchesSubscriberWritePath(code) && !readsGuardSignal(code);
    });

    expect(
      offenders,
      `These reach a subscriber that may be erased but never read ` +
        `${GUARD_SYMBOLS.join(" / ")}. Either branch on it, or add an ` +
        `entry to ALLOWED_WITHOUT_GUARD stating why the path cannot ` +
        `write to an erased row.`,
    ).toEqual([]);
  });

  it("has no stale exemptions", () => {
    // Catches: a file is deleted or renamed and its exemption lingers,
    // silently pre-approving whatever later takes that path.
    const stale = ALLOWED_WITHOUT_GUARD.filter((e) => !files.includes(e.file));
    expect(stale.map((e) => e.file)).toEqual([]);
  });

  it("gives every exemption a substantive reason", () => {
    // Catches: an exemption added under deadline pressure with an empty
    // or throwaway reason, which is how an allow-list stops being a
    // record of decisions and becomes a way to silence the test.
    const MIN_REASON_LENGTH = 40;
    const thin = ALLOWED_WITHOUT_GUARD.filter(
      (e) => e.reason.trim().length < MIN_REASON_LENGTH,
    );
    expect(thin.map((e) => e.file)).toEqual([]);
  });
});
