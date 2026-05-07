import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { GROUP_BY_OPTIONS } from "./mock-data";
import type { GroupBy } from "./types";

type Props = {
  value: GroupBy;
  onChange: (next: GroupBy) => void;
};

export function GroupByCard({ value, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {t("charts.groupBy.title")}
      </h4>
      <div
        role="radiogroup"
        aria-label={t("charts.groupBy.title")}
        className="flex flex-col gap-1"
      >
        {GROUP_BY_OPTIONS.map((opt) => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition",
                active ? "bg-rv-c2" : "hover:bg-rv-c2",
              )}
            >
              <span
                className={cn(
                  "grid size-3.5 place-items-center rounded-full border transition",
                  active
                    ? "border-rv-accent-500 bg-rv-accent-500"
                    : "border-rv-divider-strong bg-transparent",
                )}
              >
                {active && <span className="size-1.5 rounded-full bg-white" />}
              </span>
              <span
                className={cn(
                  "font-rv-mono",
                  active ? "text-foreground" : "text-rv-mute-700",
                )}
              >
                {t(`charts.groupBy.options.${opt}`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
