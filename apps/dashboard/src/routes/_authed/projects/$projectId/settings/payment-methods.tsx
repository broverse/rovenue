import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";
import {
  useStartAddCard,
  useSetDefaultPaymentMethod,
  useDetachPaymentMethod,
} from "../../../../../lib/hooks/useBillingMutations";
import { useBillingPaymentMethods } from "../../../../../lib/hooks/useBillingPaymentMethods";
import {
  EmptyStateCard,
  LoadingState,
} from "../../../../../components/dashboard";
import { PaymentMethodRow, UpgradeModal } from "../../../../../components/billing";
import { Button } from "../../../../../ui/button";
import { billingEnabled } from "../../../../../lib/host-mode";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/payment-methods",
)({
  component: PaymentMethodsPage,
});

function PaymentMethodsPage() {
  if (!billingEnabled) {
    return (
      <div className="p-6 text-[13px] text-rv-mute-500">
        Billing is managed by your administrator on self-hosted instances.
      </div>
    );
  }
  return <PaymentMethodsPageCloud />;
}

function PaymentMethodsPageCloud() {
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

  if (pms.isLoading) return <LoadingState />;
  const rows = pms.data ?? [];

  const addCardButton = (
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
  );

  const modal = setupSecret && (
    <UpgradeModal
      clientSecret={setupSecret.clientSecret}
      publishableKey={setupSecret.publishableKey}
      onClose={() => setSetupSecret(null)}
      onSuccess={() => {
        setSetupSecret(null);
        void pms.refetch();
      }}
    />
  );

  if (rows.length === 0) {
    return (
      <div className="p-6">
        <EmptyStateCard
          icon={CreditCard}
          iconSize={20}
          title="No payment methods yet"
          description="Add a card to keep your subscription active and pay invoices automatically."
          actions={addCardButton}
        />
        {modal}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-6">
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

      {addCardButton}
      {modal}
    </div>
  );
}
