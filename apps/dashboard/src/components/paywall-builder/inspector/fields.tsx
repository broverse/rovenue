import { component, useService } from "impair";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Languages } from "lucide-react";
import type { AssetKind } from "@rovenue/shared";
import type { NodeBorder, NodeSize, StackNode, ThemeColor, ThemeUrl } from "@rovenue/shared/paywall";
import { cn } from "../../../lib/cn";
import { ColorSwatchInput } from "../../funnel-builder/color-swatch-input";
import { AssetLibraryModal } from "../../assets/asset-library-modal";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { Field, INPUT_CLASS, Segmented } from "./primitives";

// =============================================================
// Shared field widgets
// =============================================================

/**
 * Text/button/purchaseButton label editing — writes into
 * `config.localizations[editLocale][locKey]`.
 *
 * Wrapped in `component()` (unlike the other field widgets in this file,
 * which read their value from a plain `node` PROP): this is the only field
 * that reads live VM state (`vm.config.localizations`/`vm.editLocale`)
 * DIRECTLY inside its own body via `useService`. impair's `useService` alone
 * does not subscribe to anything — only a `component()`-wrapped body's
 * synchronous execution is tracked by an effect (see `layer-tree.tsx`'s
 * `LayerTree` for the established idiom of resolving such reads in a
 * tracked ancestor instead). Content-tab's own reactive boundary is
 * `ContentTab` (`content-tab.tsx`), which is `React.memo`'d via
 * `component()` and only re-renders when its `node` prop changes identity.
 * `setLocaleText`/`setEditLocale` mutate `config.localizations`/`editLocale`
 * — both SIBLINGS of `config.root`, never touched by those calls — so the
 * selected node's identity never changes and `ContentTab`'s memo bail-out
 * skips this subtree entirely. Without its OWN tracked scope, this field
 * never saw a typed keystroke or a locale switch: React's controlled-input
 * mechanism reset the DOM value back to the stale prop after every
 * keystroke, and switching locale left the previous locale's text on
 * screen. Wrapping this component alone (leaving the callers as plain
 * functions) gives it an independent reactive effect that re-renders it on
 * exactly the properties it reads, regardless of what its parent does.
 */
export const LocalizedTextField = component(({ label, locKey }: { label: string; locKey: string }) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const value = vm.config.localizations[vm.editLocale]?.[locKey] ?? "";
  const defaultValue = vm.config.localizations[vm.defaultLocale]?.[locKey] ?? "";
  const placeholder = vm.editLocale === vm.defaultLocale ? undefined : defaultValue || undefined;

  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          placeholder={placeholder}
          onChange={(e) => vm.setLocaleText(locKey, vm.editLocale, e.currentTarget.value)}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          onClick={() => vm.openLocalizationModal(locKey)}
          title={t("paywalls.builder.properties.editTranslations", "Edit translations")}
          className="flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded border border-rv-divider text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
        >
          <Languages size={14} />
        </button>
      </div>
      <div className="mt-1 font-rv-mono text-[10px] text-rv-mute-500">
        {t("paywalls.builder.properties.locKeyHint", "Key")}: {locKey} · {vm.editLocale.toUpperCase()}
      </div>
    </Field>
  );
});

/**
 * The hex input's placeholder when a `ThemeColor` side is unset. Deliberately
 * NOT a hex-looking string (the widget's own `"#0F172A"` default) — a
 * placeholder that looks like a color reads as an unobtrusive "current
 * value" rather than "nothing chosen yet". An en dash reads as "empty" at a
 * glance without looking like truncated input.
 */
export const UNSET_HEX_PLACEHOLDER = "–";

/** Fixed width for one `ColorTagSwatch`: the `xs` swatch (20px) + its gap-2
 *  (8px) + the hex input (76px) it's paired with, so two of these sit inline
 *  without either growing to fill leftover row space. `ColorSwatchInput`
 *  already sets the hex input's own font (`font-rv-mono`); this only fixes
 *  the pair's overall width. */
const COLOR_TAG_SWATCH_WIDTH_CLASS = "w-[104px]";

/** One [tag][swatch][hex] unit — "L" or "D" in front of a compact
 *  `ColorSwatchInput`. The tag is plain text rather than a Sun/Moon icon:
 *  equally legible at 9px and avoids importing icon glyphs purely for
 *  decoration. */
function ColorTagSwatch({
  tag,
  value,
  onChange,
}: {
  tag: "L" | "D";
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-rv-mono text-[9px] leading-none text-rv-mute-500" aria-hidden>
        {tag}
      </span>
      <ColorSwatchInput
        size="xs"
        unsetSwatch="dashed"
        placeholder={UNSET_HEX_PLACEHOLDER}
        value={value}
        onChange={onChange}
        className={COLOR_TAG_SWATCH_WIDTH_CLASS}
      />
    </div>
  );
}

