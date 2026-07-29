import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../lib/cn";

export const INPUT_CLASS =
  "h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500";

/**
 * `Field`'s label column — fixed so every row in the inspector lines up into
 * one quiet grid (design-tool idiom) regardless of which tab it's in. Labels
 * longer than this WRAP (never truncate, never force the column wider) —
 * deliberate per-usage exceptions belong in the label TEXT (shorten it), not
 * in a one-off wider column that would break the shared grid.
 */
const FIELD_LABEL_WIDTH_CLASS = "w-[92px]";
/** Every inspector row (Field, FieldRow) shares this floor so single-line
 *  controls (a select, a segmented control, a small number input) don't read
 *  as a shorter row than one holding a taller control — the compact rhythm
 *  the redesign is going for. */
const FIELD_MIN_HEIGHT_CLASS = "min-h-[28px]";

// =============================================================
// Layout primitives — local copies of funnel-builder's private
// Section/Field/Segmented (not exported there), same visual language.
// =============================================================

export function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-rv-divider">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left transition hover:bg-rv-c2"
      >
        <h4 className="m-0 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
          {title}
        </h4>
        <ChevronDown
          size={12}
          className={cn("text-rv-mute-500 transition-transform duration-150", open ? "rotate-0" : "-rotate-90")}
        />
      </button>
      {open && <div className="px-4 pb-3.5">{children}</div>}
    </section>
  );
}

/**
 * One inspector row: label left (fixed `FIELD_LABEL_WIDTH_CLASS` column,
 * sentence case, muted — NOT the all-caps mono chrome `Section` titles use;
 * a field label and a section header are different things and shouldn't
 * look like the same thing twice in a row), control right (`flex-1`).
 *
 * `items-start` + a little top padding on the label (rather than
 * `items-center`) so it optically aligns with the FIRST line of whatever
 * sits in the control column — most controls are a single `h-7`/`h-8` input,
 * but a few (`LocalizedTextField`'s hint line, a checkbox list) are taller,
 * and centering the label against the whole stack would float it away from
 * the input it names.
 *
 * Every existing caller's `className` (almost always a `"mt-N"` spacing
 * utility between stacked fields) still lands on this same outer row div, so
 * evolving this one component's internal layout — rather than adding a
 * parallel `FieldRow` — carries the compact-row idiom to every tab that
 * already uses `Field` (layout/content/binding/overrides/visibility) with no
 * call-site changes at all.
 */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2", FIELD_MIN_HEIGHT_CLASS, className)}>
      <label
        className={cn(
          FIELD_LABEL_WIDTH_CLASS,
          "flex-shrink-0 pt-1.5 text-[11px] leading-snug text-rv-mute-500",
        )}
      >
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div
      className="grid gap-1 rounded-md border border-rv-divider bg-rv-c2 p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "cursor-pointer rounded px-1.5 py-1 text-[11px] font-medium transition",
            value === o.value ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
