import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import {
  useRefundShieldResponses,
  useRefundShieldSettings,
} from "../../lib/hooks/useRefundShield";
import { StatusChip } from "./status-chip";
import { OutcomeChip } from "./outcome-chip";

export interface SubscriberRefundShieldCardProps {
  projectId: string;
  subscriberId: string;
}

/**
 * Compact card rendered inside the subscriber detail panel. We
 * deliberately fetch the unfiltered first page (default limit 50)
 * and filter by subscriberId in memory — the responses endpoint
 * doesn't accept a subscriberId filter today (see "Backend gaps"
 * at the end of the plan). Per-subscriber refund volume is small
 * enough (spec §8: 0-3 rows typical) that this is correct in
 * practice; if it ever isn't, add a `subscriberId` query param
 * to the backend list endpoint.
 */
export function SubscriberRefundShieldCard({
  projectId,
  subscriberId,
}: SubscriberRefundShieldCardProps) {
  const { t } = useTranslation();
  const settings = useRefundShieldSettings(projectId);
  const responses = useRefundShieldResponses(projectId, { limit: 50 });

  const rows = useMemo(() => {
    if (!responses.data) return [];
    return responses.data.pages
      .flatMap((p) => p.responses)
      .filter((r) => r.subscriberId === subscriberId);
  }, [responses.data, subscriberId]);

  if (settings.isLoading) return null;

  if (!settings.data?.enabled) {
    return (
      <Card className="p-6">
        <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck size={16} className="text-rv-mute-500" />
          {t("refundShield.subscriberTab.title")}
        </h2>
        <p className="text-sm text-default-500">
          {t("refundShield.subscriberTab.disabled")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck size={16} className="text-rv-accent-500" />
          {t("refundShield.subscriberTab.title")}
        </h2>
        <span className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("refundShield.subscriberTab.count", { count: rows.length })}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-default-500">
          {t("refundShield.subscriberTab.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-rv-divider bg-rv-c1 px-3 py-2"
            >
              <Link
                to="/projects/$projectId/refund-shield/responses/$rid"
                params={{ projectId, rid: r.id }}
                className="font-rv-mono text-[12px] text-rv-accent-500 hover:underline"
              >
                {r.appleOriginalTransactionId}
              </Link>
              <StatusChip status={r.status} />
              <OutcomeChip outcome={r.outcome} />
              <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
                {new Date(r.detectedAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
