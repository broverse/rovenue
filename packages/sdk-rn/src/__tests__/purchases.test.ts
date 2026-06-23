import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/native', () => ({
  getNative: () => ({
    getOfferings: async () => ({
      current: 'default',
      offerings: [{
        identifier: 'default', isDefault: true,
        packages: [{
          identifier: '$rov_monthly',
          product: {
            id: 'premium', type: 'subscription', productCategory: 'subscription',
            displayName: 'Premium', description: 'Pro', priceString: '$9.99', price: 9.99,
            currencyCode: 'USD',
            subscriptionPeriod: { value: 1, unit: 'month', iso8601: 'P1M' },
            subscriptionGroupIdentifier: null, isFamilyShareable: false,
            introPrice: { price: 0, priceString: 'Free', currencyCode: 'USD',
              period: { value: 1, unit: 'week', iso8601: 'P1W' }, cycles: 1, paymentMode: 'freeTrial' },
            discounts: [], isEligibleForIntroOffer: true, subscriptionOptions: null, defaultOption: null,
            pricePerWeek: null, pricePerMonth: 9.99, pricePerYear: null,
            pricePerWeekString: null, pricePerMonthString: '$9.99', pricePerYearString: null,
          },
        }],
      }],
    }),
  }),
}));

import { getOfferings } from '../api/purchases';

describe('getOfferings', () => {
  it('maps enriched DTO and derives packageType', async () => {
    const o = await getOfferings();
    const pkg = o.current!.packages[0];
    expect(pkg.packageType).toBe('monthly');
    expect(pkg.product.introPrice?.paymentMode).toBe('freeTrial');
    expect(pkg.product.subscriptionPeriod?.iso8601).toBe('P1M');
    expect(o.all['default'].isDefault).toBe(true);
  });
});
