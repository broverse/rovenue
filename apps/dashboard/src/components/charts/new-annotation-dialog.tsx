import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api";
import { useCreateAnnotation } from "../../lib/hooks/useProjectCharts";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
};

interface ColorChoice {
  value: string;
  swatch: string;
  labelKey: string;
}

const COLOR_CHOICES: ReadonlyArray<ColorChoice> = [
  {
    value: "var(--color-rv-accent-500)",
    swatch: "var(--color-rv-accent-500)",
    labelKey: "charts.annotations.colors.blue",
  },
  {
    value: "var(--color-rv-success)",
    swatch: "var(--color-rv-success)",
    labelKey: "charts.annotations.colors.green",
  },
  {
    value: "var(--color-rv-warning)",
    swatch: "var(--color-rv-warning)",
    labelKey: "charts.annotations.colors.amber",
  },
  {
    value: "var(--color-rv-danger)",
    swatch: "var(--color-rv-danger)",
    labelKey: "charts.annotations.colors.red",
  },
  {
    value: "var(--color-rv-violet)",
    swatch: "var(--color-rv-violet)",
    labelKey: "charts.annotations.colors.violet",
  },
];

function todayLocalDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function NewAnnotationDialog(props: Props) {
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
            "fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
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

function DialogBody({ projectId, onClose }: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  const dateId = useId();
  const descriptionId = useId();
  const urlId = useId();
  const labelRef = useRef<HTMLInputElement>(null);

  const [label, setLabel] = useState("");
  const [date, setDate] = useState(() => todayLocalDateString());
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState<string>(COLOR_CHOICES[0]!.value);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const create = useCreateAnnotation(projectId);

  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  const trimmedLabel = label.trim();
  const canSubmit =
    trimmedLabel.length > 0 && date.length > 0 && !create.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);

    const occurredAt = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(occurredAt.getTime())) {
      setSubmitError(
        t("charts.annotations.errors.date", "Pick a valid date."),
      );
      return;
    }

    const trimmedDesc = description.trim();
    const trimmedUrl = url.trim();

    try {
      await create.mutateAsync({
        occurredAt: occurredAt.toISOString(),
        label: trimmedLabel,
        description: trimmedDesc ? trimmedDesc : null,
        url: trimmedUrl ? trimmedUrl : null,
        color,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError(
          t(
            "charts.annotations.errors.generic",
            "Could not save the annotation. Please try again.",
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
            {t("charts.annotations.newTitle", "Add annotation")}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
            {t(
              "charts.annotations.newSubtitle",
              "Flag a launch, promo, or incident so spikes in the chart have context.",
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
          id={labelId}
          label={t("charts.annotations.fields.label", "Label")}
        >
          <Input
            id={labelId}
            ref={labelRef}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t(
              "charts.annotations.fields.labelPlaceholder",
              "e.g. v3.1 launch",
            )}
            maxLength={200}
            autoComplete="off"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={dateId}
            label={t("charts.annotations.fields.date", "Date")}
          >
            <Input
              id={dateId}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>

          <Field
            id={`${labelId}-color`}
            label={t("charts.annotations.fields.color", "Color")}
          >
            <div
              id={`${labelId}-color`}
              role="radiogroup"
              aria-label={t("charts.annotations.fields.color", "Color")}
              className="flex items-center gap-2"
            >
              {COLOR_CHOICES.map((choice) => {
                const selected = choice.value === color;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={t(choice.labelKey, choice.value)}
                    onClick={() => setColor(choice.value)}
                    className={cn(
                      "size-7 rounded-full border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500/40",
                      selected
                        ? "border-foreground"
                        : "border-transparent hover:border-rv-divider-strong",
                    )}
                    style={{ background: choice.swatch }}
                  />
                );
              })}
            </div>
          </Field>
        </div>

        <Field
          id={descriptionId}
          label={t("charts.annotations.fields.description", "Description")}
          optional
        >
          <Textarea
            id={descriptionId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t(
              "charts.annotations.fields.descriptionPlaceholder",
              "What changed?",
            )}
            rows={2}
            maxLength={1000}
          />
        </Field>

        <Field
          id={urlId}
          label={t("charts.annotations.fields.url", "Link")}
          optional
          hint={t(
            "charts.annotations.fields.urlHint",
            "Optional — e.g. PR, release notes, Linear ticket.",
          )}
        >
          <Input
            id={urlId}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            autoComplete="off"
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
            ? t("charts.annotations.saving", "Saving…")
            : t("charts.annotations.save", "Save annotation")}
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
