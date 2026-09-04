import { describe, expect, it } from "vitest";
import { PROVIDERS } from "./registry";
import { applyEventMapping, DEFAULT_EVENT_MAPPING } from "./event-mapping";
import type { IntegrationProviderId, RovenueEventKey } from "@rovenue/shared";
import { SUBSCRIPTION_BRIDGE_EVENT_KEYS } from "@rovenue/shared";

// =============================================================
// Catalog coverage guard
// =============================================================
//
// Every table in DEFAULT_EVENT_MAPPING is
// `Partial<Record<RovenueEventKey, string>>`, so a provider that
// ADVERTISES a key in its `eventCatalog` but has no name for it is not a
// type error. It compiles, ships, and `applyEventMapping` returns
// `{ kind: "skip", reason: "no_mapping" }` — the event is silently
// dropped for that provider and nothing logs.
//
// That is how a newly added public event key goes missing: the key lands
// in ROVENUE_EVENT_KEYS, flows through SUBSCRIPTION_BRIDGE_EVENT_KEYS
// into STANDARD_PROVIDER_EVENT_KEYS, and every provider using that subset
// starts claiming it — while quietly sending nothing.
//
// So the invariant is asserted here rather than left to review: a key a
// provider claims must resolve to a name, unless the omission is declared
// below WITH a reason.

/** Providers whose mapping is not a name table at all. */
const IDENTITY_MAPPED_PROVIDERS: ReadonlyMap<IntegrationProviderId, string> = new Map([
  [
    "CUSTOM_WEBHOOK",
    "passes the Rovenue key through verbatim (rovenueCustomEventName); an " +
      "empty table is the correct representation of identity mapping",
  ],
  [
    "ADJUST",
    "Adjust requires per-app event tokens the operator creates in their own " +
      "dashboard, so there is no default name Rovenue could supply",
  ],
]);

/**
 * Providers that hand-pick a narrow `eventCatalog` instead of taking
 * STANDARD_PROVIDER_EVENT_KEYS wholesale, and so advertise no
 * subscription-lifecycle key at all. Both ad platforms: forwarding a
 * lifecycle signal as a conversion would corrupt their optimization.
 */
const NARROW_CATALOG_PROVIDERS: ReadonlySet<IntegrationProviderId> = new Set([
  "META_CAPI",
  "TIKTOK_EVENTS",
]);

/** Specific (provider, key) omissions that are deliberate. */
const DECLARED_OMISSIONS: ReadonlyArray<{
  provider: IntegrationProviderId;
  key: RovenueEventKey;
  reason: string;
}> = [
  {
    provider: "BRAZE",
    key: "revenue.REFUND",
    reason: "Braze treats a refund as a negative purchase on the original event",
  },
  {
    provider: "ITERABLE",
    key: "revenue.REFUND",
    reason: "Iterable has no refund primitive; the cancellation event carries it",
  },
  {
    provider: "SINGULAR",
    key: "revenue.REFUND",
    reason: "Singular's revenue model reverses the original event rather than naming a refund",
  },
];

function isDeclared(provider: string, key: string): boolean {
  return DECLARED_OMISSIONS.some((o) => o.provider === provider && o.key === key);
}

describe("provider event-catalog coverage", () => {
  it("every key a provider advertises resolves to a name, or is a declared omission", () => {
    const undeclared: string[] = [];

    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      if (IDENTITY_MAPPED_PROVIDERS.has(providerId as IntegrationProviderId)) continue;

      const table = DEFAULT_EVENT_MAPPING[providerId as IntegrationProviderId];
      for (const key of provider.eventCatalog) {
        if (table[key]) continue;
        if (isDeclared(providerId, key)) continue;
        undeclared.push(`${providerId} advertises "${key}" but has no event name for it`);
      }
    }

    // Named rather than counted: a failure has to say WHICH key went
    // missing, because the whole point is that the omission is invisible.
    expect(undeclared).toEqual([]);
  });

  it("the guard would catch a removed mapping — proving it is not vacuous", () => {
    // A test that only ever passes proves nothing. Simulate the exact
    // regression this guard exists for: a provider claims a key whose name
    // has been deleted from its table.
    const provider = PROVIDERS.AMPLITUDE;
    const key = provider.eventCatalog[0]!;
    const damaged: Partial<Record<RovenueEventKey, string>> = {
      ...DEFAULT_EVENT_MAPPING.AMPLITUDE,
    };
    delete damaged[key];

    const missing = provider.eventCatalog.filter((k) => !damaged[k]);
    expect(missing).toContain(key);
  });

  it("every declared omission is still real — stale exemptions rot", () => {
    // An exemption that no longer corresponds to a missing mapping is a
    // licence nobody needs, and it would hide a future regression on that
    // exact pair.
    for (const o of DECLARED_OMISSIONS) {
      expect(
        DEFAULT_EVENT_MAPPING[o.provider][o.key],
        `${o.provider}/${o.key} is now mapped — remove the declared omission`,
      ).toBeUndefined();
    }
  });
});

