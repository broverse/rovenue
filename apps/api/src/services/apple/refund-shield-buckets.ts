export interface RefundShieldSignals {
  customerConsented: boolean;
  appAccountToken: string | null;
  firstSeenAt: Date;
  now: Date;
  purchaseStartedAt: Date;
  purchaseEndsAt: Date;
  wasInTrial: boolean;
  hasActiveEntitlement: boolean;
  lifetimeSessionMs: number;
  lifetimeDollarsPurchasedCents: number;
  lifetimeDollarsRefundedCents: number;
}

export interface ConsumptionRequest {
  customerConsented: boolean;
  consumptionStatus: 0 | 1 | 2 | 3;
  platform: 0 | 1 | 2;
  sampleContentProvided: boolean;
  deliveryStatus: 0 | 1 | 2 | 3 | 4 | 5;
  appAccountToken?: string;
  accountTenure: 0 | 1 | 2 | 3 | 4 | 5;
  playTime: 0 | 1 | 2 | 3 | 4 | 5;
  lifetimeDollarsRefunded: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  lifetimeDollarsPurchased: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  userStatus: 0 | 1 | 2 | 3 | 4;
  refundPreference: 0 | 1 | 2 | 3;
}

function consumptionStatusBucket(now: Date, started: Date, ends: Date): 0 | 1 | 2 | 3 {
  const total = ends.getTime() - started.getTime();
  if (total <= 0) return 3;
  const elapsed = now.getTime() - started.getTime();
  const pct = elapsed / total;
  if (pct > 0.9) return 3;
  if (pct >= 0.25) return 2;
  return 1;
}

function accountTenureBucket(now: Date, firstSeen: Date): 0 | 1 | 2 | 3 | 4 | 5 {
  const days = (now.getTime() - firstSeen.getTime()) / 86_400_000;
  if (days < 3) return 1;
  if (days < 10) return 2;
  if (days < 30) return 3;
  if (days < 90) return 4;
  return 5;
}

function playTimeBucket(ms: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (ms <= 0) return 0;
  const min = ms / 60_000;
  if (min < 5) return 1;
  if (min < 60) return 2;
  if (min < 360) return 3;
  if (min < 960) return 4;
  return 5;
}

function dollarsTier(cents: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (cents <= 0) return 0;
  if (cents < 5_000) return 1;
  if (cents < 10_000) return 2;
  if (cents < 50_000) return 3;
  if (cents < 100_000) return 4;
  if (cents < 200_000) return 5;
  if (cents < 300_000) return 6;
  return 7;
}

export function mapToConsumptionRequest(s: RefundShieldSignals): ConsumptionRequest {
  const out: ConsumptionRequest = {
    customerConsented: s.customerConsented,
    consumptionStatus: consumptionStatusBucket(s.now, s.purchaseStartedAt, s.purchaseEndsAt),
    platform: 1,
    sampleContentProvided: s.wasInTrial,
    deliveryStatus: 0,
    accountTenure: accountTenureBucket(s.now, s.firstSeenAt),
    playTime: playTimeBucket(s.lifetimeSessionMs),
    lifetimeDollarsPurchased: dollarsTier(s.lifetimeDollarsPurchasedCents),
    lifetimeDollarsRefunded: dollarsTier(s.lifetimeDollarsRefundedCents),
    userStatus: s.hasActiveEntitlement ? 1 : 0,
    refundPreference: 2,
  };
  if (s.appAccountToken) out.appAccountToken = s.appAccountToken;
  return out;
}
