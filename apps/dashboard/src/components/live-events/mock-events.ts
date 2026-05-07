import { EVENT_TYPES } from "./event-types";
import type { EventPlatform, LiveEvent } from "./types";

const PRODUCTS = [
  { id: "prod_01HX2K9Z3F", sku: "premium_monthly", name: "Premium Monthly", price: 9.99 },
  { id: "prod_01HX2KA1M8", sku: "premium_yearly", name: "Premium Annual", price: 79.99 },
  { id: "prod_01HX2KB4P2", sku: "pro_monthly", name: "Pro Monthly", price: 4.99 },
  { id: "prod_01HX2KC7Q9", sku: "pro_yearly", name: "Pro Annual", price: 39.99 },
  { id: "prod_01HX2KD2R1", sku: "lifetime_unlock", name: "Lifetime", price: 149.0 },
] as const;

const PLATFORMS: ReadonlyArray<EventPlatform> = ["ios", "android"];
const COUNTRIES = ["US", "TR", "DE", "JP", "GB", "BR", "IN", "MX", "FR", "ES"] as const;
const STORES = { ios: "app_store", android: "play_store" } as const;

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz0123456789";
const HEX_ALPHABET = "abcdef0123456789";
const pick = <T>(arr: ReadonlyArray<T>): T => arr[Math.floor(Math.random() * arr.length)]!;
const randId = (prefix: string, len: number, alphabet: string): string => {
  let out = prefix;
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

const PRICED_TYPES = new Set(["new_subscription", "renewal", "trial_converted"]);

export const generateLiveEvent = (overrides: Partial<LiveEvent> = {}): LiveEvent => {
  const typeMeta = pick(EVENT_TYPES);
  const product = pick(PRODUCTS);
  const platform = pick(PLATFORMS);
  const country = pick(COUNTRIES);

  let amount: number | null = null;
  if (PRICED_TYPES.has(typeMeta.key)) amount = product.price;
  else if (typeMeta.key === "refund") amount = -product.price;

  return {
    id: randId("evt_", 16, ID_ALPHABET),
    type: typeMeta.key,
    typeMeta,
    user: randId("user_", 10, HEX_ALPHABET),
    product: product.name,
    productId: product.id,
    productSku: product.sku,
    amount,
    currency: "USD",
    platform,
    country,
    store: STORES[platform],
    txnId: randId("txn_", 14, HEX_ALPHABET),
    receivedAt: new Date(),
    environment: "production",
    sdkVersion: platform === "ios" ? "4.12.0" : "4.11.3",
    appVersion: "2.8.1",
    ...overrides,
  };
};

export const seedLiveEvents = (n = 40): LiveEvent[] => {
  const out: LiveEvent[] = [];
  let ago = 2;
  for (let i = 0; i < n; i++) {
    const event = generateLiveEvent();
    event.receivedAt = new Date(Date.now() - ago * 1000);
    ago += Math.floor(3 + Math.random() * 25);
    out.push(event);
  }
  return out;
};
