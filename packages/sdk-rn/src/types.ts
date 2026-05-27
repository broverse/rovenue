// Public types — these are intentionally plain object shapes so they
// serialise across the Nitro bridge without custom converters.

export type User = {
  anonId: string;
  knownUserId: string | null;
};

export type Entitlement = {
  id: string;
  active: boolean;
  expiresAt: string | null;  // ISO-8601 or null
  productId: string | null;
};

export type ReceiptResult = {
  ok: boolean;
  entitlementsRefreshed: boolean;
  creditsRefreshed: boolean;
};

export type ChangeEvent =
  | 'ENTITLEMENTS_CHANGED'
  | 'IDENTITY_CHANGED'
  | 'CREDIT_BALANCE_CHANGED';
