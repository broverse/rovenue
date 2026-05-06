import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Card, CardHeader } from "../../ui/card";

export type HealthStatus = "operational" | "degraded" | "down";

export type HealthService = {
  name: string;
  status: HealthStatus;
  metric: string;
};

const DOT_TONE: Record<HealthStatus, string> = {
  operational: "bg-rv-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-rv-success)_15%,transparent)]",
  degraded: "bg-rv-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-rv-warning)_15%,transparent)]",
  down: "bg-rv-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-rv-danger)_15%,transparent)]",
};

type Props = { services: ReadonlyArray<HealthService> };

/**
 * Self-hosted infra at-a-glance — one cell per service. Wraps to 3
 * columns on narrow screens.
 */
export function SystemHealthPanel({ services }: Props) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader
        title={t("panels.systemHealth.title")}
        subtitle={t("panels.systemHealth.subtitle")}
        right={
          <Button variant="light" className="h-6 px-2 text-xs">
            {t("panels.systemHealth.statusPage")}
          </Button>
        }
        className="pb-0"
      />
      <div className="grid grid-cols-3 lg:grid-cols-6">
        {services.map((s, i) => {
          const last = i === services.length - 1;
          return (
            <div
              key={s.name}
              className={`px-5 py-4 border-rv-divider ${last ? "" : "border-r"} ${
                i < services.length - 3 ? "max-lg:border-b" : ""
              }`}
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span className={`size-2 shrink-0 rounded-full ${DOT_TONE[s.status]}`} />
                {s.name}
              </div>
              <div
                className={`mt-1 text-[12px] capitalize ${
                  s.status === "operational" ? "text-rv-mute-600" : s.status === "degraded" ? "text-rv-warning" : "text-rv-danger"
                }`}
              >
                {t(`panels.systemHealth.status.${s.status}`)}
              </div>
              <div className="mt-0.5 font-rv-mono text-[11px] tabular-nums text-rv-mute-500">{s.metric}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
