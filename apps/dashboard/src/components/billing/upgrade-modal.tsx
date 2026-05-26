import { useEffect, useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Button } from "../../ui/button";

interface UpgradeModalProps {
  clientSecret: string;
  publishableKey: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function UpgradeModal(props: UpgradeModalProps) {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    setStripePromise(loadStripe(props.publishableKey));
  }, [props.publishableKey]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">Upgrade to Indie</h2>
        <p className="mt-1 text-sm text-rv-mute-500">
          $29 / month. Cancellable any time.
        </p>
        {stripePromise && (
          <Elements
            stripe={stripePromise}
            options={{ clientSecret: props.clientSecret }}
          >
            <InnerForm onClose={props.onClose} onSuccess={props.onSuccess} />
          </Elements>
        )}
      </div>
    </div>
  );
}

function InnerForm({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const result = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
    });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message ?? "Payment confirmation failed");
      return;
    }
    onSuccess();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <p className="text-sm text-rv-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="flat" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="solid-primary" type="submit" disabled={submitting}>
          {submitting ? "Confirming…" : "Confirm"}
        </Button>
      </div>
    </form>
  );
}
