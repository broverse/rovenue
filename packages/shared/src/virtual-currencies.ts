// =============================================================
// Currency grant triggers
// =============================================================
//
// `grantOn` says which lifecycle events a product's currency grant
// fires on. A grant row is money, so the match is an explicit table
// rather than a string comparison — an unrecognised value must fail
// closed, never fall through to "grant it".

export type CurrencyGrantTrigger = "PURCHASE" | "RENEWAL" | "BOTH";

/** The events that can trigger a grant. `BOTH` is a stored value, never
 *  an event — an event is always one or the other. */
export type GrantEventTrigger = "PURCHASE" | "RENEWAL";

const GRANT_TRIGGER_MATCHES: Record<
  CurrencyGrantTrigger,
  readonly GrantEventTrigger[]
> = {
  PURCHASE: ["PURCHASE"],
  RENEWAL: ["RENEWAL"],
  BOTH: ["PURCHASE", "RENEWAL"],
};

export function grantTriggerMatches(
  grantOn: CurrencyGrantTrigger,
  trigger: GrantEventTrigger,
): boolean {
  return GRANT_TRIGGER_MATCHES[grantOn]?.includes(trigger) ?? false;
}

/**
 * The inverse lookup: which stored `grantOn` values fire on this event.
 * The repository uses this to build its SQL filter, so the matrix above is
 * the ONLY place the mapping is written down. Without it the repository
 * would carry a second hand-maintained copy that can drift silently.
 */
export function grantTriggersMatching(
  trigger: GrantEventTrigger,
): CurrencyGrantTrigger[] {
  return (Object.keys(GRANT_TRIGGER_MATCHES) as CurrencyGrantTrigger[]).filter(
    (grantOn) => grantTriggerMatches(grantOn, trigger),
  );
}
