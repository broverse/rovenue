import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type {
  ChartCategory,
  ChartRangeOption,
  ChartType,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api";
import { useCreateCustomChart } from "../../lib/hooks/useProjectCharts";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
};

const CATEGORY_OPTIONS: ReadonlyArray<ChartCategory> = [
  "revenue",
  "growth",
  "retention",
  "conversion",
  "credits",
  "custom",
];

const CHART_TYPE_OPTIONS: ReadonlyArray<ChartType> = ["line", "area", "bar"];

const RANGE_OPTIONS: ReadonlyArray<ChartRangeOption> = [
  "1M",
  "3M",
  "6M",
  "12M",
  "YTD",
  "All",
];

export function NewChartDialog(props: Props) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {props.open && <DialogBody {...props} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DialogBody({ projectId, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const nameId = useId();
  const categoryId = useId();
  const chartTypeId = useId();
  const rangeId = useId();
  const descriptionId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<ChartCategory>("custom");
  const [chartType, setChartType] = useState<ChartType>("line");
  const [range, setRange] = useState<ChartRangeOption>("12M");
  const [description, setDescription] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const create = useCreateCustomChart(projectId);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !create.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);

    const config: Record<string, unknown> = {};
    const trimmedDesc = description.trim();
    if (trimmedDesc) config.description = trimmedDesc;

    try {
      const res = await create.mutateAsync({
        name: trimmedName,
        category,
        chartType,
        range,
        config,
      });
      onCreated?.(res.entry.id);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError(
          t(
            "charts.newChart.errors.generic",
            "Could not create the chart. Please try again.",
          ),
        );
      }
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col">
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">
            {t("charts.newChart.title", "New chart")}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
            {t(
              "charts.newChart.subtitle",
              "Adds a chart to the project's shared catalog. Pin filters and group-by after it's created.",
            )}
          </Dialog.Description>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close", "Close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex flex-col gap-4 px-5 py-5">
        <Field
          id={nameId}
          label={t("charts.newChart.name.label", "Name")}
          hint={t(
            "charts.newChart.name.hint",
            "Shown in the catalog and on the chart card.",
          )}
        >
          <Input
            id={nameId}
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(
              "charts.newChart.name.placeholder",
              "e.g. Trial conversion (iOS only)",
            )}
            autoComplete="off"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={categoryId}
            label={t("charts.newChart.category.label", "Category")}
          >
            <Select
              id={categoryId}
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as ChartCategory)
              }
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`charts.categories.${c}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id={chartTypeId}
            label={t("charts.newChart.chartType.label", "Default chart type")}
          >
            <Select
              id={chartTypeId}
              value={chartType}
              onChange={(e) => setChartType(e.target.value as ChartType)}
            >
              {CHART_TYPE_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          id={rangeId}
          label={t("charts.newChart.range.label", "Default range")}
        >
          <Select
            id={rangeId}
            value={range}
            onChange={(e) => setRange(e.target.value as ChartRangeOption)}
          >
            {RANGE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id={descriptionId}
          label={t("charts.newChart.description.label", "Description")}
          optional
          hint={t(
            "charts.newChart.description.hint",
            "Optional context for teammates browsing the library.",
          )}
        >
          <Textarea
            id={descriptionId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t(
              "charts.newChart.description.placeholder",
              "What does this chart track?",
            )}
            rows={3}
          />
        </Field>

        {submitError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {submitError}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={onClose}
          disabled={create.isPending}
        >
          {t("common.cancel", "Cancel")}
        </Button>
        <Button
          type="submit"
          variant="solid-primary"
          size="sm"
          disabled={!canSubmit}
        >
          {create.isPending
            ? t("charts.newChart.creating", "Creating…")
            : t("charts.newChart.submit", "Create chart")}
        </Button>
      </footer>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  optional,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"
      >
        {label}
        {optional && (
          <span className="text-[11px] font-normal text-rv-mute-500">
            {t("common.optional", "optional")}
          </span>
        )}
      </label>
      {children}
      {hint && (
        <p className="text-[11px] leading-snug text-rv-mute-500">{hint}</p>
      )}
    </div>
  );
}
