import { useEffect, useId, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { Pipette } from "lucide-react";
import { cn } from "../../lib/cn";

const PRESETS: ReadonlyArray<ReadonlyArray<string>> = [
  ["#3B82F6", "#6366F1", "#8B5CF6", "#A855F7", "#EC4899", "#F43F5E"],
  ["#EF4444", "#F97316", "#F59E0B", "#EAB308", "#84CC16", "#10B981"],
  ["#06B6D4", "#0EA5E9", "#14B8A6", "#22C55E", "#0F172A", "#1F2937"],
  ["#FFFFFF", "#FAFAFA", "#F4F4F5", "#E4E4E7", "#A1A1AA", "#52525B"],
];

const HEX_RE = /^#?[0-9a-fA-F]{0,8}$/;

function normalizeHex(input: string): string {
  const v = input.trim();
  if (!v) return "";
  return v.startsWith("#") ? v : `#${v}`;
}

function isValidHex(input: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(input);
}

function toPickerHex(input: string): string {
  if (!input) return "#000000";
  const v = normalizeHex(input);
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const r = v[1], g = v[2], b = v[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7);
  return "#000000";
}

export interface ColorSwatchInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  presets?: ReadonlyArray<ReadonlyArray<string>>;
  size?: "sm" | "md";
  // Color rendered downstream when `value` is blank (e.g. a theme default the
  // page falls back to). Shown in the swatch + popover preview so the picker
  // matches what the user actually sees. The text input still shows the
  // placeholder, so it's visually obvious the value isn't an explicit override.
  inheritedColor?: string;
}

export function ColorSwatchInput({
  value,
  onChange,
  placeholder = "#0F172A",
  className,
  presets = PRESETS,
  size = "md",
  inheritedColor,
}: ColorSwatchInputProps) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const nativePickerRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  useEffect(() => {
    setText(value);
  }, [value]);

  const explicit = value && isValidHex(normalizeHex(value)) ? normalizeHex(value) : "";
  const inherited =
    !explicit && inheritedColor && isValidHex(normalizeHex(inheritedColor))
      ? normalizeHex(inheritedColor)
      : "";
  const display = explicit || inherited;
  const swatchSize = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const inputHeight = size === "sm" ? "h-7" : "h-8";

  const commit = (raw: string) => {
    const v = raw.trim() === "" ? "" : normalizeHex(raw);
    if (v === "" || isValidHex(v)) onChange(v);
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <PopoverTrigger>
          <button
            type="button"
            aria-label="Open color picker"
            className={cn(
              swatchSize,
              "flex-shrink-0 cursor-pointer rounded-md border border-rv-divider transition hover:scale-[1.04] focus:outline-none focus:ring-2 focus:ring-rv-accent-500",
              !display && "bg-[conic-gradient(at_50%_50%,#f4f4f5_0deg,#fff_90deg,#f4f4f5_180deg,#fff_270deg)]",
            )}
            style={display ? { background: display } : undefined}
          />
        </PopoverTrigger>
        <PopoverContent
          placement="bottom start"
          offset={6}
          className="rounded-lg border border-rv-divider bg-rv-c1 shadow-xl"
        >
          <div className="w-[232px] p-3">
            <div className="mb-2 flex items-center gap-2">
              <div
                className="h-9 flex-1 rounded-md border border-rv-divider"
                style={{ background: display || "transparent" }}
              />
              <label
                htmlFor={inputId}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:text-foreground"
                title="Open OS color picker"
              >
                <Pipette size={14} />
                <input
                  ref={nativePickerRef}
                  id={inputId}
                  type="color"
                  value={toPickerHex(display)}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setText(v);
                    onChange(v);
                  }}
                  className="sr-only"
                />
              </label>
            </div>
            <div className="mb-3 flex items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2">
              <span className="font-rv-mono text-[11px] text-rv-mute-500">#</span>
              <input
                value={text.replace(/^#/, "")}
                onChange={(e) => {
                  const raw = e.currentTarget.value;
                  if (!HEX_RE.test(`#${raw}`)) return;
                  setText(`#${raw}`);
                  const candidate = `#${raw}`;
                  if (isValidHex(candidate)) onChange(candidate);
                }}
                onBlur={() => commit(text)}
                placeholder={placeholder.replace(/^#/, "")}
                spellCheck={false}
                className="h-8 w-full bg-transparent font-rv-mono text-[12px] uppercase text-foreground outline-none"
              />
            </div>
            <div className="space-y-1.5">
              {presets.map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-1.5">
                  {row.map((c) => {
                    const active = display.toLowerCase() === c.toLowerCase();
                    return (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        onClick={() => {
                          onChange(c);
                          setOpen(false);
                        }}
                        className={cn(
                          "h-7 w-7 cursor-pointer rounded-md border transition hover:scale-110",
                          active
                            ? "border-rv-accent-500 ring-2 ring-rv-accent-500/40"
                            : "border-rv-divider",
                        )}
                        style={{ background: c }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setText("");
                  setOpen(false);
                }}
                className="font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500 hover:text-foreground"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md bg-rv-accent-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-rv-accent-600"
              >
                Done
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <input
        value={text}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          if (!HEX_RE.test(raw.startsWith("#") ? raw : `#${raw}`)) return;
          setText(raw);
          const candidate = normalizeHex(raw);
          if (raw === "" || isValidHex(candidate)) onChange(raw === "" ? "" : candidate);
        }}
        onBlur={() => commit(text)}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(
          inputHeight,
          "min-w-0 flex-1 rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] uppercase text-foreground outline-none focus:border-rv-accent-500",
        )}
      />
    </div>
  );
}
