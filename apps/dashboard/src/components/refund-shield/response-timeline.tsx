import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowRight, Check, Clock, Send, X } from "lucide-react";
import type { RefundShieldResponseDetail } from "../../lib/hooks/useRefundShield";

interface Entry {
  key: string;
  icon: React.ReactNode;
  label: string;
  at: string;
  tone: "neutral" | "success" | "danger" | "warning";
}

export function ResponseTimeline({
  response,
}: {
  response: RefundShieldResponseDetail;
}) {
  const { t } = useTranslation();
  const entries: Entry[] = [];

  entries.push({
    key: "detected",
    icon: <Clock size={11} />,
    label: t("refundShield.detail.timeline.detected"),
    at: response.detectedAt,
    tone: "neutral",
  });

  if (
    response.status !== "SKIPPED_DISABLED" &&
    response.status !== "SKIPPED_NOT_FOUND"
  ) {
    entries.push({
      key: "scheduled",
      icon: <ArrowRight size={11} />,
      label: t("refundShield.detail.timeline.scheduled"),
      at: response.scheduledFor,
      tone: "neutral",
    });
  }

  if (response.sentAt) {
    entries.push({
      key: "sent",
      icon: <Send size={11} />,
      label: t("refundShield.detail.timeline.sent"),
      at: response.sentAt,
      tone: "success",
    });
  }

  if (response.status === "FAILED") {
    entries.push({
      key: "failed",
      icon: <AlertCircle size={11} />,
      label: response.error
        ? `${t("refundShield.detail.timeline.failed")} — ${response.error}`
        : t("refundShield.detail.timeline.failed"),
      at: response.updatedAt,
      tone: "danger",
    });
  }

  if (response.outcome === "REFUND_DECLINED" && response.outcomeReceivedAt) {
    entries.push({
      key: "outcome",
      icon: <Check size={11} />,
      label: t("refundShield.detail.timeline.outcomeDeclined"),
      at: response.outcomeReceivedAt,
      tone: "success",
    });
  } else if (
    response.outcome === "REFUND_APPROVED" &&
    response.outcomeReceivedAt
  ) {
    entries.push({
      key: "outcome",
      icon: <X size={11} />,
      label: t("refundShield.detail.timeline.outcomeApproved"),
      at: response.outcomeReceivedAt,
      tone: "danger",
    });
  } else if (
    response.outcome === "REFUND_REVERSED" &&
    response.outcomeReceivedAt
  ) {
    entries.push({
      key: "outcome",
      icon: <AlertCircle size={11} />,
      label: t("refundShield.detail.timeline.outcomeReversed"),
      at: response.outcomeReceivedAt,
      tone: "warning",
    });
  }

  const toneClass: Record<Entry["tone"], string> = {
    neutral: "border-rv-divider bg-rv-c2 text-rv-mute-700",
    success: "border-rv-success/40 bg-rv-success/10 text-rv-success",
    danger: "border-rv-danger/40 bg-rv-danger/10 text-rv-danger",
    warning: "border-rv-warning/40 bg-rv-warning/10 text-rv-warning",
  };

  return (
    <ol className="flex flex-col gap-2">
      {entries.map((e) => (
        <li key={e.key} className="flex items-center gap-3">
          <span
            className={`inline-flex size-6 items-center justify-center rounded-full border ${toneClass[e.tone]}`}
          >
            {e.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium">{e.label}</div>
            <div className="font-rv-mono text-[10px] text-rv-mute-500">
              {new Date(e.at).toLocaleString()}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
