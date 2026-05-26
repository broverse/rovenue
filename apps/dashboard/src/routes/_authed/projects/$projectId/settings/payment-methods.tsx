import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import {
  useStartAddCard,
  useSetDefaultPaymentMethod,
  useDetachPaymentMethod,
} from "../../../../../lib/hooks/useBillingMutations";
import { useBillingPaymentMethods } from "../../../../../lib/hooks/useBillingPaymentMethods";
import { PaymentMethodRow, UpgradeModal } from "../../../../../components/billing";
import { Button } from "../../../../../ui/button";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/payment-methods",
)({
  component: PaymentMethodsPage,
});

function PaymentMethodsPage() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/payment-methods",
  });
  const pms = useBillingPaymentMethods(projectId);
  const addCard = useStartAddCard(projectId);
  const setDefault = useSetDefaultPaymentMethod(projectId);
  const detach = useDetachPaymentMethod(projectId);
  const [setupSecret, setSetupSecret] = useState<{
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  if (pms.isLoading) return <div className="p-6">Loading…</div>;
  const rows = pms.data ?? [];

  return (
    <div className="flex flex-col gap-3 p-6">
      {rows.length === 0 && (
        <p className="text-sm text-rv-mute-500">
          No payment methods yet. Upgrade your project to add one.
        </p>
      )}
      {rows.map((pm) => (
        <PaymentMethodRow
          key={pm.id}
          brand={pm.brand.toUpperCase()}
          number={`${pm.brand} •••• ${pm.last4}`}
          meta={`Expires ${String(pm.expMonth).padStart(2, "0")}/${pm.expYear}`}
          isDefault={pm.isDefault}
          actions={
            <div className="flex gap-2">
              {!pm.isDefault && (
                <Button
                  variant="light"
                  onClick={() => setDefault.mutate(pm.id)}
                  disabled={setDefault.isPending}
                >
                  Set default
                </Button>
              )}
              <Button
                variant="light"
                onClick={() => detach.mutate(pm.id)}
                disabled={detach.isPending}
              >
                Remove
              </Button>
            </div>
          }
        />
      ))}

      <Button
        variant="flat"
        onClick={async () => {
          const res = await addCard.mutateAsync();
          setSetupSecret(res);
        }}
        disabled={addCard.isPending}
      >
        {addCard.isPending ? "Preparing…" : "Add card"}
      </Button>

      {setupSecret && (
        <UpgradeModal
          clientSecret={setupSecret.clientSecret}
          publishableKey={setupSecret.publishableKey}
          onClose={() => setSetupSecret(null)}
          onSuccess={() => {
            setSetupSecret(null);
            void pms.refetch();
          }}
        />
      )}
    </div>
  );
}
