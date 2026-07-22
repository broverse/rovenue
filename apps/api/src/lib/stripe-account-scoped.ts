import type Stripe from "stripe";

// =============================================================
// Account-scoped Stripe surface
// =============================================================
//
// The client Rovenue holds is the PLATFORM client. Acting on a
// customer's connected account means passing `{ stripeAccount }` as the
// request-options argument — and omitting it does NOT fail: the call
// quietly runs against Rovenue's own Stripe account instead. That is the
// worst failure shape there is, so it must not be a thing a caller can
// forget.
//
// This module is the answer: `withAccount()` hands back a narrow facade
// whose methods already carry the header. Callers never see the raw
// client, so there is no call site at which the header could be left off.
//
// It is deliberately an explicit allow-list rather than a Proxy over the
// whole SDK. A Proxy would have to guess which argument is `params` and
// which is `options` — Stripe's methods are variously
// `(params, options)`, `(id, options)` and `(id, params, options)` — and
// guessing wrong would merge the header into `params`, i.e. silently
// send the call to the platform account. That is precisely the bug this
// file exists to prevent, so adding a resource here is a deliberate,
// reviewable one-liner instead.

/**
 * Stripe request options a caller may still set per call. `stripeAccount`
 * is deliberately absent: it is owned by the facade and cannot be
 * overridden.
 */
export type ScopedRequestOptions = Omit<Stripe.RequestOptions, "stripeAccount">;

export interface AccountScopedStripe {
  readonly refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Refund>;
  };
  readonly prices: {
    retrieve(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Price>>;
  };
  readonly customers: {
    create(
      params: Stripe.CustomerCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Customer>>;
    update(
      id: string,
      params: Stripe.CustomerUpdateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Customer>>;
  };
  readonly paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
    retrieve(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
    cancel(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
  };
  readonly subscriptions: {
    update(
      id: string,
      params: Stripe.SubscriptionUpdateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Subscription>;
    create(
      params: Stripe.SubscriptionCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Subscription>>;
    /**
     * `params` is here for `expand`, which is a params field and not a
     * request option: the funnel cleanup path needs `latest_invoice`
     * inline to tell a trial nobody has paid for from one that has
     * already billed, and it must not cancel the second kind.
     */
    retrieve(
      id: string,
      params?: Stripe.SubscriptionRetrieveParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Subscription>>;
    cancel(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Subscription>>;
  };
  readonly invoices: {
    retrieve(
      id: string,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.Invoice>>;
  };
  readonly paymentMethodDomains: {
    create(
      params: Stripe.PaymentMethodDomainCreateParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentMethodDomain>>;
    list(
      params: Stripe.PaymentMethodDomainListParams,
      options?: ScopedRequestOptions,
    ): Promise<Stripe.Response<Stripe.ApiList<Stripe.PaymentMethodDomain>>>;
  };
}

/**
 * Bind a platform client to one connected account.
 *
 * Spread order is `{ ...options, ...bound }` on purpose — the account
 * header wins, so a caller cannot redirect the call by passing its own
 * `stripeAccount` (the type forbids it too, but the runtime order means
 * a cast cannot get around it either).
 */
export function withAccount(
  stripe: Stripe,
  accountId: string,
): AccountScopedStripe {
  const bound = { stripeAccount: accountId } as const;

  return {
    refunds: {
      create: (params, options) =>
        stripe.refunds.create(params, { ...options, ...bound }),
    },
    prices: {
      retrieve: (id, options) =>
        stripe.prices.retrieve(id, { ...options, ...bound }),
    },
    customers: {
      create: (params, options) =>
        stripe.customers.create(params, { ...options, ...bound }),
      update: (id, params, options) =>
        stripe.customers.update(id, params, { ...options, ...bound }),
    },
    paymentIntents: {
      create: (params, options) =>
        stripe.paymentIntents.create(params, { ...options, ...bound }),
      retrieve: (id, options) =>
        stripe.paymentIntents.retrieve(id, { ...options, ...bound }),
      cancel: (id, options) =>
        stripe.paymentIntents.cancel(id, { ...options, ...bound }),
    },
    subscriptions: {
      update: (id, params, options) =>
        stripe.subscriptions.update(id, params, { ...options, ...bound }),
      create: (params, options) =>
        stripe.subscriptions.create(params, { ...options, ...bound }),
      // Three-arg form: passing `params` as the second argument is what
      // keeps `expand` out of the request options, where Stripe would
      // ignore it, and keeps the account header in the options, where
      // omitting it would silently target the platform account.
      retrieve: (id, params, options) =>
        stripe.subscriptions.retrieve(id, params ?? {}, {
          ...options,
          ...bound,
        }),
      cancel: (id, options) =>
        stripe.subscriptions.cancel(id, { ...options, ...bound }),
    },
    invoices: {
      retrieve: (id, options) =>
        stripe.invoices.retrieve(id, { ...options, ...bound }),
    },
    paymentMethodDomains: {
      create: (params, options) =>
        stripe.paymentMethodDomains.create(params, { ...options, ...bound }),
      list: (params, options) =>
        stripe.paymentMethodDomains.list(params, { ...options, ...bound }),
    },
  };
}
