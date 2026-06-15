// Internal nested storage shape + public flat projection for subscriber
// attributes. The DB column stores SubscriberAttributes; every outward
// surface exposes AttributeMap. `updatedAt` is an ISO-8601 UTC string,
// stamped server-side only.

export type AttributeSource = "sdk" | "server" | "dashboard" | "legacy";

export interface AttributeEntry {
  value: string;
  /** ISO-8601 UTC, e.g. "2026-06-15T10:00:00.000Z". Server-set only. */
  updatedAt: string;
  source: AttributeSource;
}

/** Internal nested storage: what lives in subscribers.attributes jsonb. */
export type SubscriberAttributes = Record<string, AttributeEntry>;

/** Public flat projection: what every API surface returns/accepts. */
export type AttributeMap = Record<string, string>;

/** Request mutation map: value=string to set, value=null to delete. */
export type AttributeMutationMap = Record<string, string | null>;
