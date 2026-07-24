// =============================================================
// Node-level visibility: which platforms and app versions a node
// renders on. Evaluated CLIENT-SIDE by every renderer — the server
// ships the published snapshot whole.
//
// The governing rule is FAIL OPEN. Every unknown resolves to visible:
// an unknown platform, an unknown app version, a version we cannot
// parse, an empty platform list. Hiding content because we could not
// tell would silently break paywalls on any facade that has not
// supplied these facts yet, and the web renderer never will.
// =============================================================

export type VisibilityPlatform = "ios" | "android" | "web";

export type NodeVisibility = {
  /** Platforms this node renders on. Absent OR EMPTY means all of them. */
  platform?: VisibilityPlatform[];
  /** Inclusive bounds on the host app's version. */
  minAppVersion?: string;
  maxAppVersion?: string;
};

export type VisibilityContext = {
  platform?: VisibilityPlatform | null;
  appVersion?: string | null;
};

const VERSION_SEPARATOR = ".";
const NUMERIC_COMPONENT = /^\d+$/;

/**
 * Component-wise numeric comparison. Missing components read as 0, so
 * "1.2" equals "1.2.0" and "1.10" beats "1.9".
 *
 * Returns `null` — inconclusive — when either side has a component that
 * is not a run of digits. Deliberately NOT semver: a real implementation
 * would have to be written four times over and agree exactly, and
 * pre-release ordering is not a rule anyone authoring a paywall bound is
 * thinking about. Refusing to guess is the honest answer, and an
 * inconclusive comparison fails open at the call site.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = a.split(VERSION_SEPARATOR);
  const right = b.split(VERSION_SEPARATOR);
  if (![...left, ...right].every((part) => NUMERIC_COMPONENT.test(part))) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = Number(left[i] ?? 0);
    const r = Number(right[i] ?? 0);
    if (l !== r) return l - r;
  }
  return 0;
}

/** True when the node should render in this context. */
export function isNodeVisible(
  visibility: NodeVisibility | undefined,
  ctx: VisibilityContext,
): boolean {
  if (!visibility) return true;

  const { platform } = visibility;
  // An empty array is what the builder produces the moment an author
  // unticks the last box. Reading it as "nowhere" would let a stray click
  // delete content from every device.
  if (platform && platform.length > 0 && ctx.platform && !platform.includes(ctx.platform)) {
    return false;
  }

  const version = ctx.appVersion;
  if (!version) return true;

  const { minAppVersion, maxAppVersion } = visibility;
  if (minAppVersion) {
    const cmp = compareVersions(version, minAppVersion);
    if (cmp !== null && cmp < 0) return false;
  }
  if (maxAppVersion) {
    const cmp = compareVersions(version, maxAppVersion);
    if (cmp !== null && cmp > 0) return false;
  }
  return true;
}
