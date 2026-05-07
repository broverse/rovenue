import { useTranslation } from "react-i18next";

export function AppsEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-6 py-14 text-center">
      <div className="text-[14px] font-medium text-foreground">
        {t("apps.results.empty")}
      </div>
      <div className="mt-1.5 text-[12px] text-rv-mute-500">
        {t("apps.results.emptyHelp")}
      </div>
    </div>
  );
}
