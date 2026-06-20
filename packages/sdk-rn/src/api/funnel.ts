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
export async function claimInstall(params: ClaimInstallParams): Promise<FunnelClaimResult | null> {
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
