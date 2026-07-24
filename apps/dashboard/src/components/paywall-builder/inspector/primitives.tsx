import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../lib/cn";

export const INPUT_CLASS =
  "h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500";

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
    <div className={className}>
      <label className="mb-1 block font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
        {label}
      </label>
      {children}
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
