import { Chip, type ChipProps } from "../../ui/chip";
import type { ProductStatus } from "./types";

const STATUS_TO_TONE: Record<ProductStatus, NonNullable<ChipProps["tone"]>> = {
  active: "success",
  draft: "warning",
  archived: "default",
};

const STATUS_LABEL: Record<ProductStatus, string> = {
  active: "Active",
  draft: "Draft",
  archived: "Archived",
};

type Props = { status: ProductStatus; className?: string };

/** Small status pill — wraps the shared `Chip` so the tone mapping lives in one place. */
export function StatusChip({ status, className }: Props) {
  return (
    <Chip tone={STATUS_TO_TONE[status]} className={className}>
      {STATUS_LABEL[status]}
    </Chip>
  );
}
