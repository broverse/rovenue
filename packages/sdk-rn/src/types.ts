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
  | 'CREDIT_BALANCE_CHANGED';
