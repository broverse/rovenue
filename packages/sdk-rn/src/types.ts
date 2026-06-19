// Public types — these are intentionally plain object shapes so they
// serialise across the Nitro bridge without custom converters.

export type User = {
  rovenueId: string;
  appUserId: string | null;
};

export type Entitlement = {
  id: string;
  active: boolean;
  expiresAt: string | null;  // ISO-8601 or null
  productId: string | null;
};

export type ProductType = 'subscription' | 'consumable' | 'non_consumable';

export type StoreProduct = {
  id: string;
  type: ProductType;
  displayName: string;
  priceString: string | null;
  price: number | null;
  currencyCode: string | null;
};

export type Package = {
  identifier: string;
  product: StoreProduct;
};

export type Offering = {
  identifier: string;
  isDefault: boolean;
  packages: Package[];
};

export type Offerings = {
  current: Offering | null;
  all: Record<string, Offering>;
};

export type PurchaseResult = {
  entitlements: Entitlement[];
  creditBalance: number;
  productId: string;
  storeTransactionId: string;
};

export type ChangeEvent =
  | 'ENTITLEMENTS_CHANGED'
  | 'IDENTITY_CHANGED'
  | 'CREDIT_BALANCE_CHANGED'
  | 'REMOTE_CONFIG_CHANGED';

// Remote Config — feature flags + experiment assignments, evaluated
// server-side for the current subscriber and cached locally so reads are
// synchronous and survive offline.

export type ExperimentAssignment = {
  experimentId: string;
  key: string;
  variantId: string;
  variantName: string;
  /** Variant payload (already JSON-parsed). */
  value: unknown;
};

export type RemoteConfig = {
  /** Flag key → evaluated value (boolean / number / string / object). */
  flags: Record<string, unknown>;
  /** Experiment key → the subscriber's assignment. */
  experiments: Record<string, ExperimentAssignment>;
};
