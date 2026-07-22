import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import { serializeEnvelope, type EventEnvelope } from "../events";
import { mapOfferingDTO } from "./purchases";
import type { Paywall, PresentedContext } from "../types";
import type { PaywallDTO, PresentedContextDTO } from "../specs/RovenueModule.types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/** Parse the native side's raw `remoteConfigJson` string into an object.
 *  Tolerant by design: `null`, malformed JSON, or a non-object top level
 *  all yield `null` — a paywall with a broken remote-config payload must
 *  still resolve, just without the config. */
export function parseRemoteConfig(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mapPresentedContext(dto: PresentedContextDTO): PresentedContext {
  return {
    placementId: dto.placementId,
    paywallId: dto.paywallId,
    variantId: dto.variantId,
    experimentKey: dto.experimentKey,
    revision: dto.revision,
  };
}

/** Maps the native `PaywallDTO` to the public `Paywall` domain type. */
export function mapPaywallDTO(dto: PaywallDTO): Paywall {
  return {
    placementIdentifier: dto.placementIdentifier,
    placementRevision: dto.placementRevision,
    paywallIdentifier: dto.paywallIdentifier,
    paywallName: dto.paywallName,
    configFormatVersion: dto.configFormatVersion,
    remoteConfig: parseRemoteConfig(dto.remoteConfigJson),
    remoteConfigLocale: dto.remoteConfigLocale,
    builderConfig: parseRemoteConfig(dto.builderConfigJson),
    offering: dto.offering ? mapOfferingDTO(dto.offering) : null,
    presentedContext: dto.presentedContext ? mapPresentedContext(dto.presentedContext) : null,
    servedFromFallback: dto.servedFromFallback,
  };
}

/**
 * Resolve a placement to a paywall — either a direct assignment or the
 * winning variant of a client-drawn PAYWALL experiment (the native SDK does
 * the draw + best-effort exposure beacon). `null` means the placement
 * resolved to nothing (retired, `target: none`, unknown identifier) — not
 * an error; a shipped app must not crash because a placement was retired
 * server-side.
 */
export async function getPaywall(placementId: string, locale?: string): Promise<Paywall | null> {
  const dto = await call(() => getNative().getPaywall(placementId, locale));
  return dto ? mapPaywallDTO(dto) : null;
}

/**
 * Parse a spec D1 bundled fallback-placements file (once, replacing any
 * previously-loaded set) so `getPaywall` can serve placements offline when
 * both the network and disk cache miss. Resolves to the count of placement
 * entries actually loaded — an individual entry that fails to decode is
 * skipped natively, not fatal. Rejects with a distinct `invalidArgument`
 * error when the file doesn't parse or its `formatVersion` isn't literal
 * `1` — an integrator who bundles a stale/mismatched export must see this
 * loudly, at call time.
 */
export async function setFallbackPlacements(json: string): Promise<number> {
  return call(() => getNative().setFallbackPlacements(json));
}

/** Builds the `paywall_view` event envelope `logPaywallShown` enqueues.
 *  Returns `undefined` when the paywall carries no `presentedContext` —
 *  this is analytics, not a critical path, so a paywall resolved from a
 *  payload that (for whatever reason) has no attribution snapshot is
 *  silently skipped rather than sending a `paywallContext`-less envelope
 *  the server's `.strict()` schema would reject anyway. */
export function buildPaywallViewEnvelope(
  paywall: Paywall,
  eventId: string,
  occurredAt: string,
): EventEnvelope | undefined {
  const ctx = paywall.presentedContext;
  if (!ctx) return undefined;
  return {
    version: 1,
    eventId,
    eventType: "paywall_view",
    occurredAt,
    paywallContext: {
      paywallId: ctx.paywallId,
      placementId: ctx.placementId,
      placementRevision: ctx.revision,
      variantId: ctx.variantId ?? undefined,
      experimentKey: ctx.experimentKey ?? undefined,
    },
  };
}

/** Builds the `paywall_close` event envelope `logPaywallClosed` enqueues.
 *  Exact sibling of `buildPaywallViewEnvelope` — see its doc comment for
 *  the `undefined` rationale. */
export function buildPaywallCloseEnvelope(
  paywall: Paywall,
  eventId: string,
  occurredAt: string,
): EventEnvelope | undefined {
  const ctx = paywall.presentedContext;
  if (!ctx) return undefined;
  return {
    version: 1,
    eventId,
    eventType: "paywall_close",
    occurredAt,
    paywallContext: {
      paywallId: ctx.paywallId,
      placementId: ctx.placementId,
      placementRevision: ctx.revision,
      variantId: ctx.variantId ?? undefined,
      experimentKey: ctx.experimentKey ?? undefined,
    },
  };
}

/**
 * Report that `paywall` was actually shown to the subscriber. Builds a
 * `paywall_view` event (sourced from `paywall.presentedContext`) and
 * enqueues it via the native `enqueuePaywallEvent(envelopeJson)` bridge
 * method — this persists the event into the Rust core's durable on-disk
 * queue and triggers a background drain (spec D4), so the impression
 * survives a process kill instead of being lost like a fire-and-forget
 * inline POST would be. Best-effort from the caller's perspective:
 * fire-and-forget (mirrors `sessionTracker.ts`'s
 * `getNative().recordSessionEvent(...).catch(() => {})` pattern) — a
 * paywall-impression beacon must never block or fail the caller's UI code.
 */
export function logPaywallShown(paywall: Paywall): void {
  const envelope = buildPaywallViewEnvelope(
    paywall,
    `evt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    new Date().toISOString(),
  );
  if (!envelope) return;
  getNative()
    .enqueuePaywallEvent(serializeEnvelope(envelope))
    .catch(() => {});
}

/**
 * Report that `paywall` was closed by the subscriber. Builds a
 * `paywall_close` event (sourced from `paywall.presentedContext`) and
 * enqueues it via the native `enqueuePaywallEvent(envelopeJson)` bridge
 * method — this persists the event into the Rust core's durable on-disk
 * queue and triggers a background drain (spec D4), so the close event
 * survives a process kill instead of being lost like a fire-and-forget
 * inline POST would be. Best-effort from the caller's perspective:
 * fire-and-forget (mirrors `sessionTracker.ts`'s
 * `getNative().recordSessionEvent(...).catch(() => {})` pattern) — a
 * paywall-close beacon must never block or fail the caller's UI code.
 */
export function logPaywallClosed(paywall: Paywall): void {
  const envelope = buildPaywallCloseEnvelope(
    paywall,
    `evt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    new Date().toISOString(),
  );
  if (!envelope) return;
  getNative()
    .enqueuePaywallEvent(serializeEnvelope(envelope))
    .catch(() => {});
}
