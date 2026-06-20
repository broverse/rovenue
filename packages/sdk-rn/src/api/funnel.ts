import { getNative, getEmitter } from "../core/native";
import { mapNativeError } from "../errors";

export interface FunnelClaimResult {
  subscriberId: string;
  funnelAnswers: Record<string, unknown>;
}

export interface ClaimInstallParams {
  platform: "ios" | "android";
  locale: string;
  timezone: string;
  screenDims: string;       // "WIDTHxHEIGHT"
  deviceModel?: string;
  installReferrer?: string;
}

interface NativeClaim { subscriberId: string; funnelAnswersJson: string }

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

function parse(n: NativeClaim): FunnelClaimResult {
  let funnelAnswers: Record<string, unknown> = {};
  try { funnelAnswers = JSON.parse(n.funnelAnswersJson) as Record<string, unknown>; } catch { /* keep {} */ }
  return { subscriberId: n.subscriberId, funnelAnswers };
}

/** Claim a known funnel token (e.g. from a deep link). */
export async function claimFunnelToken(token: string): Promise<FunnelClaimResult> {
  return call(async () => parse(await getNative().claimFunnelToken(token)));
}

/** Recover + claim via install attribution. Resolves `null` when no match. */
export async function claimInstall(
  params: Partial<ClaimInstallParams> = {},
): Promise<FunnelClaimResult | null> {
  return call(async () => {
    const n = (await getNative().claimInstall(params)) as NativeClaim | null;
    return n ? parse(n) : null;
  });
}

/** Kick off the email magic-link claim (resolves later via deep link). */
export async function claimViaEmail(email: string): Promise<void> {
  return call(() => getNative().claimViaEmail(email));
}

/** Persisted per-install id. */
export async function installId(): Promise<string> {
  return call(() => getNative().installId());
}

/** Subscribe to resolved funnel claims (direct calls + future auto-resolution). */
export function addFunnelClaimListener(cb: (result: FunnelClaimResult) => void): () => void {
  const sub = getEmitter().addListener("onFunnelClaimResolved", (p: NativeClaim) => cb(parse(p)));
  return () => sub.remove();
}

/** iOS only: read a `rovenue-funnel:` clipboard marker (after a user gesture)
 *  and claim it. Resolves null on Android, or when no marker is present. */
export async function claimFromClipboard(): Promise<FunnelClaimResult | null> {
  return call(async () => {
    const n = (await getNative().claimFromClipboard()) as NativeClaim | null;
    return n ? parse(n) : null;
  });
}

function safeDecode(s: string): string {
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Extract a funnel token from a deep link / Universal Link. Recognises:
 *  - Universal Link path: `…/funnels/open/<token>`
 *  - `rovenue_funnel_token=<token>` query (anywhere — Rovenue-specific key)
 *  - `token=<token>` query ONLY on the funnel deep-link host
 *    (`…onboarding-complete…`) so an unrelated deep link's generic `token=` is
 *    not mistaken for a funnel token.
 * Returns null for any non-funnel URL. Does not use the `URL` constructor
 * (unreliable for custom schemes in RN/Hermes).
 */
export function extractFunnelToken(url: string): string | null {
  if (!url) return null;

  // 1) Universal-link path: the segment after "funnels/open/".
  const marker = "funnels/open/";
  const mi = url.indexOf(marker);
  if (mi !== -1) {
    const rest = url.slice(mi + marker.length);
    const seg = rest.split("/")[0].split("?")[0].split("#")[0];
    if (seg) return seg;
  }

  // 2) Query-string extraction (manual parse — no URL constructor).
  const qi = url.indexOf("?");
  if (qi !== -1) {
    const query = url.slice(qi + 1).split("#")[0];
    let generic: string | null = null;
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.slice(0, eq);
      const val = safeDecode(pair.slice(eq + 1));
      if (!val) continue;
      if (key === "rovenue_funnel_token") return val; // Rovenue-specific → trust anywhere
      if (key === "token") generic = val;
    }
    // generic `token=` only on the Rovenue funnel deep-link host.
    // Check only the pre-query portion so a crafted query key like
    // `?onboarding-complete=1&token=…` cannot bypass this gate.
    const beforeQuery = url.slice(0, qi);
    if (generic && beforeQuery.includes("onboarding-complete")) return generic;
  }

  return null;
}

/**
 * Claim a funnel token carried by a deep link / Universal Link. Forward every
 * incoming URL here from your app's Linking handler; non-funnel URLs resolve
 * `null` without a network call. A recognized-but-invalid token surfaces the
 * usual claim error via the returned promise.
 */
export async function claimFromUrl(url: string): Promise<FunnelClaimResult | null> {
  const token = extractFunnelToken(url);
  if (!token) return null;
  return call(async () => parse(await getNative().claimFunnelToken(token)));
}
