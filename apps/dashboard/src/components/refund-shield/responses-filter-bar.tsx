import { useTranslation } from "react-i18next";
import { NativeSelect } from "../../ui/native-select";
import type {
  RefundShieldOutcome,
  RefundShieldStatus,
} from "../../lib/hooks/useRefundShield";

const STATUSES: ReadonlyArray<RefundShieldStatus> = [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED_DISABLED",
  "SKIPPED_NOT_FOUND",
];

const OUTCOMES: ReadonlyArray<RefundShieldOutcome> = [
  "REFUND_DECLINED",
  "REFUND_APPROVED",
  "REFUND_REVERSED",
];

export interface ResponsesFilters {
  status?: RefundShieldStatus;
  outcome?: RefundShieldOutcome;
}

export interface ResponsesFilterBarProps {
  value: ResponsesFilters;
  onChange: (next: ResponsesFilters) => void;
}

export function ResponsesFilterBar({
  value,
  onChange,
}: ResponsesFilterBarProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-rv-mute-500">
        {t("refundShield.responses.filters.status")}
        <NativeSelect
          aria-label={t("refundShield.responses.filters.status")}
          value={value.status ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              status: (e.target.value || undefined) as
                | RefundShieldStatus
                | undefined,
            })
          }
          className="h-8 w-[200px] text-[12px]"
        >
          <option value="">{t("refundShield.responses.filters.any")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`refundShield.status.${s}`)}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-rv-mute-500">
        {t("refundShield.responses.filters.outcome")}
        <NativeSelect
          aria-label={t("refundShield.responses.filters.outcome")}
          value={value.outcome ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              outcome: (e.target.value || undefined) as
                | RefundShieldOutcome
                | undefined,
            })
          }
          className="h-8 w-[200px] text-[12px]"
        >
          <option value="">{t("refundShield.responses.filters.any")}</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t(`refundShield.outcome.${o}`)}
            </option>
          ))}
        </NativeSelect>
      </label>
    </div>
  );
}
