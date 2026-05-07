import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "../../ui/button";
import { FILTERS } from "./mock-data";

export function FiltersCard() {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {t("charts.filters.title")}
      </h4>
      <div className="flex flex-col gap-2">
        {FILTERS.map((chip) => (
          <div
            key={chip.key}
            className="flex items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 font-rv-mono text-[11px]"
          >
            <span className="text-rv-mute-500">{chip.key}</span>
            <span className="flex-1 truncate text-rv-accent-400">{chip.value}</span>
            <button
              type="button"
              aria-label={t("charts.filters.remove")}
              className="cursor-pointer text-rv-mute-500 transition hover:text-foreground"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <Button variant="flat" size="sm" className="h-7 justify-start text-[11px]">
          <Plus size={11} />
          {t("charts.filters.add")}
        </Button>
      </div>
    </div>
  );
}
