import { describe, it, expect } from 'vitest';
import type { StoreProduct, Period, IntroPrice } from '../types';

describe('enriched StoreProduct type', () => {
  it('constructs with new fields', () => {
    const period: Period = { value: 1, unit: 'month', iso8601: 'P1M' };
    const intro: IntroPrice = { price: 0, priceString: 'Free', currencyCode: 'USD', period, cycles: 1, paymentMode: 'freeTrial' };
    const p: StoreProduct = {
      id: 'p1', type: 'subscription', productCategory: 'subscription', displayName: 'Premium',
      description: 'Pro', priceString: '$9.99', price: 9.99, currencyCode: 'USD',
      subscriptionPeriod: period, subscriptionGroupIdentifier: null, isFamilyShareable: false,
      introPrice: intro, discounts: [], isEligibleForIntroOffer: true,
      subscriptionOptions: null, defaultOption: null,
      pricePerWeek: null, pricePerMonth: 9.99, pricePerYear: null,
      pricePerWeekString: null, pricePerMonthString: '$9.99', pricePerYearString: null,
    };
    expect(p.introPrice?.paymentMode).toBe('freeTrial');
    expect(p.subscriptionPeriod?.iso8601).toBe('P1M');
  });
});
