import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { ShieldCheck, Settings as Cog } from "lucide-react";
import { Button } from "../../../../../ui/button";
import { StatCard } from "../../../../../ui/stat-card";
import { Sparkline } from "../../../../../components/dashboard/sparkline";
import { OnboardingWizard } from "../../../../../components/refund-shield";
import {
  useRefundShieldMetrics,
  useRefundShieldSettings,
} from "../../../../../lib/hooks/useRefundShield";
import { cn } from "../../../../../lib/cn";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/",
)({
  component: RefundShieldOverviewRoute,
});

function RefundShieldOverviewRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/",
  });
  return <RefundShieldOverviewPage projectId={projectId} />;
}

export function RefundShieldOverviewPage({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = useRefundShieldSettings(projectId);

  if (settings.isLoading) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }

  if (!settings.data?.enabled) {
    return (
      <>
        <Header subtitle={t("refundShield.disabled.body")} actions={null} />
        <OnboardingWizard
          projectId={projectId}
          onComplete={() =>
            qc.invalidateQueries({
              queryKey: ["refund-shield", "settings", projectId],
            })
          }
          onCancel={() =>
            void navigate({
              to: "/projects/$projectId",
              params: { projectId },
            })
          }
        />
      </>
    );
  }

  return <EnabledOverview projectId={projectId} />;
}

function EnabledOverview({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useRefundShieldMetrics(projectId);

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }

  const winPct = (data.winRate * 100).toFixed(1);
  const revenueSavedUsd = (
    data.estimatedRevenueSavedCents / 100
  ).toLocaleString("en-US", { style: "currency", currency: "USD" });

  // Sparkline placeholder: until /metrics exposes per-day points,
  // synthesise a flat-ish series weighted to the total sent count.
  // (Documented limitation — see "Backend gaps" at the end of the plan.)
  const trend = synthesiseTrend(data.sentCount, 30);

  return (
    <>
      <Header
        subtitle={t("refundShield.subtitle")}
        actions={
          <Button
            variant="flat"
            size="sm"
            onClick={() =>
              void navigate({
                to: "/projects/$projectId/refund-shield/settings",
                params: { projectId },
              })
            }
          >
            <Cog size={13} />
            {t("refundShield.settings.title")}
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("refundShield.kpi.sent")}
          value={data.sentCount.toLocaleString()}
        />
        <StatCard
          label={t("refundShield.kpi.winRate")}
          value={`${winPct}%`}
          description={t("refundShield.kpi.winRateHint")}
        />
        <StatCard
          label={t("refundShield.kpi.revenueSaved")}
          value={<span className="text-rv-success">{revenueSavedUsd}</span>}
          description={t("refundShield.kpi.revenueSavedHint")}
          descriptionTone="success"
        />
        <StatCard
          label={t("refundShield.kpi.outcomesPending")}
          value={(data.sentCount - data.outcomeCount).toLocaleString()}
          description={t("refundShield.kpi.outcomesPendingHint")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[13px] font-medium">
              {t("refundShield.trend.title")}
            </h2>
          </div>
          {data.sentCount === 0 ? (
            <p className="py-6 text-center text-[12px] text-rv-mute-500">
              {t("refundShield.trend.empty")}
            </p>
          ) : (
            <Sparkline data={trend} width={520} height={80} />
          )}
        </section>

        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <h2 className="text-[13px] font-medium">
            {t("refundShield.donut.title")}
          </h2>
          <DonutBreakdown
            buckets={[
              {
                key: "declined",
                label: t("refundShield.donut.declined"),
                count: data.declinedCount,
                color: "var(--color-rv-success)",
              },
              {
                key: "approved",
                label: t("refundShield.donut.approved"),
                count: data.approvedCount,
                color: "var(--color-rv-danger)",
              },
              {
                key: "reversed",
                label: t("refundShield.donut.reversed"),
                count: data.reversedCount,
                color: "var(--color-rv-warning)",
              },
              {
                key: "pending",
                label: t("refundShield.donut.pending"),
                count: Math.max(data.sentCount - data.outcomeCount, 0),
                color: "var(--color-rv-mute-500)",
              },
            ]}
          />
        </section>
      </div>
    </>
  );
}

function Header({
  subtitle,
  actions,
}: {
  subtitle: string;
  actions: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-[24px] font-semibold leading-8 tracking-tight">
          <ShieldCheck size={22} className="text-rv-accent-500" />
          {t("refundShield.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">{subtitle}</p>
      </div>
      {actions}
    </header>
  );
}

function DonutBreakdown({
  buckets,
}: {
  buckets: ReadonlyArray<{
    key: string;
    label: string;
    count: number;
    color: string;
  }>;
}) {
  const total = buckets.reduce((acc, b) => acc + b.count, 0);
  let acc = 0;
  const segments = buckets.map((b) => {
    const start = total > 0 ? (acc / total) * 100 : 0;
    acc += b.count;
    const end = total > 0 ? (acc / total) * 100 : 0;
    return { ...b, start, end };
  });

  return (
    <div className="mt-3 flex items-center gap-4">
      <svg viewBox="0 0 36 36" className="h-32 w-32 -rotate-90">
        <circle
          cx="18"
          cy="18"
          r="15.9155"
          fill="transparent"
          stroke="var(--color-rv-c3)"
          strokeWidth="3"
        />
        {segments.map((seg) => (
          <circle
            key={seg.key}
            cx="18"
            cy="18"
            r="15.9155"
            fill="transparent"
            stroke={seg.color}
            strokeWidth="3"
            strokeDasharray={`${seg.end - seg.start} 100`}
            strokeDashoffset={-seg.start}
          />
        ))}
      </svg>
      <ul className="flex flex-1 flex-col gap-1.5 text-[12px]">
        {segments.map((seg) => (
          <li key={seg.key} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: seg.color }}
            />
            <span className="flex-1 text-rv-mute-700">{seg.label}</span>
            <span
              className={cn("font-rv-mono text-rv-mute-500 tabular-nums")}
            >
              {seg.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function synthesiseTrend(total: number, days: number): number[] {
  const avg = total > 0 ? total / days : 0;
  return Array.from({ length: days }, (_, i) => {
    const wobble = Math.sin(i * 0.6) * (avg * 0.3);
    return Math.max(0, Math.round(avg + wobble));
  });
}
