import { useTranslation } from "react-i18next";
import { Chip, type ChipProps } from "../../ui/chip";
import type { TxStatus } from "./types";

const STATUS_TO_TONE: Record<TxStatus, NonNullable<ChipProps["tone"]>> = {
  paid: "success",
  failed: "danger",
  disputed: "danger",
  disputing: "warning",
  refunded: "default",
};

type Props = { status: TxStatus; className?: string };

/** Maps a transaction status to one of the shared `Chip` tones. */
export function TxStatusChip({ status, className }: Props) {
  const { t } = useTranslation();
  return (
    <Chip tone={STATUS_TO_TONE[status]} className={className}>
      {t(`transactions.status.${status}`)}
    </Chip>
  );
}
