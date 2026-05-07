import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowUpDown, BookOpen, Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import {
  CreditFlow,
  LEDGER_ENTRIES,
  LedgerTable,
  LiabilityGauge,
  PackageMix,
  QuickActions,
  TopBurners,
  VolumeChart,
  WALLET_STATS,
  WalletStat,
  type LedgerEntry,
  type LedgerScope,
} from "../../../../components/credits";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/credits")({
  component: CreditsRoute,
});

function CreditsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/credits",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <CreditsPage />;
}

function CreditsPage() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<LedgerScope>("all");

  const visible = useMemo<ReadonlyArray<LedgerEntry>>(() => {
    if (scope === "all") return LEDGER_ENTRIES;
    return LEDGER_ENTRIES.filter((entry) => entry.source === scope);
  }, [scope]);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("credits.title")}
          </h1>
          <p className="mt-1 max-w-3xl text-[13px] text-rv-mute-500">
            {t("credits.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("credits.actions.schema")}
          </Button>
          <Button variant="flat" size="sm">
            <ArrowUpDown size={13} />
            {t("credits.actions.exportLedger")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("credits.actions.grantCredits")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid gap-3 grid-cols-2 max-[760px]:grid-cols-2 max-[1180px]:grid-cols-3 min-[1181px]:grid-cols-5">
        <WalletStat
          accent
          label={t("credits.kpi.outstandingBalance")}
          value={WALLET_STATS.outstandingValue}
          unit={WALLET_STATS.outstandingUnit}
          description={t(
            WALLET_STATS.outstandingDescriptionKey,
            WALLET_STATS.outstandingDescriptionVars,
          )}
          sparkSeed={1}
          sparkColor="var(--color-rv-accent-400)"
        />
        <WalletStat
          label={t("credits.kpi.issued28d")}
          value={WALLET_STATS.issuedValue}
          unit={WALLET_STATS.issuedUnit}
          description={t(WALLET_STATS.issuedDescriptionKey)}
          descriptionTone="success"
          sparkSeed={3}
          sparkColor="var(--color-rv-success)"
        />
        <WalletStat
          label={t("credits.kpi.burned28d")}
          value={WALLET_STATS.burnedValue}
          unit={WALLET_STATS.burnedUnit}
          description={t(
            WALLET_STATS.burnedDescriptionKey,
            WALLET_STATS.burnedDescriptionVars,
          )}
          sparkSeed={5}
          sparkColor="var(--color-rv-violet)"
        />
        <WalletStat
          label={t("credits.kpi.revenue28d")}
          value={WALLET_STATS.revenueValue}
          unit={WALLET_STATS.revenueUnit}
          description={t(
            WALLET_STATS.revenueDescriptionKey,
            WALLET_STATS.revenueDescriptionVars,
          )}
          sparkSeed={7}
          sparkColor="var(--color-rv-warning)"
        />
        <WalletStat
          label={t("credits.kpi.breakage")}
          value={WALLET_STATS.breakageValue}
          unit={WALLET_STATS.breakageUnit}
          description={t(WALLET_STATS.breakageDescriptionKey)}
          sparkSeed={9}
          sparkColor="var(--color-rv-mute-600)"
        />
      </div>

      <CreditFlow />
      <VolumeChart />

      <div className="grid items-start gap-4 max-[1280px]:grid-cols-1 grid-cols-[minmax(0,1fr)_380px]">
        <LedgerTable entries={visible} scope={scope} onScopeChange={setScope} />
        <div className="flex flex-col gap-4">
          <LiabilityGauge />
          <PackageMix />
          <TopBurners />
          <QuickActions />
        </div>
      </div>
    </>
  );
}
