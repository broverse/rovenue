import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import { Check, ChevronDown, X } from "lucide-react";
import type {
  ChartFilterOption,
  ChartFilterOptionsResponse,
} from "@rovenue/shared";
import { cn } from "../../lib/cn";

// =============================================================
// Filters card
// =============================================================
//
// Three fixed dimensions — platform, country, product_group —
// rendered as chips. Each chip opens a checkbox popover that
// lets the user multi-select values from the API. The "X" on a
// chip clears just that dimension.

export type FilterDimension = "platform" | "country" | "productGroup";

export type FilterSelection = Record<FilterDimension, string[]>;

const DIMENSIONS: ReadonlyArray<{
  key: FilterDimension;
  labelKey: string;
  apiKey: keyof Pick<
    ChartFilterOptionsResponse,
    "platform" | "country" | "productGroup"
  >;
}> = [
  { key: "platform", labelKey: "charts.filters.dimensions.platform", apiKey: "platform" },
  { key: "country", labelKey: "charts.filters.dimensions.country", apiKey: "country" },
  {
    key: "productGroup",
    labelKey: "charts.filters.dimensions.productGroup",
    apiKey: "productGroup",
  },
];

type Props = {
  value: FilterSelection;
  onChange: (next: FilterSelection) => void;
  options?: ChartFilterOptionsResponse;
  loading?: boolean;
};

export function FiltersCard({ value, onChange, options, loading }: Props) {
  const { t } = useTranslation();

  const updateDimension = (key: FilterDimension, values: string[]) => {
    onChange({ ...value, [key]: values });
  };

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {t("charts.filters.title")}
      </h4>
      <div className="flex flex-col gap-2">
        {DIMENSIONS.map((dim) => (
          <FilterRow
            key={dim.key}
            label={t(dim.labelKey)}
            selected={value[dim.key]}
            available={options?.[dim.apiKey] ?? []}
            onChange={(next) => updateDimension(dim.key, next)}
            onClear={() => updateDimension(dim.key, [])}
            loading={loading}
          />
        ))}
      </div>
    </div>
  );
}

type RowProps = {
  label: string;
  selected: string[];
  available: ReadonlyArray<ChartFilterOption>;
  onChange: (next: string[]) => void;
  onClear: () => void;
  loading?: boolean;
};

function FilterRow({
  label,
  selected,
  available,
  onChange,
  onClear,
  loading,
}: RowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const summary =
    selected.length === 0
      ? loading
        ? t("charts.filters.loading")
        : t("charts.filters.allValues")
      : selected.join(", ");

  const toggleValue = (val: string) => {
    if (selected.includes(val)) {
      onChange(selected.filter((s) => s !== val));
    } else {
      onChange([...selected, val]);
    }
  };

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 font-rv-mono text-[11px]">
        <span className="text-rv-mute-500">{label}</span>
        <Menu.Trigger
          render={({ ref: _ref, ...props }) => (
            <button
              {...props}
              type="button"
              className="flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-left transition hover:text-foreground"
            >
              <span
                className={cn(
                  "flex-1 truncate",
                  selected.length === 0
                    ? "text-rv-mute-500"
                    : "text-rv-accent-400",
                )}
              >
                {summary}
              </span>
              <ChevronDown size={10} className="shrink-0 text-rv-mute-500" />
            </button>
          )}
        />
        {selected.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            aria-label={t("charts.filters.remove")}
            className="cursor-pointer text-rv-mute-500 transition hover:text-foreground"
          >
            <X size={11} />
          </button>
        )}
      </div>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup
            className={cn(
              "z-50 max-h-[280px] min-w-[200px] overflow-y-auto rounded-md border border-rv-divider bg-rv-c1 p-1 shadow-lg",
              "focus:outline-none",
            )}
          >
            {available.length === 0 ? (
              <div className="px-3 py-3 text-center text-[11px] text-rv-mute-500">
                {loading
                  ? t("charts.filters.loading")
                  : t("charts.filters.empty")}
              </div>
            ) : (
              available.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <Menu.Item
                    key={opt.value}
                    closeOnClick={false}
                    onClick={() => toggleValue(opt.value)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] outline-none transition",
                      "data-[highlighted]:bg-rv-c2",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-3.5 items-center justify-center rounded border",
                        checked
                          ? "border-rv-accent-500 bg-rv-accent-500 text-white"
                          : "border-rv-divider-strong",
                      )}
                    >
                      {checked && <Check size={9} />}
                    </span>
                    <span className="flex-1 truncate font-rv-mono">
                      {opt.label}
                    </span>
                    <span className="font-rv-mono text-[10px] text-rv-mute-500">
                      {opt.count.toLocaleString()}
                    </span>
                  </Menu.Item>
                );
              })
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
