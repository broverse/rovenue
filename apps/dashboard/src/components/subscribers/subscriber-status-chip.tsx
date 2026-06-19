import { useTranslation } from "react-i18next";
import { Chip, type ChipProps } from "../../ui/chip";
import type { SubscriberStatus } from "./types";

const STATUS_TONE: Record<SubscriberStatus, NonNullable<ChipProps["tone"]>> = {
  active: "success",
  trial: "warning",
  grace: "warning",
  churned: "default",
  canceled: "danger",
  free: "primary",
};

type Props = { status: SubscriberStatus; className?: string };

/** Status pill for a subscriber row — wraps the shared `Chip` so the tone mapping lives in one place. */
export function SubscriberStatusChip({ status, className }: Props) {
  const { t } = useTranslation();
  return (
    <Chip tone={STATUS_TONE[status]} className={className}>
      {t(`subscribers.status.${status}`)}
    </Chip>
  );
}
