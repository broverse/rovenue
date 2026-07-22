// =============================================================
// On-page payment for a funnel paywall.
//
// The visitor NEVER leaves this page. Everything below is built
// around that one guarantee:
//
//   • the intent is created from the browser against the app
//     owner's CONNECTED Stripe account (`stripeAccount` on the
//     Elements instance), so the charge lands on their books;
//   • Express Checkout (Apple Pay / Google Pay) and the card form
//     are mounted side by side on the same Elements instance and
//     confirm through the same code path;
//   • confirmation uses `redirect: "if_required"`, which is what
//     keeps a 3DS-free card — and every wallet — on the page.
//     Only a payment method that genuinely cannot complete inline
//     would redirect, and none of the methods we mount can.
//
// After Stripe says the money moved we still have to ask OUR
// server to settle the session and mint the claim token: the
// browser's word is not evidence, and the token is the thing the
// app needs to attach the purchase to a subscriber.
// =============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  ExpressCheckoutElement,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import {
  confirmFunnelPayment,
  createPaymentIntent,
  RunnerApiError,
  type FunnelPaymentIntentResponse,
} from "./runner-api";

/**
 * What the runner gets once the money has moved.
 *
 * `alreadyIssued` is a success, not a failure: the Connect webhook
 * completed this session before the browser got there and handed the
 * plaintext token to whoever asked first. Only the hash is stored, so
 * it cannot be handed out twice — but the buyer paid, and the runner
 * must say so. `token` is null in exactly that case.
 */
export interface FunnelPaymentOutcome {
  alreadyIssued: boolean;
  token: string | null;
  deepLinkUrl: string | null;
  universalLinkUrl: string | null;
}

export interface PaymentStepProps {
  sessionId: string;
  packageIdentifier: string;
  /**
   * Address the funnel already collected, if it has one. Absent means
   * we have to ask: the payment-intent endpoint requires an email (it
   * is what the Stripe receipt and the magic-link claim recovery are
   * addressed to), so there is nothing to create without it.
   */
  email?: string;
  /** Server-resolved price, shown on the pay button. Never computed here. */
  priceLabel?: string;
  onPaid: (outcome: FunnelPaymentOutcome) => void;
  onCancel: () => void;
  /**
   * Backoff between /confirm retries. Every entry is one extra attempt
   * on top of the first, so the default makes four attempts over ~7s.
   * Overridden in tests to keep them instant.
   */
  confirmRetryDelaysMs?: number[];
}

/**
 * ~7s of retries. A trial settles on a Stripe object that can be
 * briefly unreadable straight after the browser confirms the card, and
 * telling someone who just paid that their payment failed is far worse
 * than making them wait.
 */
const DEFAULT_CONFIRM_RETRY_DELAYS_MS = [500, 1_500, 5_000];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Settle the session, tolerating the window in which Stripe has taken
 * the money but our server cannot yet read it as settled.
 *
 * EVERY 409 is retried, deliberately. The API maps all 409s to the same
 * envelope code (`HTTP_ERROR`, see apps/api/src/middleware/error.ts) and
 * the "not settled yet" one — `Payment is not complete` — carries no
 * machine-readable code at all, only prose. Two of the three 409s this
 * endpoint can answer with are genuinely transient ("not complete",
 * "a payment attempt is already in flight"); the third ("No payment
 * started") is terminal, but matching English message text to tell them
 * apart would be worse than spending three extra requests on it.
 */
export async function settleFunnelPayment(
  sessionId: string,
  delaysMs: number[],
): Promise<FunnelPaymentOutcome> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) await sleep(delaysMs[attempt - 1] ?? 0);
    try {
      const res = await confirmFunnelPayment(sessionId);
      if (res.already_issued) {
        return {
          alreadyIssued: true,
          token: null,
          deepLinkUrl: null,
          universalLinkUrl: null,
        };
      }
      return {
        alreadyIssued: false,
        token: res.token,
        deepLinkUrl: res.deep_link_url,
        universalLinkUrl: res.universal_link_url,
      };
    } catch (err) {
      if (err instanceof RunnerApiError && err.status === 409) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Payment could not be confirmed");
}

