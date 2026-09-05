import { useCallback, useEffect, useRef, useState } from "react";
import { useRovenue } from "./provider";

export interface EntitlementsState {
  /** null means "not known yet", never "this person has nothing". */
  entitlements: Record<string, unknown> | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Entitlements, served from cache first.
 *
 * The initial value is the SDK's last-known cache rather than null, because
 * the alternative is a first paint that shows the paywall to someone who has
 * already paid to remove it. The network result replaces it when it arrives.
 *
 * `null` and `{}` are deliberately different: `{}` is a real answer meaning
 * the subscriber has no entitlements, `null` means we have not found out.
 * Collapsing them makes an outage indistinguishable from an unsubscribed
 * user, and that difference decides whether an app locks someone out.
 */
export function useEntitlements(): EntitlementsState {
  const rovenue = useRovenue();
  const [entitlements, setEntitlements] = useState<Record<
    string,
    unknown
  > | null>(() => rovenue.getCachedEntitlements());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Survives unmount: setting state on an unmounted component is a leak, and
  // in StrictMode's double-mount it is also a race.
  const alive = useRef(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = await rovenue.getEntitlements();
      if (!alive.current) return;
      setEntitlements(next);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      // The cached value is left in place. Replacing it with null on a
      // transient failure would flash the paywall at a paying subscriber.
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (alive.current) setIsLoading(false);
    }
  }, [rovenue]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
    // `load` is stable for a given client, so this runs once per client and
    // not once per render — the failure that turns an SDK into a request
    // storm in production while looking fine locally.
  }, [load]);

  return { entitlements, isLoading, error, refresh: load };
}

export interface PlacementState {
  placement: unknown;
  isLoading: boolean;
  error: Error | null;
}

/**
 * A placement's served paywall.
 *
 * An unknown placement returns an empty envelope rather than a 404, so this
 * resolves with nothing to show instead of erroring — the caller renders
 * nothing, which is the behaviour a placement that has not been configured
 * yet should have.
 */
export function usePlacement(identifier: string): PlacementState {
  const rovenue = useRovenue();
  const [placement, setPlacement] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setIsLoading(true);
    rovenue
      .getPlacement(identifier)
      .then((value) => {
        if (!alive.current) return;
        setPlacement(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (alive.current) setIsLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [rovenue, identifier]);

  return { placement, isLoading, error };
}

export interface CheckoutState {
  /** Starts a checkout and redirects the browser to Stripe. */
  start: (input: {
    offeringId: string;
    packageIdentifier: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey?: string;
  }) => Promise<void>;
  isStarting: boolean;
  error: Error | null;
}

/**
 * Starts a Stripe Checkout and sends the browser to it.
 *
 * `isStarting` exists so a caller can disable the button. A second click
 * before the first session comes back would otherwise create a second
 * session — which Stripe's idempotency only prevents if the caller passes
 * the same key, and a caller that has not thought about it will not.
 */
export function useCheckout(): CheckoutState {
  const rovenue = useRovenue();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const start = useCallback<CheckoutState["start"]>(
    async (input) => {
      setIsStarting(true);
      setError(null);
      try {
        const session = await rovenue.checkout(input);
        // Assigning rather than replacing: the buyer must be able to come
        // back to the page they left with the browser's own back button.
        globalThis.location.assign(session.url);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsStarting(false);
      }
    },
    [rovenue],
  );

  return { start, isStarting, error };
}
