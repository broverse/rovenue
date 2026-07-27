import { useService } from "impair";
import { useTranslation } from "react-i18next";
import type { NodeSize, StackNode, ThemeColor } from "@rovenue/shared/paywall";
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

export function NumberField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  className?: string;
}) {
  return (
    <Field label={label} className={className}>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
      />
    </Field>
  );
}
