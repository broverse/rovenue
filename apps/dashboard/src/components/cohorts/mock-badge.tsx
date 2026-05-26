import { useTranslation } from "react-i18next";

export function MockBadge() {
  const { t } = useTranslation();
  return (
    <span
      title={t("cohorts.mockBadge.tooltip")}
      className="inline-flex items-center rounded-sm border border-rv-divider bg-rv-c2 px-1 py-px font-rv-mono text-[9px] font-medium uppercase tracking-wider text-rv-mute-500"
    >
      {t("cohorts.mockBadge.label")}
    </span>
  );
}