/**
 * The right-hand content of a `ThemeColor` field: both light and dark as
 * compact inline [tag][swatch][hex] pairs on ONE row, instead of two
 * "LIGHT"/"DARK" sub-columns each carrying their own caps label. Factored out
 * of `ThemeColorField` so `BorderField` can compose the SAME pair inline next
 * to its width control, rather than duplicating the collapse-to-`undefined`
 * logic below.
 *
 * Collapse rule unchanged from before this redesign: clearing a side that
 * would leave the OTHER side also empty collapses the whole `ThemeColor` to
 * `undefined`, mirroring how `BorderField`/`ThemeUrlField` collapse an
 * emptied pair — never leaves a `{ light: "" }` husk behind.
 */
function ThemeColorPairInline({
  value,
  onChange,
  className,
}: {
  value: ThemeColor | undefined;
  onChange: (next: ThemeColor | undefined) => void;
  className?: string;
}) {
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
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <ColorTagSwatch tag="L" value={value?.light ?? ""} onChange={setLight} />
      <ColorTagSwatch tag="D" value={value?.dark ?? ""} onChange={setDark} />
    </div>
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
  return (
    <Field label={label} className={className}>
      <ThemeColorPairInline value={value} onChange={onChange} />
    </Field>
  );
}

/**
 * Neutral divider-ish gray assigned to a border's `color` the first time an
 * author raises its `width` above zero before ever touching color — the
 * schema requires both fields together (see `NodeBorder`'s doc comment), so
 * a lone width can't be written as the partial `{ width }`. Close to the
 * app's own divider line color, so an unstyled border reads as a subtle
 * outline rather than a jarring default.
 */
export const DEFAULT_BORDER_COLOR_HEX = "#94A3B8";

/**
 * Border width assigned the first time an author picks a `color` before
 * ever setting `width` — the mirror of `DEFAULT_BORDER_COLOR_HEX` above.
 * 1px is the thinnest width that still renders as a visible line on every
 * platform.
 */
export const DEFAULT_BORDER_WIDTH = 1;

/** The border-width control's own compact size — narrower than
 *  `NUMBER_INPUT_CLASS`'s default (`w-14` vs `w-20`): it sits inline next to
 *  a "px" suffix and the color pair, in a row that already has a label, so
 *  it only needs room for the 1-3 digit widths borders actually use. */
const BORDER_WIDTH_INPUT_CLASS =
  "h-7 w-14 rounded border border-rv-divider bg-rv-c2 px-1.5 text-center font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500";

/**
 * `NodeBorder`'s `width` and `color` are resolved together as one
 * composite (see its doc comment in schema.ts) — this field writes the
 * pair complete or not at all, never a partial the schema would reject.
 *
 * Collapses to `undefined` — mirroring how `ThemeColorField`/`ThemeUrlField`
 * collapse an emptied pair — in two cases: the width is cleared, or it is
 * driven to `0`. A zero-width border draws nothing (an invisible line), so
 * treating it the same as "cleared" keeps the field's meaning aligned with
 * what would actually appear on screen, rather than leaving a `width: 0`
 * object silently doing nothing. Clearing the color (both light AND dark
 * emptied, `ThemeColorField`'s own collapse rule) also collapses the whole
 * border, for the same "no partial" reason.
 *
 * Setting one side before the other still has to write a COMPLETE object
 * immediately, so the first edit picks a sensible default for the side the
 * author hasn't touched yet: the first width picks
 * `DEFAULT_BORDER_COLOR_HEX`, the first color picks `DEFAULT_BORDER_WIDTH`
 * — cleanest UX because a border becomes visible on the very first field
 * touched, instead of requiring both controls before anything renders.
 */
