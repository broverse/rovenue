import { useTranslation } from "react-i18next";

export function AppsEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-10 text-center sm:px-6 sm:py-14">
      <div className="text-[14px] font-medium text-foreground">
        {t("apps.results.empty")}
      </div>
      <div className="mt-1.5 text-[12px] text-rv-mute-500">
        {t("apps.results.emptyHelp")}
      </div>
    </div>
  );
}
