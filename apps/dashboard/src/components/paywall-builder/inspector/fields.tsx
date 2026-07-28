import { useService } from "impair";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { NodeSize, StackNode, ThemeColor, ThemeUrl } from "@rovenue/shared/paywall";
import { ColorSwatchInput } from "../../funnel-builder/color-swatch-input";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { Field, INPUT_CLASS, Segmented } from "./primitives";

// =============================================================
// Shared field widgets
// =============================================================

/** Text/button/purchaseButton label editing — writes into `config.localizations[editLocale][locKey]`. */
export function LocalizedTextField({ label, locKey }: { label: string; locKey: string }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const value = vm.config.localizations[vm.editLocale]?.[locKey] ?? "";
  const defaultValue = vm.config.localizations[vm.defaultLocale]?.[locKey] ?? "";
  const placeholder = vm.editLocale === vm.defaultLocale ? undefined : defaultValue || undefined;

  return (
    <Field label={label}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => vm.setLocaleText(locKey, vm.editLocale, e.currentTarget.value)}
        className={INPUT_CLASS}
      />
      <div className="mt-1 font-rv-mono text-[10px] text-rv-mute-500">
        {t("paywalls.builder.properties.locKeyHint", "Key")}: {locKey} · {vm.editLocale.toUpperCase()}
      </div>
    </Field>
  );
}

export function ThemeColorField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: ThemeColor | undefined;
  onChange: (next: ThemeColor | undefined) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const setLight = (hex: string) => {
    const dark = value?.dark;
    if (!hex && !dark) {
      onChange(undefined);
      return;
    }
    onChange({ light: hex, dark });
  };
  const setDark = (hex: string) => {
    const light = value?.light ?? "";
    if (!light && !hex) {
      onChange(undefined);
      return;
    }
    onChange({ light, dark: hex || undefined });
  };

  return (
    <Field label={label} className={className}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="mb-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
            {t("paywalls.builder.properties.colorLight", "Light")}
          </div>
          <ColorSwatchInput size="sm" value={value?.light ?? ""} onChange={setLight} />
        </div>
        <div>
          <div className="mb-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
            {t("paywalls.builder.properties.colorDark", "Dark")}
          </div>
          <ColorSwatchInput size="sm" value={value?.dark ?? ""} onChange={setDark} />
        </div>
      </div>
    </Field>
  );
}

/**
 * A `ThemeUrl` (light/dark URL pair), rendered as two stacked text fields —
 * the same shape as the inline light/dark pair `ImageContent` writes by hand
 * for `image.url`, but reusable here because `video`/`lottie` need the SAME
 * pair twice each (their own required `url`, and video's optional
 * `posterUrl`), plus a third time in the overrides panel. Unlike
 * `ThemeColorField` this takes independent labels for the two rows (not one
 * wrapping label + Light/Dark sub-labels) so a caller can tell "URL" apart
 * from "Poster URL" when both sit in the same panel.
 *
 * Collapses to `undefined` when both rows are emptied — correct for the
 * OPTIONAL uses (`posterUrl`, and every use inside the overrides panel):
 * an empty `posterUrl` means "no poster", not a `{ light: "" }` object.
 */
export function ThemeUrlField({
  labelLight,
  labelDark,
  value,
  onChange,
  placeholderLight,
  placeholderDark,
  className,
}: {
  labelLight: string;
  labelDark: string;
  value: ThemeUrl | undefined;
  onChange: (next: ThemeUrl | undefined) => void;
  placeholderLight?: string;
  placeholderDark?: string;
  className?: string;
}) {
  const setLight = (v: string) => {
    const dark = value?.dark;
    if (!v && !dark) {
      onChange(undefined);
      return;
    }
    onChange({ light: v, dark });
  };
  const setDark = (v: string) => {
    const light = value?.light ?? "";
    if (!light && !v) {
      onChange(undefined);
      return;
    }
    onChange({ light, dark: v || undefined });
  };

  return (
    <>
      <Field label={labelLight} className={className}>
        <input
          value={value?.light ?? ""}
          onChange={(e) => setLight(e.currentTarget.value)}
          placeholder={placeholderLight}
          className={INPUT_CLASS}
        />
      </Field>
      <Field className="mt-3" label={labelDark}>
        <input
          value={value?.dark ?? ""}
          onChange={(e) => setDark(e.currentTarget.value)}
          placeholder={placeholderDark}
          className={INPUT_CLASS}
        />
      </Field>
    </>
  );
}

export function AlignField({
  value,
  onChange,
  className,
}: {
  value: "start" | "center" | "end" | undefined;
  onChange: (v: "start" | "center" | "end") => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("paywalls.builder.properties.align", "Align")} className={className}>
      <Segmented
        value={value ?? "start"}
        onChange={onChange}
        options={[
          { value: "start", label: t("paywalls.builder.properties.alignStart", "Start") },
          { value: "center", label: t("paywalls.builder.properties.alignCenter", "Center") },
          { value: "end", label: t("paywalls.builder.properties.alignEnd", "End") },
        ]}
      />
    </Field>
  );
}