export function BorderField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: NodeBorder | undefined;
  onChange: (next: NodeBorder | undefined) => void;
  className?: string;
}) {
  const { t } = useTranslation();

  const setWidth = (width: number | undefined) => {
    if (width === undefined || width === 0) {
      onChange(undefined);
      return;
    }
    onChange({ width, color: value?.color ?? { light: DEFAULT_BORDER_COLOR_HEX } });
  };

  const setColor = (color: ThemeColor | undefined) => {
    if (color === undefined) {
      onChange(undefined);
      return;
    }
    onChange({ width: value?.width ?? DEFAULT_BORDER_WIDTH, color });
  };

  return (
    <Field label={label} className={className}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <NumberInput value={value?.width} onChange={setWidth} min={0} className={BORDER_WIDTH_INPUT_CLASS} />
          <span className="font-rv-mono text-[10px] text-rv-mute-500">
            {t("paywalls.builder.properties.borderWidthUnit", "px")}
          </span>
        </div>
        <ThemeColorPairInline value={value?.color} onChange={setColor} />
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
 *
 * `kind`/`projectId` are both optional and BOTH are required together to
 * turn on the asset picker. Every real caller passes both: content-tab.tsx's
 * image/video/lottie fields, and overrides.tsx's `video.url`/`video.
 * posterUrl`/`lottie.url` combos (`OverridePropField`'s switch gives each
 * combo its own explicit `kind` — `posterUrl` browses IMAGE assets, since a
 * poster is a still frame, not a second video). Omitting either prop simply
 * falls back to the plain text field with no picker — there's no case in
 * this codebase that currently does that on purpose, but the fallback
 * exists so a future caller with no natural project id in scope isn't
 * forced to fake one. When both are supplied, each row gets a "Browse"
 * button that opens `AssetLibraryModal` filtered to `kind`; picking an
 * asset there calls the EXACT SAME `setLight`/`setDark` a keystroke would,
 * so a hand-typed external URL is never a degraded path — uploading is
 * only ever an alternative to typing, never a replacement for it
 * (task-11-brief constraint 3).
 */
export function ThemeUrlField({
  labelLight,
  labelDark,
  value,
  onChange,
  placeholderLight,
  placeholderDark,
  className,
  kind,
  projectId,
}: {
  labelLight: string;
  labelDark: string;
  value: ThemeUrl | undefined;
  onChange: (next: ThemeUrl | undefined) => void;
  placeholderLight?: string;
  placeholderDark?: string;
  className?: string;
  kind?: AssetKind;
  projectId?: string;
}) {
  const { t } = useTranslation();
  const [pickerTarget, setPickerTarget] = useState<"light" | "dark" | null>(null);
  const canBrowse = Boolean(kind && projectId);

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

  const browseTitle = t("paywalls.builder.properties.browseAssets", "Browse assets");

  return (
    <>
      <Field label={labelLight} className={className}>
        <div className="flex items-center gap-1.5">
          <input
            value={value?.light ?? ""}
            onChange={(e) => setLight(e.currentTarget.value)}
            placeholder={placeholderLight}
            className={cn(INPUT_CLASS, "flex-1")}
          />
          {canBrowse && (
            <button
              type="button"
              title={browseTitle}
              aria-label={browseTitle}
              onClick={() => setPickerTarget("light")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-500 transition hover:border-rv-accent-500 hover:text-foreground"
            >
              <FolderOpen size={13} />
            </button>
          )}
        </div>
      </Field>
      <Field className="mt-3" label={labelDark}>
        <div className="flex items-center gap-1.5">
          <input
            value={value?.dark ?? ""}
            onChange={(e) => setDark(e.currentTarget.value)}
            placeholder={placeholderDark}
            className={cn(INPUT_CLASS, "flex-1")}
          />
          {canBrowse && (
            <button
              type="button"
              title={browseTitle}
              aria-label={browseTitle}
              onClick={() => setPickerTarget("dark")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-500 transition hover:border-rv-accent-500 hover:text-foreground"
            >
              <FolderOpen size={13} />
            </button>
          )}
        </div>
      </Field>
      {canBrowse && pickerTarget && (
        <AssetLibraryModal
          projectId={projectId!}
          kind={kind!}
          currentUrl={pickerTarget === "light" ? value?.light : value?.dark}
          open
          onClose={() => setPickerTarget(null)}
          onSelect={(url) => {
            if (pickerTarget === "light") setLight(url);
            else setDark(url);
            setPickerTarget(null);
          }}
        />
      )}
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

/** Compact by default — a corner radius, a spacing value, a thickness are all
 *  2-4 digit numbers, so the control shouldn't claim the whole row's width
 *  the way a URL or localized-text input legitimately does. `BorderField`
 *  passes its own (narrower still, `w-14`) className for the width control
 *  instead of this one, since it sits inline next to a color pair rather
 *  than alone in a row. */
const NUMBER_INPUT_CLASS =
  "h-8 w-20 rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500";

/**
 * The bare numeric `<input>` — no `Field`/label wrapper — so a caller that
 * needs the number control inline next to something else (`BorderField`'s
 * width-then-color row) can compose it directly instead of going through
 * `NumberField`'s own label column.
 *
 * `min`, when given, is enforced on what it WRITES, not merely advertised to
 * the browser. Which is why it keeps a local draft of the text: a
 * below-minimum entry is usually a PREFIX of a valid one — "0" on the way to
 * "0.5" — so refusing to display it (the naive controlled-input guard) makes
 * every value under 1 untypeable, while writing it through is the
 * schema-invalidating bug this minimum exists to stop. The draft holds such
 * an entry on screen without committing it, and blur clamps whatever is left
 * to the minimum, exactly as the `min` attribute promises.
 */
export function NumberInput({
  value,
  onChange,
  min,
  className,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  /** Smallest writable value. Absent = no floor (every value commits). */
  min?: number;
  className?: string;
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
      className={className ?? NUMBER_INPUT_CLASS}
    />
  );
}

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
  return (
    <Field label={label} className={className}>
      <NumberInput value={value} onChange={onChange} min={min} />
    </Field>
  );
}
