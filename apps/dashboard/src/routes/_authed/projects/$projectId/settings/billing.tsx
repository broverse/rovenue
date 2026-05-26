import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useBillingSummary } from "../../../../../lib/hooks/useBillingSummary";
import { useStartUpgrade } from "../../../../../lib/hooks/useBillingMutations";
import { PlanCard, UpgradeModal } from "../../../../../components/billing";
import { Button } from "../../../../../ui/button";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/billing")({
  component: BillingPage,
});

function BillingPage() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/billing",
  });
  const summary = useBillingSummary(projectId);
  const upgrade = useStartUpgrade(projectId);
  const [setupSecret, setSetupSecret] = useState<{
    clientSecret: string;
    publishableKey: string;
  } | null>(null);

  if (summary.isLoading) return <div className="p-6">Loading…</div>;
  if (summary.isError || !summary.data) {
    return <div className="p-6">Failed to load billing</div>;
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