export function PaddingField({
  value,
  onChange,
  className,
}: {
  value: StackNode["padding"];
  onChange: (next: StackNode["padding"]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const set = (key: "t" | "r" | "b" | "l") => (v: number | undefined) => {
    const next = { ...(value ?? {}) };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <Field label={t("paywalls.builder.properties.padding", "Padding")} className={className}>
      <div className="grid grid-cols-4 gap-1.5">
        <MiniNumber label="T" value={value?.t} onChange={set("t")} />
        <MiniNumber label="R" value={value?.r} onChange={set("r")} />
        <MiniNumber label="B" value={value?.b} onChange={set("b")} />
        <MiniNumber label="L" value={value?.l} onChange={set("l")} />
      </div>
    </Field>
  );
}

export function MiniNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <label className="flex flex-col items-center gap-1">
      <span className="font-rv-mono text-[9px] text-rv-mute-500">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        className="h-7 w-full rounded border border-rv-divider bg-rv-c2 px-1 text-center font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
      />
    </label>
  );
}

export function SizeField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: NodeSize | undefined;
  onChange: (v: NodeSize | undefined) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const mode: "fit" | "fill" | "custom" =
    value === "fit" ? "fit" : value === "fill" ? "fill" : typeof value === "number" ? "custom" : "fit";

  return (
    <Field label={label} className={className}>
      <div className="flex items-center gap-1.5">
        <Segmented
          value={mode}
          onChange={(v) => onChange(v === "custom" ? (typeof value === "number" ? value : 100) : v)}
          options={[
            { value: "fit", label: t("paywalls.builder.properties.sizeFit", "Fit") },
            { value: "fill", label: t("paywalls.builder.properties.sizeFill", "Fill") },
            { value: "custom", label: t("paywalls.builder.properties.sizeCustom", "Px") },
          ]}
        />
        {mode === "custom" && (
          <input
            type="number"
            value={typeof value === "number" ? value : ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              onChange(v === "" ? undefined : Number(v));
            }}
            className="h-7 w-16 rounded border border-rv-divider bg-rv-c2 px-1 text-center font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
          />
        )}
      </div>
    </Field>
  );
}

/** A plain `<select>` over a fixed list of string options (e.g. `ICON_NAMES`). */
export function SelectField({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <Field label={label} className={className}>
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={INPUT_CLASS}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * The smallest value a NumberField may write when it is bound to a schema
 * field declared `z.number().positive()` — `lottie.speed` and
 * `video.aspectRatio` today.
 *
 * `positive()` is exclusive-zero and so has no floor of its own, but an
 * `<input type="number">` needs a concrete one, and without it an author who
 * types `0` makes the WHOLE builderConfig SCHEMA_INVALID — an error that
 * names the config, not the field they touched. Deliberately far below every
 * advisory band the validator warns about (`LOTTIE_MIN_SPEED` is 0.1), so
 * this floor can never pre-empt a warning the author is meant to see: typing
 * `0` into Speed lands on a value that still raises
 * LOTTIE_SPEED_OUT_OF_RANGE, which is the intended feedback.
 */
export const POSITIVE_NUMBER_FIELD_MIN = 0.01;

/** The committed value as input text. Absent = an empty field, which is the
 *  authored "not set" for every optional numeric prop. */
function numberFieldText(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/**
 * A numeric input whose `min`, when given, is enforced on what it WRITES,
 * not merely advertised to the browser.
 *
 * Which is why it keeps a local draft of the text. A below-minimum entry is
 * usually a PREFIX of a valid one — "0" on the way to "0.5" — so refusing to
 * display it (the naive controlled-input guard) makes every value under 1
 * untypeable, while writing it through is the schema-invalidating bug this
 * minimum exists to stop. The draft holds such an entry on screen without
 * committing it, and blur clamps whatever is left to the minimum, exactly as
 * the `min` attribute promises.
 */
export function NumberField({
  label,
  value,
  onChange,
  className,
  min,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  className?: string;
  /** Smallest writable value. Absent = no floor (every value commits). */
  min?: number;
}) {
  const [draft, setDraft] = useState(() => numberFieldText(value));
  // Re-sync the draft when the committed value changes from OUTSIDE this
  // field (another node selected, an undo, an AI edit) — adjusting state
  // during render rather than in an effect, so no frame ever shows the
  // previous node's number.
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setDraft(numberFieldText(value));
  }

  const belowMin = (n: number): boolean => min !== undefined && n < min;

  return (
    <Field label={label} className={className}>
      <input
        type="number"
        min={min}
        value={draft}
        onChange={(e) => {
          const text = e.currentTarget.value;
          setDraft(text);
          if (text === "") {
            onChange(undefined);
            return;
          }
          const parsed = Number(text);
          // NaN never reaches the config: `type="number"` normally reports
          // unparsable input as "", but a partial entry that slips through
          // must not be written either.
          if (Number.isNaN(parsed) || belowMin(parsed)) return;
          onChange(parsed);
        }}
        onBlur={() => {
          if (draft === "") return;
          const parsed = Number(draft);
          if (Number.isNaN(parsed)) {
            setDraft(numberFieldText(value));
            return;
          }
          if (!belowMin(parsed)) return;
          // min is defined whenever belowMin is true.
          setDraft(numberFieldText(min));
          onChange(min);
        }}
        className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
      />
    </Field>
  );
}
