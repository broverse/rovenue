import { useTranslation } from "react-i18next";
import { Chip, type ChipProps } from "../../ui/chip";
import type { SubscriptionStatus } from "./types";

const STATUS_TO_TONE: Record<SubscriptionStatus, NonNullable<ChipProps["tone"]>> = {
  active: "success",
  trial: "warning",
  grace: "warning",
  canceling: "default",
  churned: "default",
};

type Props = { status: SubscriptionStatus; className?: string };

/**
 * Status pill mirroring the design's `.chip` tones — `Active` = success,
 * trial/grace = warning, canceling/churned = neutral.
 */
export function SubscriptionStatusChip({ status, className }: Props) {
  const { t } = useTranslation();
  return (
    <Chip tone={STATUS_TO_TONE[status]} className={className}>
      {t(`subscriptions.status.${status}`)}
    </Chip>
  );
}
