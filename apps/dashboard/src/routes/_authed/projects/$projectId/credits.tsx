import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import {
  CreditFlow,
  LedgerTable,
  LiabilityGauge,
  PackageMix,
  TopBurners,
  VolumeChart,
  WalletStat,
  type CreditBurner,
  type CreditPack,
  type CreditSource,
  type LedgerEntry,
  type LedgerScope,
  type VolumePoint,
} from "../../../../components/credits";
import { GrantCreditsModal } from "../../../../components/credits/grant-credits-modal";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectCreditsRollup } from "../../../../lib/hooks/useProjectCredits";
import type {
  CreditLedgerType,
  CreditsLedgerRow,
  CreditsPackageRow,
  CreditsTopBurnerRow,
  CreditsVolumePoint,
} from "@rovenue/shared";

export const Route = createFileRoute("/_authed/projects/$projectId/credits")({
  component: CreditsRoute,
});

function CreditsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/credits",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <CreditsPage projectId={projectId} />;
}

// =============================================================
// Wire → UI adapters
// =============================================================

const LEDGER_TYPE_TO_SOURCE: Record<CreditLedgerType, CreditSource> = {
  PURCHASE: "purchase",
  BONUS: "bonus",
  SPEND: "consume",
  REFUND: "refund",
  EXPIRE: "expire",
  TRANSFER_IN: "adjust",
  TRANSFER_OUT: "adjust",
};

const AVATAR_PALETTE: ReadonlyArray<string> = [
  "#3B82F6",
  "#8B5CF6",
  "#10B981",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#F97316",
  "#84CC16",
];

function avatarColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]!;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function toUiLedgerEntry(row: CreditsLedgerRow): LedgerEntry {
  return {
    id: row.id,
    ts: TIME_FMT.format(new Date(row.createdAt)),
    user: shortId(row.subscriberId),
    uid: row.subscriberId,
    avatarColor: avatarColorFor(row.subscriberId),
    source: LEDGER_TYPE_TO_SOURCE[row.type] ?? "consume",
    delta: row.amount,
    balance: row.balance,
    note:
      row.description ??
      [row.referenceType, row.referenceId].filter(Boolean).join(" · ") ??
      "",
    extId: row.referenceId ?? undefined,
  };
}

const PACK_PALETTE: ReadonlyArray<string> = [
  "var(--color-rv-accent-500)",
  "var(--color-rv-success)",
  "var(--color-rv-violet)",
  "var(--color-rv-warning)",
  "var(--color-rv-cyan)",
  "var(--color-rv-mute-600)",
];

function toUiPacks(rows: ReadonlyArray<CreditsPackageRow>): ReadonlyArray<CreditPack> {
  return rows.map((row, i) => {
    const rev = Number(row.revenueUsd);
    return {
      id: row.productId,
      name: row.displayName ?? row.identifier ?? row.productId,
      price: row.sold > 0 ? Math.round((rev / row.sold) * 100) / 100 : 0,
      sold: row.sold,
      share: Math.round(row.pct),
      color: PACK_PALETTE[i % PACK_PALETTE.length]!,
    };
  });
}

const BURNER_LABEL: Record<string, string> = {
  other: "Other",
  purchase: "Top-ups",
  consume: "Consumption",
};

function toUiBurners(rows: ReadonlyArray<CreditsTopBurnerRow>): ReadonlyArray<CreditBurner> {
  return rows.map((row) => ({
    id: row.key,
    feature: BURNER_LABEL[row.key] ?? row.key,
    description: "Credits debited",
    cost: `${row.pct.toFixed(1)}% share`,
    burnedM: Math.round((row.burned / 1_000_000) * 10) / 10,
    pct: Math.round(row.pct),
  }));
}

function toUiVolume(points: ReadonlyArray<CreditsVolumePoint>): ReadonlyArray<VolumePoint> {
  return points.map((p, i) => ({
    d: i,
    issued: p.issued,
    burned: p.burned,
    net: p.net,
  }));
}

// =============================================================
// Number formatting
// =============================================================
//
// Picks a magnitude suffix per value so the KPI tile doesn't lock
// units while the underlying rollup grows or shrinks. Returns the
// number formatted with one decimal place and the matching unit
// label ("M", "k", or "").

const PLACEHOLDER = { value: "—", unit: "" } as const;

function formatMagnitude(n: number): { value: string; unit: string } {
  if (n >= 1_000_000)
    return { value: (n / 1_000_000).toFixed(2), unit: "M" };
  if (n >= 1_000) return { value: (n / 1_000).toFixed(1), unit: "k" };
  return { value: n.toLocaleString(), unit: "" };
}

function formatUsdMagnitude(usd: number): { value: string; unit: string } {
  if (usd >= 1_000_000)
    return { value: `$${(usd / 1_000_000).toFixed(2)}`, unit: "M" };
  if (usd >= 1_000) return { value: `$${(usd / 1_000).toFixed(1)}`, unit: "k" };
  return { value: `$${Math.round(usd).toLocaleString()}`, unit: "" };
}

// =============================================================
// Page
// =============================================================

function CreditsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<LedgerScope>("all");
  const [grantOpen, setGrantOpen] = useState(false);
  const { data } = useProjectCreditsRollup({ projectId });

  // Derive UI shapes from the wire response. `ui` stays null until
  // the rollup query resolves; cards render their own empty state
  // when their prop is undefined.
  const ui = useMemo(() => {
    if (!data) return null;
    return {
      ledger: data.ledger.map(toUiLedgerEntry),
      packs: toUiPacks(data.packages),
      burners: toUiBurners(data.topBurners),
      volume: toUiVolume(data.volume),
      response: data,
    };
  }, [data]);

  const visible = useMemo<ReadonlyArray<LedgerEntry>>(() => {
    const entries = ui?.ledger ?? [];
    if (scope === "all") return entries;
    return entries.filter((entry) => entry.source === scope);
  }, [ui, scope]);

  const walletValues = useMemo(() => {
    if (!ui) return null;
    const { kpis } = ui.response;
    const outstanding = formatMagnitude(kpis.outstanding);
    const issued = formatMagnitude(kpis.issued28d);
    const burned = formatMagnitude(kpis.burned28d);
    const revenue = formatUsdMagnitude(Number(kpis.revenue28dUsd));
    const burnRate =
      kpis.issued28d > 0
        ? `${((kpis.burned28d / kpis.issued28d) * 100).toFixed(1)}%`
        : "—";
    const avgPriceUsd =
      kpis.issued28d > 0 ? Number(kpis.revenue28dUsd) / kpis.issued28d : 0;
    return {
      outstanding: { ...outstanding, unit: outstanding.unit ? `${outstanding.unit} cr` : "credits" },
      walletCount: kpis.outstandingWalletCount.toLocaleString(),
      issued,
      burned,
      revenue,
      burnRate,
      avgPrice: avgPriceUsd > 0 ? `$${avgPriceUsd.toFixed(3)}` : "—",
      breakageValue:
        kpis.breakagePct !== null ? `${kpis.breakagePct.toFixed(1)}%` : "—",
    };
  }, [ui]);

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
          <Button
            variant="solid-primary"
            size="sm"
            onClick={() => setGrantOpen(true)}
          >
            <Plus size={13} />
            {t("credits.actions.grantCredits")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid gap-3 grid-cols-2 max-[760px]:grid-cols-2 max-[1180px]:grid-cols-3 min-[1181px]:grid-cols-5">
        <WalletStat
          accent
          label={t("credits.kpi.outstandingBalance")}
          value={walletValues?.outstanding.value ?? PLACEHOLDER.value}
          unit={walletValues?.outstanding.unit ?? PLACEHOLDER.unit}
          description={t("credits.kpi.outstandingDescription", {
            wallets: walletValues?.walletCount ?? "—",
          })}
          sparkSeed={1}
          sparkColor="var(--color-rv-accent-400)"
        />
        <WalletStat
          label={t("credits.kpi.issued28d")}
          value={walletValues?.issued.value ?? PLACEHOLDER.value}
          unit={walletValues?.issued.unit ?? PLACEHOLDER.unit}
          description={t("credits.kpi.issuedDelta")}
          descriptionTone="success"
          sparkSeed={3}
          sparkColor="var(--color-rv-success)"
        />
        <WalletStat
          label={t("credits.kpi.burned28d")}
          value={walletValues?.burned.value ?? PLACEHOLDER.value}
          unit={walletValues?.burned.unit ?? PLACEHOLDER.unit}
          description={t("credits.kpi.burnedRate", {
            rate: walletValues?.burnRate ?? "—",
          })}
          sparkSeed={5}
          sparkColor="var(--color-rv-violet)"
        />
        <WalletStat
          label={t("credits.kpi.revenue28d")}
          value={walletValues?.revenue.value ?? PLACEHOLDER.value}
          unit={walletValues?.revenue.unit ?? PLACEHOLDER.unit}
          description={t("credits.kpi.revenueAvg", {
            avg: walletValues?.avgPrice ?? "—",
          })}
          sparkSeed={7}
          sparkColor="var(--color-rv-warning)"
        />
        <WalletStat
          label={t("credits.kpi.breakage")}
          value={walletValues?.breakageValue ?? PLACEHOLDER.value}
          unit=""
          description={t("credits.kpi.breakageDescription")}
          sparkSeed={9}
          sparkColor="var(--color-rv-mute-600)"
        />
      </div>

      <CreditFlow flow={ui?.response.flow} />
      <VolumeChart series={ui?.volume} />

      <div className="grid items-start gap-4 max-[1280px]:grid-cols-1 grid-cols-[minmax(0,1fr)_380px]">
        <LedgerTable
          entries={visible}
          total={ui?.ledger.length ?? 0}
          scope={scope}
          onScopeChange={setScope}
        />
        <div className="flex flex-col gap-4">
          <LiabilityGauge liability={ui?.response.liability} />
          <PackageMix packs={ui?.packs} />
          <TopBurners burners={ui?.burners} />
        </div>
      </div>

      <GrantCreditsModal
        projectId={projectId}
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
      />
    </>
  );
}