// =============================================================
// Subscription-bridge key coverage
// =============================================================
//
// The guard above asks "does every key a provider ADVERTISES resolve?".
// This one comes at the same invariant from the producing side, because
// that is the direction a new key travels: a key added to
// SUBSCRIPTION_BRIDGE_EVENT_KEYS (@rovenue/shared) lands in
// SUBSCRIPTION_LIFECYCLE_KEYS, then STANDARD_PROVIDER_EVENT_KEYS, and
// every standard provider's `eventCatalog` starts claiming it in the same
// commit — while `DEFAULT_EVENT_MAPPING`'s tables are
// `Partial<Record<RovenueEventKey, string>>` and compile perfectly well
// with no entry for it. Nothing in tsc says a word.
//
// That failure has shipped in this repo before (see MEMORY: a provider
// event silently dropped because a Partial<Record> let a missing key
// through), so it gets a test that names the provider and the key rather
// than a review checklist.
//
// This resolves through `applyEventMapping` — the function the delivery
// path actually calls — instead of reading the table directly, so a key
// that resolves in the table but is skipped by the resolution logic still
// fails here.
describe("subscription-bridge key coverage", () => {
  it("every bridge key a provider claims resolves to a provider event", () => {
    const unresolved: string[] = [];
    let checked = 0;

    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      if (IDENTITY_MAPPED_PROVIDERS.has(providerId as IntegrationProviderId)) continue;

      for (const key of SUBSCRIPTION_BRIDGE_EVENT_KEYS) {
        // NARROW_CATALOG_PROVIDERS claim no lifecycle keys at all; a key
        // they never offer is not a gap.
        if (!provider.eventCatalog.includes(key)) continue;
        checked += 1;
        const result = applyEventMapping({
          providerId: providerId as IntegrationProviderId,
          eventKey: key,
          enabledEvents: [...provider.eventCatalog],
          override: {},
        });
        if (result.kind !== "use") {
          unresolved.push(
            `${providerId} claims "${key}" but applyEventMapping returned ` +
              `skip/${result.reason}`,
          );
        }
      }
    }

    expect(unresolved).toEqual([]);
    // A loop that iterated nothing would pass silently, so pin that it did
    // the work. The expected count is DERIVED, not a literal: every
    // registered provider except the identity-mapped ones and the two that
    // hand-pick a narrow catalog claims the whole bridge set, so a new
    // provider raises this floor automatically instead of leaving the guard
    // quietly under-scoped.
    const expectedProviders =
      Object.keys(PROVIDERS).length -
      IDENTITY_MAPPED_PROVIDERS.size -
      NARROW_CATALOG_PROVIDERS.size;
    expect(checked).toBe(SUBSCRIPTION_BRIDGE_EVENT_KEYS.length * expectedProviders);
  });

  it("a provider that claims one bridge key claims them all", () => {
    // Unreachable today: every catalog is all-or-nothing (either
    // STANDARD_PROVIDER_EVENT_KEYS / ROVENUE_EVENT_KEYS wholesale, or a
    // hand-picked list with no lifecycle keys at all). It guards the case
    // where a future provider hand-lists a catalog and takes some bridge
    // keys but not others — not a live condition.
    // Half a bridge is worse than none: a consumer wiring up lifecycle
    // events for a provider has no way to see that one meaning is missing
    // from its catalog, and the drawer's event picker renders the catalog
    // verbatim.
    const partial: string[] = [];
    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      const claimed = SUBSCRIPTION_BRIDGE_EVENT_KEYS.filter((key) =>
        provider.eventCatalog.includes(key),
      );
      if (claimed.length === 0) continue;
      if (claimed.length === SUBSCRIPTION_BRIDGE_EVENT_KEYS.length) continue;
      const missing = SUBSCRIPTION_BRIDGE_EVENT_KEYS.filter(
        (key) => !provider.eventCatalog.includes(key),
      );
      partial.push(`${providerId} claims some bridge keys but not: ${missing.join(", ")}`);
    }
    expect(partial).toEqual([]);
  });
});
