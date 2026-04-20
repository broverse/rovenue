// =============================================================
// Shadow-read helper
// =============================================================
//
// During the Prisma → Drizzle coexistence window we run every
// migrated read path through BOTH ORMs, compare the results, and
// keep returning the Prisma (canonical) answer to the caller.
// Any structural divergence surfaces in logs with a stable
// fingerprint so we can chase down shape differences without
// breaking production.
//
// Flip `DB_SHADOW_READS=0` in env to short-circuit the shadow
// call completely — useful when the worker is under load or the
// tail latency cost is visible.

import type { Logger } from "../types";

// =============================================================
// Shape constants
// =============================================================
//
// Exported so tests, alert rules, and downstream log consumers
// pattern-match against symbolic names instead of string
// literals. If we rename a kind we rename one identifier.

export const SHADOW_DIVERGENCE_KIND = {
  PrimaryThrewShadowOk: "primary-threw-shadow-ok",
  ShadowThrewPrimaryOk: "shadow-threw-primary-ok",
  ResultMismatch: "result-mismatch",
} as const;

export type ShadowDivergenceKind =
  (typeof SHADOW_DIVERGENCE_KIND)[keyof typeof SHADOW_DIVERGENCE_KIND];

export const SHADOW_LOG_EVENT = "shadow-read.divergence";

export interface ShadowReadOptions {
  /** Caller-readable identifier, e.g. "subscriber.findByAppUserId". */
  name: string;
  /** Optional structured context recorded alongside divergences. */
  context?: Record<string, unknown>;
  /**
   * Silence the shadow call entirely when `false`. Callers wire
   * this to `env.DB_SHADOW_READS === "1"` (or similar) so ops can
   * toggle it without a deploy.
   */
  enabled?: boolean;
  /**
   * Caller's logger. We don't import @rovenue/api's logger to
   * keep packages/db free of app-layer deps.
   */
  logger?: Logger;
}

export interface ShadowDivergence {
  name: string;
  context: Record<string, unknown> | undefined;
  kind: ShadowDivergenceKind;
  primary?: unknown;
  shadow?: unknown;
  diff?: string;
}

export async function shadowRead<T>(
  primary: () => Promise<T>,
  shadow: () => Promise<T>,
  opts: ShadowReadOptions,
): Promise<T> {
  if (opts.enabled === false) return primary();

  const [p, s] = await Promise.allSettled([primary(), shadow()]);

  if (p.status === "rejected" && s.status === "fulfilled") {
    log(opts, {
      name: opts.name,
      context: opts.context,
      kind: SHADOW_DIVERGENCE_KIND.PrimaryThrewShadowOk,
      primary: errorShape(p.reason),
      shadow: s.value,
    });
    throw p.reason;
  }

  if (p.status === "rejected") {
    // Both failed — nothing to compare; let the primary error fly.
    throw p.reason;
  }

  if (s.status === "rejected") {
    log(opts, {
      name: opts.name,
      context: opts.context,
      kind: SHADOW_DIVERGENCE_KIND.ShadowThrewPrimaryOk,
      primary: p.value,
      shadow: errorShape(s.reason),
    });
    return p.value;
  }

  const diff = structuralDiff(p.value, s.value);
  if (diff) {
    log(opts, {
      name: opts.name,
      context: opts.context,
      kind: SHADOW_DIVERGENCE_KIND.ResultMismatch,
      primary: p.value,
      shadow: s.value,
      diff,
    });
  }
  return p.value;
}

// =============================================================
// Structural diff
// =============================================================
//
// Intentionally narrow: we canonicalise both sides (sorted keys,
// dates → ISO strings, Decimals via toString) and compare the
// resulting JSON. The goal is reliable YES/NO on "do these rows
// match", not a rich diff library. Returns a short path string
// when values differ, `null` when equal.

function structuralDiff(a: unknown, b: unknown, path = ""): string | null {
  if (Object.is(a, b)) return null;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime() ? null : `${path}: date`;
  }

  if (hasToString(a) && hasToString(b) && a.toString() === b.toString()) {
    return null;
  }

  if (a === null || b === null || typeof a !== typeof b) {
    return `${path || "/"}: type`;
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return `${path}: shape`;
    if (a.length !== b.length) return `${path}: length`;
    for (let i = 0; i < a.length; i++) {
      const inner = structuralDiff(a[i], b[i], `${path}[${i}]`);
      if (inner) return inner;
    }
    return null;
  }

  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      if (!(k in ao) || !(k in bo)) return `${path}.${k}: missing`;
      const inner = structuralDiff(ao[k], bo[k], `${path}.${k}`);
      if (inner) return inner;
    }
    return null;
  }

  return path || "/";
}

function hasToString(value: unknown): value is { toString: () => string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toString?: unknown }).toString === "function" &&
    // Exclude the default Object.prototype.toString which just
    // returns "[object Object]" for every POJO.
    (value as { toString: () => string }).toString !== Object.prototype.toString
  );
}

function errorShape(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

function log(opts: ShadowReadOptions, d: ShadowDivergence): void {
  if (opts.logger?.warn) {
    opts.logger.warn(SHADOW_LOG_EVENT, d as unknown as Record<string, unknown>);
  } else {
    // Fall back to a plain structured line if the caller didn't
    // provide a logger (tests, scripts). Never throws.
    console.warn(JSON.stringify({ event: SHADOW_LOG_EVENT, ...d }));
  }
}