export function PaymentStep({
  sessionId,
  packageIdentifier,
  email: collectedEmail,
  priceLabel,
  onPaid,
  onCancel,
  confirmRetryDelaysMs = DEFAULT_CONFIRM_RETRY_DELAYS_MS,
}: PaymentStepProps) {
  const [intent, setIntent] = useState<FunnelPaymentIntentResponse | null>(null);
  const [email, setEmail] = useState(collectedEmail ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One live intent per mount. Guards React 18 strict-mode's double
  // effect — a second POST would create a second Stripe object and
  // supersede the first one the server just handed us.
  const started = useRef(false);

  const start = useCallback(
    async (address: string) => {
      if (started.current) return;
      started.current = true;
      setCreating(true);
      setError(null);
      try {
        setIntent(
          await createPaymentIntent(sessionId, {
            package_identifier: packageIdentifier,
            email: address,
          }),
        );
      } catch (err) {
        // Releasing the latch is the point: a 503 or a mistyped address
        // has to be retryable without remounting the whole step.
        started.current = false;
        setError(messageOf(err));
      } finally {
        setCreating(false);
      }
    },
    [sessionId, packageIdentifier],
  );

  useEffect(() => {
    if (collectedEmail) void start(collectedEmail);
  }, [collectedEmail, start]);

  const stripePromise = useMemo(
    () =>
      intent
        ? loadStripe(intent.publishable_key, {
            stripeAccount: intent.stripe_account,
          })
        : null,
    [intent],
  );

  if (intent && stripePromise) {
    return (
      <StepShell onCancel={onCancel}>
        <Elements
          stripe={stripePromise}
          options={{ clientSecret: intent.client_secret }}
        >
          <PaymentForm
            sessionId={sessionId}
            mode={intent.mode}
            priceLabel={priceLabel}
            confirmRetryDelaysMs={confirmRetryDelaysMs}
            onPaid={onPaid}
          />
        </Elements>
      </StepShell>
    );
  }

  // No intent yet. Either we are waiting on one, or we still need the
  // address the endpoint refuses to create without.
  return (
    <StepShell onCancel={onCancel}>
      {collectedEmail ? (
        <p className="text-[13px] text-zinc-600">
          {creating ? "Preparing checkout…" : "Checkout unavailable"}
        </p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void start(email.trim());
          }}
        >
          <label
            className="text-[13px] font-medium text-zinc-900"
            htmlFor="funnel-payment-email"
          >
            Email address
          </label>
          <input
            id="funnel-payment-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-[14px] text-zinc-900 outline-none focus:border-zinc-900"
          />
          <p className="text-[12px] text-zinc-500">
            We send your receipt and your access link here.
          </p>
          <button
            type="submit"
            disabled={creating}
            className="mt-1 w-full rounded-lg bg-zinc-900 px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-60"
          >
            {creating ? "Preparing checkout…" : "Continue"}
          </button>
        </form>
      )}
      {error && <ErrorNote message={error} />}
    </StepShell>
  );
}

function PaymentForm({
  sessionId,
  mode,
  priceLabel,
  confirmRetryDelaysMs,
  onPaid,
}: {
  sessionId: string;
  mode: "payment" | "setup";
  priceLabel?: string;
  confirmRetryDelaysMs: number[];
  onPaid: (outcome: FunnelPaymentOutcome) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(async () => {
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setError(null);
    try {
      // `redirect: "if_required"` is the no-leaving-the-page guarantee.
      // A trial has nothing to charge yet — its client secret belongs to
      // a SetupIntent, and confirmPayment would reject it.
      const result =
        mode === "setup"
          ? await stripe.confirmSetup({ elements, redirect: "if_required" })
          : await stripe.confirmPayment({ elements, redirect: "if_required" });

      if (result.error) {
        // A decline, an invalid card, a failed 3DS. Stripe's own message
        // is the useful one; the buyer stays here and can try again.
        setError(result.error.message ?? "That payment could not be completed.");
        return;
      }

      onPaid(await settleFunnelPayment(sessionId, confirmRetryDelaysMs));
    } catch (err) {
      // Reached only once the retries are spent. Worded so it never
      // tells someone who paid that they did not.
      setError(
        `We're still confirming your payment. Don't pay again — refresh in a moment. (${messageOf(err)})`,
      );
    } finally {
      setBusy(false);
    }
  }, [stripe, elements, busy, mode, sessionId, confirmRetryDelaysMs, onPaid]);

  const payLabel =
    mode === "setup"
      ? "Start trial"
      : priceLabel
        ? `Pay ${priceLabel}`
        : "Pay now";

  return (
    <div className="flex flex-col gap-4">
      {/* Wallets first: Apple Pay / Google Pay are one tap and confirm
          through the very same handler as the card form below. */}
      <ExpressCheckoutElement onConfirm={() => void confirm()} />
      <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-zinc-500">
        <span className="h-px flex-1 bg-zinc-200" />
        or pay by card
        <span className="h-px flex-1 bg-zinc-200" />
      </div>
      <PaymentElement />
      <button
        type="button"
        disabled={busy || !stripe}
        onClick={() => void confirm()}
        className="w-full rounded-lg bg-zinc-900 px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-60"
      >
        {busy ? "Processing…" : payLabel}
      </button>
      {error && <ErrorNote message={error} />}
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700"
    >
      {message}
    </p>
  );
}

function StepShell({
  children,
  onCancel,
}: {
  children: React.ReactNode;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-white p-6">
      <div className="w-full max-w-[420px]">
        <button
          type="button"
          onClick={onCancel}
          className="mb-4 text-[13px] text-zinc-600 underline"
        >
          Back
        </button>
        {children}
      </div>
    </div>
  );
}
