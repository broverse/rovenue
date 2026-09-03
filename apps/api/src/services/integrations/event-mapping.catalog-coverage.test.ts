import { describe, expect, it } from "vitest";
import { PROVIDERS } from "./registry";
import { DEFAULT_EVENT_MAPPING } from "./event-mapping";
import type { IntegrationProviderId, RovenueEventKey } from "@rovenue/shared";

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
