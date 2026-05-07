import { useTranslation } from "react-i18next";
import { SAVED_VIEWS } from "./mock-data";

export function SavedViewsCard() {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {t("charts.savedViews.title")}
      </h4>
      <div className="flex flex-col">
        {SAVED_VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            className="flex cursor-pointer flex-col gap-0.5 rounded px-2.5 py-2 text-left transition hover:bg-rv-c2"
          >
            <span className="text-[12px] font-medium">{t(view.nameKey)}</span>
            <span className="font-rv-mono text-[10px] text-rv-mute-500">
              {t(view.metaKey)}
            </span>
          </button>
        ))}
        <div className="mt-1.5 rounded-md border border-dashed border-rv-divider px-3.5 py-3 text-center text-[11px] text-rv-mute-500">
          {t("charts.savedViews.saveCurrent")}
        </div>
      </div>
    </div>
  );
}
