import { useTranslation } from "react-i18next";
import { Chip } from "../../ui/chip";
import type { RefundShieldStatus } from "../../lib/hooks/useRefundShield";

// Local `Chip` only exposes default / primary / success / danger / warning
// tones — no "info" or "muted". Pending uses `primary` (in-flight blue),
// skipped uses `default` (neutral grey).
const TONE: Record<
  RefundShieldStatus,
  "primary" | "success" | "danger" | "default"
> = {
  PENDING: "primary",
  SENT: "success",
  FAILED: "danger",
  SKIPPED_DISABLED: "default",
  SKIPPED_NOT_FOUND: "default",
};

export function StatusChip({ status }: { status: RefundShieldStatus }) {
  const { t } = useTranslation();
  return <Chip tone={TONE[status]}>{t(`refundShield.status.${status}`)}</Chip>;
}
