import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { useBillingSummary } from "../../../../../lib/hooks/useBillingSummary";
import { useStartUpgrade } from "../../../../../lib/hooks/useBillingMutations";
import {
  EmptyStateCard,
  LoadingState,
} from "../../../../../components/dashboard";
import { PlanCard, UpgradeModal } from "../../../../../components/billing";
import { Button } from "../../../../../ui/button";
import { billingEnabled } from "../../../../../lib/host-mode";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/billing")({
  component: BillingPage,
});

function BillingPage() {
  if (!billingEnabled) {
    return (
      <div className="p-6 text-[13px] text-rv-mute-500">
        Billing is managed by your administrator on self-hosted instances.
      </div>
    );
  }
  return <BillingPageCloud />;
}

function BillingPageCloud() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/billing",
  });
  const summary = useBillingSummary(projectId);
  const upgrade = useStartUpgrade(projectId);
  const [setupSecret, setSetupSecret] = useState<{
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  if (summary.isLoading) return <LoadingState />;
  if (summary.isError || !summary.data) {
    return (
      <div className="p-6">
        <EmptyStateCard
          icon={AlertCircle}
          iconSize={20}
          title="Couldn't load billing"
          description="Something went wrong fetching your billing details. Try again in a moment."
          actions={
            <Button variant="flat" onClick={() => void summary.refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  const s = summary.data;

  return (
    <div className="flex flex-col gap-6 p-6">
      <PlanCard
        eyebrow="Plan"
        name={tierLabel(s.tier)}
        description={
          s.state === "free"
            ? "Free tier — upgrade to unlock paid features."
            : `${s.cycle === "monthly" ? "Monthly" : "Annual"} cycle.`
        }
        stats={
          s.currentPeriodEnd
            ? [
                {
                  label: "Next bill",
                  value: new Date(s.currentPeriodEnd).toLocaleDateString(),
                  mono: true,
                },
              ]
            : []
        }
        actions={
          s.state === "free" ? (
            <Button
              variant="solid-primary"
              disabled={upgrade.isPending}
              onClick={async () => {
                const res = await upgrade.mutateAsync();
                setSetupSecret(res);
              }}
            >
              {upgrade.isPending ? "Preparing…" : "Upgrade to Indie ($29 / mo)"}
            </Button>
          ) : null
        }
      />

      {setupSecret && (
        <UpgradeModal
          clientSecret={setupSecret.clientSecret}
          publishableKey={setupSecret.publishableKey}
          onClose={() => setSetupSecret(null)}
          onSuccess={() => {
            setSetupSecret(null);
            void summary.refetch();
          }}
        />
      )}
    </div>
  );
}

function tierLabel(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
