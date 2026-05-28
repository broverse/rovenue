import { useTranslation } from "react-i18next";
import { Chip } from "../../ui/chip";
import type { RefundShieldOutcome } from "../../lib/hooks/useRefundShield";

// Declined = success (we won), Approved = danger (we lost), Reversed = warning.
const TONE: Record<RefundShieldOutcome, "success" | "danger" | "warning"> = {
  REFUND_DECLINED: "success",
  REFUND_APPROVED: "danger",
  REFUND_REVERSED: "warning",
};

export function OutcomeChip({
  outcome,
}: {
  outcome: RefundShieldOutcome | null;
}) {
  const { t } = useTranslation();
  if (!outcome) {
    return (
      <span className="font-rv-mono text-[11px] text-rv-mute-500">—</span>
    );
  }
  return (
    <Chip tone={TONE[outcome]}>{t(`refundShield.outcome.${outcome}`)}</Chip>
  );
}
