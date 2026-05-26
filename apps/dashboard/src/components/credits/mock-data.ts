import type {
  CreditBurner,
  CreditPack,
  LedgerEntry,
  VolumePoint,
} from "./types";

export const WALLET_STATS = {
  outstandingValue: "14.82",
  outstandingUnit: "M cr",
  outstandingDescriptionKey: "credits.kpi.outstandingDescription",
  outstandingDescriptionVars: { wallets: "89,142" },
  issuedValue: "2.41",
  issuedUnit: "M",
  issuedDescriptionKey: "credits.kpi.issuedDelta",
  burnedValue: "1.92",
  burnedUnit: "M",
  burnedDescriptionKey: "credits.kpi.burnedRate",
  burnedDescriptionVars: { rate: "79.6%" },
  revenueValue: "$182.4",
  revenueUnit: "k",
  revenueDescriptionKey: "credits.kpi.revenueAvg",
  revenueDescriptionVars: { avg: "$0.076" },
  breakageValue: "$24.1",
  breakageUnit: "k",
  breakageDescriptionKey: "credits.kpi.breakageDescription",
} as const;

export const PACKS: ReadonlyArray<CreditPack> = [
  { id: "credits_100", name: "100 credits", price: 4.99, sold: 8421, share: 38, color: "var(--color-rv-accent-500)" },
  { id: "credits_500", name: "500 credits", price: 19.99, sold: 6210, share: 28, color: "var(--color-rv-violet)" },
  { id: "credits_1500", name: "1,500 credits", price: 49.99, sold: 4128, share: 19, color: "var(--color-rv-success)" },
  { id: "credits_5000", name: "5,000 credits", price: 149.99, sold: 2104, share: 10, color: "var(--color-rv-warning)" },
  { id: "credits_starter", name: "Starter (free)", price: 0, sold: 1102, share: 5, color: "var(--color-rv-mute-500)" },
];

export const BURNERS: ReadonlyArray<CreditBurner> = [
  { id: "image_gen_4k", feature: "image_gen.4k", description: "4K image generation", cost: "12 / image", burnedM: 8.4, pct: 41 },
  { id: "image_gen_2k", feature: "image_gen.2k", description: "2K image generation", cost: "4 / image", burnedM: 5.1, pct: 25 },
  { id: "video_gen_short", feature: "video_gen.short", description: "Short video (≤6s)", cost: "40 / clip", burnedM: 3.2, pct: 16 },
  { id: "voice_clone", feature: "voice.clone", description: "Voice cloning", cost: "60 / model", burnedM: 2.1, pct: 10 },
  { id: "background_remove", feature: "image.bg_remove", description: "Background removal", cost: "1 / image", burnedM: 1.6, pct: 8 },
];

export const LEDGER_ENTRIES: ReadonlyArray<LedgerEntry> = [
  { id: "cr_2x9k", ts: "just now", user: "Aiden Kowalski", uid: "usr_9zk2", avatarColor: "oklch(0.65 0.15 30)", source: "consume", delta: -12, balance: 388, note: "image_gen.4k · req_a82f" },
  { id: "cr_2x9j", ts: "12s ago", user: "Sara Lin", uid: "usr_4lt7", avatarColor: "oklch(0.65 0.15 200)", source: "purchase", delta: 500, balance: 712, note: "500 credits pack", extId: "in_1NpQ…7G" },
  { id: "cr_2x9i", ts: "38s ago", user: "Marco Bianchi", uid: "usr_2bm8", avatarColor: "oklch(0.65 0.15 130)", source: "consume", delta: -4, balance: 196, note: "image_gen.2k · req_b18c" },
  { id: "cr_2x9h", ts: "1m ago", user: "Jin Park", uid: "usr_7jp1", avatarColor: "oklch(0.65 0.15 280)", source: "bonus", delta: 25, balance: 280, note: "streak_day_7" },
  { id: "cr_2x9g", ts: "2m ago", user: "Noor Hassan", uid: "usr_3nh4", avatarColor: "oklch(0.65 0.15 40)", source: "consume", delta: -40, balance: 460, note: "video_gen.short · req_c4a1" },
  { id: "cr_2x9f", ts: "3m ago", user: "Elena Petrova", uid: "usr_8ep2", avatarColor: "oklch(0.65 0.15 320)", source: "purchase", delta: 1500, balance: 2104, note: "1,500 credits pack", extId: "in_1NpQ…2K" },
  { id: "cr_2x9e", ts: "4m ago", user: "Riley Chen", uid: "usr_5rc9", avatarColor: "oklch(0.65 0.15 240)", source: "refund", delta: 12, balance: 124, note: "image_gen.4k failed · auto-refund", extId: "rf_98a2" },
  { id: "cr_2x9d", ts: "5m ago", user: "Tomás García", uid: "usr_1tg5", avatarColor: "oklch(0.65 0.15 100)", source: "consume", delta: -1, balance: 73, note: "image.bg_remove · req_d92e" },
  { id: "cr_2x9c", ts: "7m ago", user: "Aria Singh", uid: "usr_6as3", avatarColor: "oklch(0.65 0.15 350)", source: "expire", delta: -50, balance: 0, note: "90-day promo expiry" },
  { id: "cr_2x9b", ts: "8m ago", user: "Hugo Sjöberg", uid: "usr_4hs7", avatarColor: "oklch(0.65 0.15 180)", source: "consume", delta: -60, balance: 940, note: "voice.clone · req_e4c8" },
  { id: "cr_2x9a", ts: "11m ago", user: "Mei Tanaka", uid: "usr_2mt6", avatarColor: "oklch(0.65 0.15 60)", source: "adjust", delta: 100, balance: 320, note: "support comp · #SUP-2841" },
  { id: "cr_2x99", ts: "13m ago", user: "Olivia Wright", uid: "usr_9ow0", avatarColor: "oklch(0.65 0.15 210)", source: "purchase", delta: 100, balance: 102, note: "100 credits pack", extId: "in_1NpQ…9X" },
  { id: "cr_2x98", ts: "15m ago", user: "Faisal Ahmed", uid: "usr_3fa2", avatarColor: "oklch(0.65 0.15 150)", source: "consume", delta: -12, balance: 218, note: "image_gen.4k · req_f1c7" },
  { id: "cr_2x97", ts: "18m ago", user: "Léa Dubois", uid: "usr_5ld8", avatarColor: "oklch(0.65 0.15 290)", source: "consume", delta: -4, balance: 56, note: "image_gen.2k · req_g2d3" },
  { id: "cr_2x96", ts: "22m ago", user: "Diego Morales", uid: "usr_7dm1", avatarColor: "oklch(0.65 0.15 20)", source: "purchase", delta: 5000, balance: 5142, note: "5,000 credits pack", extId: "in_1NpQ…4Y" },
];

const VOLUME_DAYS = 28;

export const VOLUME_SERIES: ReadonlyArray<VolumePoint> = (() => {
  const arr: VolumePoint[] = [];
  for (let i = 0; i < VOLUME_DAYS; i++) {
    // Deterministic pseudo-random so SSR / build matches the design's vibe.
    const noiseI = ((Math.sin(i * 12.9898) + 1) / 2) * 4000;
    const noiseB = ((Math.sin(i * 78.233) + 1) / 2) * 3000;
    const issued = Math.round(18000 + Math.sin(i / 4) * 3000 + noiseI + i * 200);
    const burned = Math.round(12000 + Math.cos(i / 5) * 2000 + noiseB + i * 280);
    arr.push({ d: i, issued, burned, net: issued - burned });
  }
  return arr;
})();

export const VOLUME_DAY_COUNT = VOLUME_DAYS;
