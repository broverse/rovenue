import { decimalToMinorUnits } from "@rovenue/shared";
import { logger } from "../../lib/logger";
import { isoDurationToDays } from "../../lib/iso-duration";
import { getGoogleAccessToken } from "./google-auth";
import type { GoogleServiceAccountCredentials } from "./google-types";
import { gpGet } from "./google-play-catalog";

const log = logger.child("google-play-prices");

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

/** Reference region used to price base plans and detect free trial phases. */
export const GOOGLE_REFERENCE_REGION = "US";

interface Deps {
  fetchImpl?: typeof fetch;
  getToken?: typeof getGoogleAccessToken;
}

interface GoogleMoney {
  currencyCode: string;
  units?: string;
  nanos?: number;
}

interface GoogleRegionalConfig {
  regionCode: string;
  price?: GoogleMoney;
  free?: Record<string, unknown>;
}

interface GoogleBasePlan {
  basePlanId: string;
  autoRenewingBasePlanType?: { billingPeriodDuration?: string };
  prepaidBasePlanType?: { billingPeriodDuration?: string };
  regionalConfigs?: GoogleRegionalConfig[];
  otherRegionsConfig?: GoogleMoney;
}

interface GoogleSubscription {
  productId: string;
  basePlans?: GoogleBasePlan[];
}

interface GoogleOfferPhase {
  duration: string;
  regionalConfigs?: GoogleRegionalConfig[];
}

interface GoogleSubscriptionOffer {
  phases?: GoogleOfferPhase[];
}

export interface GooglePlanPrice {
  productId: string;
  basePlanId: string;
  /** ISO-8601 billingPeriodDuration, e.g. "P1M". */
  period: string | null;
  amountMinor: number;
  /** Uppercase ISO-4217 currency code. */
  currency: string;
  trialDays: number | null;
}

function moneyToDecimal(money: GoogleMoney): number {
  return Number(money.units ?? 0) + (money.nanos ?? 0) / 1_000_000_000;
}

function isFreePhase(phase: GoogleOfferPhase): boolean {
  const regional = phase.regionalConfigs?.find((rc) => rc.regionCode === GOOGLE_REFERENCE_REGION);
  if (!regional) return false;
  if (regional.free) return true;
  const price = regional.price;
  if (!price) return false;
  const units = Number(price.units ?? 0);
  const nanos = price.nanos ?? 0;
  return units === 0 && nanos === 0;
}

async function resolveTrialDays(
  packageName: string,
  productId: string,
  basePlanId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  const pkg = encodeURIComponent(packageName);
  const url = `${BASE}/${pkg}/subscriptions/${encodeURIComponent(productId)}/basePlans/${encodeURIComponent(basePlanId)}/offers`;
  let page: { subscriptionOffers?: GoogleSubscriptionOffer[] };
  try {
    page = (await gpGet(url, token, fetchImpl)) as { subscriptionOffers?: GoogleSubscriptionOffer[] };
  } catch (err) {
    log.warn("offers lookup failed, degrading to no trial", {
      packageName,
      productId,
      basePlanId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  for (const offer of page.subscriptionOffers ?? []) {
    for (const phase of offer.phases ?? []) {
      if (isFreePhase(phase)) return isoDurationToDays(phase.duration);
    }
  }
  return null;
}

export async function listGooglePlaySubscriptionPrices(
  input: {
    packageName: string;
    serviceAccount: GoogleServiceAccountCredentials;
    wanted: ReadonlyArray<{ productId: string; basePlanId: string }>;
  },
  deps: Deps = {},
): Promise<Map<string, GooglePlanPrice>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getToken = deps.getToken ?? getGoogleAccessToken;
  const token = await getToken(input.serviceAccount);
  const pkg = encodeURIComponent(input.packageName);

  const wantedProductIds = new Set(input.wanted.map((w) => w.productId));
  const subsByProductId = new Map<string, GoogleSubscription>();

  let subUrl: string | undefined = `${BASE}/${pkg}/subscriptions?pageSize=100`;
  while (subUrl) {
    const page = (await gpGet(subUrl, token, fetchImpl)) as {
      subscriptions?: GoogleSubscription[];
      nextPageToken?: string;
    };
    for (const sub of (page.subscriptions ?? []) as GoogleSubscription[]) {
      if (sub.productId && wantedProductIds.has(sub.productId)) {
        subsByProductId.set(sub.productId, sub);
      }
    }
    subUrl = page.nextPageToken
      ? `${BASE}/${pkg}/subscriptions?pageSize=100&pageToken=${encodeURIComponent(page.nextPageToken)}`
      : undefined;
  }

  const result = new Map<string, GooglePlanPrice>();

  for (const { productId, basePlanId } of input.wanted) {
    const sub = subsByProductId.get(productId);
    const basePlan = sub?.basePlans?.find((bp) => bp.basePlanId === basePlanId);
    if (!basePlan) continue;

    const period =
      basePlan.autoRenewingBasePlanType?.billingPeriodDuration ??
      basePlan.prepaidBasePlanType?.billingPeriodDuration ??
      null;

    const money =
      basePlan.regionalConfigs?.find((rc) => rc.regionCode === GOOGLE_REFERENCE_REGION)?.price ??
      basePlan.otherRegionsConfig;
    if (!money) continue;

    const amountMinor = decimalToMinorUnits(moneyToDecimal(money), money.currencyCode);
    const trialDays = await resolveTrialDays(input.packageName, productId, basePlanId, token, fetchImpl);

    result.set(`${productId}:${basePlanId}`, {
      productId,
      basePlanId,
      period,
      amountMinor,
      currency: money.currencyCode.toUpperCase(),
      trialDays,
    });
  }

  log.debug("listed google play subscription prices", {
    packageName: input.packageName,
    wanted: input.wanted.length,
    resolved: result.size,
  });

  return result;
}
