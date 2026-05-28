import { useMemo, useRef, useState, useEffect } from "react";
import { component, useService } from "impair";
import { Button, Input } from "@heroui/react";
import {
  AlertTriangle,
  Check,
  Filter,
  Globe2,
  Loader2,
  Plus,
  Save,
  Search,
  Star,
  X,
} from "lucide-react";
import type { Localized, LocaleCode } from "@rovenue/shared/i18n";
import { cn } from "../../lib/cn";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { PAGE_TYPES, type Page } from "./types";

// ───────────────────────── Locale helpers ─────────────────────────

const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/;

function localeBaseName(code: LocaleCode): string {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    return dn.of(code.split("-")[0]) ?? code;
  } catch {
    return code;
  }
}

function localeRegionName(code: LocaleCode): string | null {
  const parts = code.split("-");
  if (parts.length < 2) return null;
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return dn.of(parts[1].toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

function localeFullName(code: LocaleCode): string {
  const base = localeBaseName(code);
  const region = localeRegionName(code);
  return region ? `${base} (${region})` : base;
}

// Curated preset list — covers the ~60 most common BCP47 tags. The
// combobox also accepts free-text entry for anything not in this list.
type Preset = { code: LocaleCode; common?: boolean };
const PRESETS: readonly Preset[] = [
  // ── Top 15 most-used ──
  { code: "en", common: true },
  { code: "es", common: true },
  { code: "fr", common: true },
  { code: "de", common: true },
  { code: "it", common: true },
  { code: "pt", common: true },
  { code: "pt-BR", common: true },
  { code: "tr", common: true },
  { code: "ru", common: true },
  { code: "zh-Hans", common: true },
  { code: "zh-Hant", common: true },
  { code: "ja", common: true },
  { code: "ko", common: true },
  { code: "ar", common: true },
  { code: "hi", common: true },
  // ── Regional variants ──
  { code: "en-US" }, { code: "en-GB" }, { code: "en-AU" }, { code: "en-CA" },
  { code: "es-MX" }, { code: "es-AR" }, { code: "es-CO" },
  { code: "fr-CA" }, { code: "fr-CH" }, { code: "fr-BE" },
  { code: "de-AT" }, { code: "de-CH" },
  { code: "pt-PT" },
  { code: "nl" }, { code: "nl-BE" },
  { code: "zh-HK" },
  // ── Nordic / Baltic ──
  { code: "sv" }, { code: "no" }, { code: "nb" }, { code: "da" }, { code: "fi" }, { code: "is" },
  { code: "et" }, { code: "lt" }, { code: "lv" },
  // ── Central / Eastern Europe ──
  { code: "pl" }, { code: "cs" }, { code: "sk" }, { code: "hu" }, { code: "ro" },
  { code: "bg" }, { code: "hr" }, { code: "sr" }, { code: "sl" }, { code: "uk" }, { code: "el" },
  // ── Middle East / South Asia ──
  { code: "he" }, { code: "fa" }, { code: "ur" },
  { code: "bn" }, { code: "ta" }, { code: "te" }, { code: "ml" }, { code: "mr" }, { code: "gu" }, { code: "pa" },
  // ── SE Asia ──
  { code: "id" }, { code: "ms" }, { code: "th" }, { code: "vi" }, { code: "fil" },
  // ── Africa ──
  { code: "sw" }, { code: "am" }, { code: "ha" }, { code: "yo" },
  // ── Other ──
  { code: "ca" }, { code: "eu" }, { code: "gl" }, { code: "cy" }, { code: "ga" },
];

// ───────────────────────── Root component ─────────────────────────

export const LocalizationTab = component(() => {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-rv-bg">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        <Header />
        <LanguagesBar />
        <StringsPanel />
      </div>
    </div>
  );
});

// ───────────────────────── Header + Save ─────────────────────────

const Header = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const status = vm.autosaveStatus;
  const dirty = vm.isDirty;
  const saving = status === "saving";
  const errored = status === "error";

  // Brief "saved just now" pulse after an explicit save.
  const [justSaved, setJustSaved] = useState(false);
  const lastTickRef = useRef(vm.lastSavedAt);
  useEffect(() => {
    if (vm.lastSavedAt && vm.lastSavedAt !== lastTickRef.current) {
      lastTickRef.current = vm.lastSavedAt;
      setJustSaved(true);
      const t = setTimeout(() => setJustSaved(false), 1500);
      return () => clearTimeout(t);
    }
  }, [vm.lastSavedAt]);

  const disabled = saving || (!dirty && !errored);
  const label = saving
    ? "Saving…"
    : errored
      ? "Retry save"
      : dirty
        ? "Save changes"
        : justSaved
          ? "Saved"
          : "Saved";

  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600">
          <Globe2 size={16} />
        </div>
        <div>
          <h1 className="text-[15px] font-semibold text-foreground">Localization</h1>
          <p className="mt-0.5 text-[12px] text-rv-mute-600">
            Translate every string in your funnel side-by-side. Add the languages you ship in below.
          </p>
        </div>
      </div>

      <Button
        variant={errored ? "danger-soft" : "primary"}
        size="sm"
        isDisabled={disabled}
        onPress={() => vm.saveNow()}
        className="h-9 gap-1.5"
      >
        {saving ? (
          <Loader2 size={13} className="animate-spin" aria-hidden />
        ) : errored ? (
          <AlertTriangle size={13} aria-hidden />
        ) : dirty ? (
          <Save size={13} aria-hidden />
        ) : (
          <Check size={13} aria-hidden />
        )}
        {label}
      </Button>
    </div>
  );
});

// ───────────────────────── Languages bar ─────────────────────────

const LanguagesBar = component(() => {
  const vm = useService(FunnelDraftViewModel);
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
          Languages · {vm.locales.length}
        </h2>
        <span className="text-[11px] text-rv-mute-500">
          Click a chip to translate it. Default is the fallback for missing values.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {vm.locales.map((loc) => (
          <LanguageChip key={loc} code={loc} />
        ))}
        <AddLanguageButton />
      </div>
    </section>
  );
});

const LanguageChip = component(({ code }: { code: LocaleCode }) => {
  const vm = useService(FunnelDraftViewModel);
  const isDefault = code === vm.defaultLocale;
  const isActive = code === vm.editLocale;
  return (
    <div
      className={cn(
        "group inline-flex h-8 items-center gap-1.5 rounded-full border pl-2.5 pr-1 transition",
        isActive
          ? "border-rv-accent-500/60 bg-rv-accent-500/10 text-foreground"
          : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:bg-rv-c3 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={() => vm.setEditLocale(code)}
        className="flex cursor-pointer items-center gap-1.5 pr-1 text-left"
        title={`Translate ${localeFullName(code)}`}
      >
        {isDefault && (
          <Star size={11} className="text-rv-warning" aria-hidden fill="currentColor" />
        )}
        <span className="font-rv-mono text-[11px] uppercase">{code}</span>
        <span className="text-[11px] text-rv-mute-500 group-hover:text-rv-mute-700">
          {localeBaseName(code)}
        </span>
      </button>

      {!isDefault && (
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => vm.setDefaultLocale(code)}
            title="Make default"
            aria-label={`Make ${code} default`}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-rv-mute-500 hover:bg-rv-c4 hover:text-rv-warning"
          >
            <Star size={11} />
          </button>
          <button
            type="button"
            onClick={() => vm.removeLocale(code)}
            title="Remove language"
            aria-label={`Remove ${code}`}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-rv-mute-500 hover:bg-rv-danger/15 hover:text-rv-danger"
          >
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  );
});

const AddLanguageButton = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const existing = new Set(vm.locales);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = PRESETS.filter((p) => !existing.has(p.code));
    if (!q) {
      // Bubble "common" languages to the top.
      return [...items].sort((a, b) => {
        if (Boolean(a.common) !== Boolean(b.common)) return a.common ? -1 : 1;
        return a.code.localeCompare(b.code);
      });
    }
    return items.filter((p) => {
      const name = localeFullName(p.code).toLowerCase();
      return p.code.toLowerCase().includes(q) || name.includes(q);
    });
  }, [query, existing]);

  // Allow adding a raw BCP47 tag the user typed that isn't in the preset list.
  const freeFormCandidate = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    if (existing.has(q)) return null;
    if (!BCP47.test(q)) return null;
    if (PRESETS.some((p) => p.code === q)) return null;
    return q;
  }, [query, existing]);

  const add = (code: LocaleCode) => {
    vm.addLocale(code);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[0]) add(filtered[0].code);
      else if (freeFormCandidate) add(freeFormCandidate);
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 cursor-pointer items-center gap-1 rounded-full border border-dashed px-2.5 transition",
          open
            ? "border-rv-accent-500 bg-rv-accent-500/10 text-foreground"
            : "border-rv-divider bg-transparent text-rv-mute-600 hover:border-rv-mute-500 hover:text-foreground",
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Plus size={12} aria-hidden />
        <span className="text-[12px] font-medium">Add language</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          className="absolute left-0 top-full z-50 mt-1.5 w-[320px] overflow-hidden rounded-lg border border-rv-divider-strong bg-rv-c1 shadow-[0_18px_44px_rgba(0,0,0,0.5)]"
        >
          <div className="border-b border-rv-divider p-2">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-rv-mute-500"
                aria-hidden
              />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search language or code…"
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 pl-7 pr-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              />
            </div>
          </div>
          <div role="listbox" className="max-h-[260px] overflow-y-auto p-1">
            {filtered.length === 0 && !freeFormCandidate && (
              <div className="px-3 py-6 text-center text-[11px] text-rv-mute-500">
                No matches. Try a BCP47 code like <span className="font-rv-mono">pt-BR</span>.
              </div>
            )}

            {freeFormCandidate && (
              <button
                type="button"
                onClick={() => add(freeFormCandidate)}
                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-rv-c2"
              >
                <span className="flex items-center gap-2">
                  <Plus size={12} className="text-rv-accent-500" />
                  <span className="font-rv-mono text-[11px] uppercase text-foreground">
                    {freeFormCandidate}
                  </span>
                  <span className="text-[11px] text-rv-mute-500">Add custom tag</span>
                </span>
              </button>
            )}

            {filtered.map((p) => (
              <button
                key={p.code}
                type="button"
                onClick={() => add(p.code)}
                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-rv-c2"
                role="option"
              >
                <span className="flex items-center gap-2">
                  <span className="inline-flex min-w-[52px] justify-center rounded bg-rv-c3 px-1.5 py-0.5 font-rv-mono text-[10px] uppercase text-rv-mute-700">
                    {p.code}
                  </span>
                  <span className="text-[12px] text-foreground">{localeFullName(p.code)}</span>
                </span>
                {p.common && (
                  <span className="font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                    Common
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

// ───────────────────────── Strings panel ─────────────────────────

type StringEntry = {
  id: string;
  pageId: string;
  pageLabel: string;
  fieldLabel: string;
  get: (loc: LocaleCode) => string;
  set: (loc: LocaleCode, value: string) => void;
};

function pageHeading(page: Page, idx: number): string {
  const meta = PAGE_TYPES[page.type];
  const label = meta ? meta.label : page.type;
  return `P${idx + 1} · ${label}`;
}

const SCALAR_FIELDS = [
  "title",
  "subtitle",
  "body",
  "cta",
  "headline",
  "placeholder",
  "suffix",
  "agreementLabel",
] as const satisfies readonly (keyof Page)[];

const ARRAY_FIELDS = ["benefits", "features", "steps"] as const satisfies readonly (keyof Page)[];

function extractEntries(
  vm: FunnelDraftViewModel,
  defaultLocale: LocaleCode,
): StringEntry[] {
  const out: StringEntry[] = [];

  vm.pages.forEach((page, pageIdx) => {
    const pageLabel = pageHeading(page, pageIdx);

    for (const field of SCALAR_FIELDS) {
      if (page[field] === undefined) continue;
      out.push({
        id: `${page.id}.${field}`,
        pageId: page.id,
        pageLabel,
        fieldLabel: field,
        get: (loc) => (page[field] as Localized<string> | undefined)?.[loc] ?? "",
        set: (loc, value) => {
          const current = (page[field] as Localized<string> | undefined) ?? {};
          vm.updatePage(page.id, { [field]: { ...current, [loc]: value } } as Partial<Page>);
        },
      });
    }

    for (const field of ARRAY_FIELDS) {
      const v = page[field] as Localized<string[]> | undefined;
      if (!v) continue;
      const defaultArr = v[defaultLocale] ?? [];
      defaultArr.forEach((_, idx) => {
        out.push({
          id: `${page.id}.${field}.${idx}`,
          pageId: page.id,
          pageLabel,
          fieldLabel: `${field}[${idx}]`,
          get: (loc) =>
            (page[field] as Localized<string[]> | undefined)?.[loc]?.[idx] ?? "",
          set: (loc, value) => {
            const current = (page[field] as Localized<string[]> | undefined) ?? {};
            const next = [...(current[loc] ?? [])];
            while (next.length <= idx) next.push("");
            next[idx] = value;
            vm.updatePage(page.id, { [field]: { ...current, [loc]: next } } as Partial<Page>);
          },
        });
      });
    }

    (page.options ?? []).forEach((opt, idx) => {
      out.push({
        id: `${page.id}.option.${idx}`,
        pageId: page.id,
        pageLabel,
        fieldLabel: `option · ${opt.value || idx}`,
        get: (loc) => opt.label?.[loc] ?? "",
        set: (loc, value) => {
          const current = opt.label ?? {};
          vm.updateOption(page.id, idx, {
            label: { ...current, [loc]: value },
          } as unknown as { label?: string });
        },
      });
    });
  });

  return out;
}

const StringsPanel = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);

  const editLocale = vm.editLocale;
  const defaultLocale = vm.defaultLocale;
  const showSingleColumn = editLocale === defaultLocale;
  const hasOtherLocale = vm.locales.length > 1;

  const entries = extractEntries(vm, defaultLocale);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (q) {
        const hay = [e.pageLabel, e.fieldLabel, e.get(defaultLocale), e.get(editLocale)]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (onlyMissing) {
        const v = e.get(editLocale);
        if (v && v.trim() !== "") return false;
      }
      return true;
    });
  }, [entries, query, onlyMissing, editLocale, defaultLocale]);

  const missingCount = useMemo(() => {
    if (showSingleColumn) return 0;
    return entries.reduce((n, e) => {
      const v = e.get(editLocale);
      return n + (v && v.trim() !== "" ? 0 : 1);
    }, 0);
  }, [entries, editLocale, showSingleColumn]);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
          Strings
        </h2>
        <span className="text-[11px] text-rv-mute-500">
          {filtered.length} of {entries.length}
          {!showSingleColumn && (
            <>
              {" · "}
              <span className={cn(missingCount > 0 && "text-rv-warning")}>
                {missingCount} missing in <span className="font-rv-mono uppercase">{editLocale}</span>
              </span>
            </>
          )}
        </span>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-rv-mute-500"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by page, field, or value…"
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 pl-8 pr-2.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
          />
        </div>
        <button
          type="button"
          onClick={() => setOnlyMissing((v) => !v)}
          disabled={showSingleColumn}
          className={cn(
            "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition",
            onlyMissing
              ? "border-rv-warning/40 bg-rv-warning/15 text-rv-warning"
              : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:bg-rv-c3",
            showSingleColumn && "cursor-not-allowed opacity-40 hover:bg-rv-c2",
          )}
          aria-pressed={onlyMissing}
        >
          <Filter size={12} aria-hidden />
          Show only missing
        </button>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="w-[210px] border-b border-rv-divider px-3 py-2.5 text-left font-rv-mono text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                String
              </th>
              <th className="border-b border-rv-divider px-3 py-2.5 text-left font-rv-mono text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                <span className="uppercase">{defaultLocale}</span>{" "}
                <span className="ml-1 normal-case text-rv-mute-600">(default)</span>
              </th>
              {!showSingleColumn && (
                <th className="border-b border-rv-divider px-3 py-2.5 text-left font-rv-mono text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                  <span className="uppercase">{editLocale}</span>{" "}
                  <span className="ml-1 normal-case text-rv-mute-600">(editing)</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => {
              const defVal = e.get(defaultLocale);
              const editVal = showSingleColumn ? defVal : e.get(editLocale);
              const isMissing = !showSingleColumn && (!editVal || editVal.trim() === "");
              return (
                <tr
                  key={e.id}
                  className="border-b border-rv-divider last:border-b-0 hover:bg-rv-c2/30"
                >
                  <td className="px-3 py-2 align-top">
                    <button
                      type="button"
                      onClick={() => {
                        vm.selectPage(e.pageId);
                        vm.setActiveTab("content");
                      }}
                      className="block w-full cursor-pointer text-left"
                      title="Jump to this page in Content tab"
                    >
                      <div className="font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                        {e.pageLabel}
                      </div>
                      <div className="mt-0.5 text-[12px] text-foreground">
                        {e.fieldLabel}
                      </div>
                    </button>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      type="text"
                      value={defVal}
                      onChange={(ev) => e.set(defaultLocale, ev.target.value)}
                      placeholder="—"
                      className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                    />
                  </td>
                  {!showSingleColumn && (
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={editVal}
                        onChange={(ev) => e.set(editLocale, ev.target.value)}
                        placeholder={defVal || "—"}
                        className={cn(
                          "h-8 w-full rounded border bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500",
                          isMissing
                            ? "border-rv-warning/40 placeholder:text-rv-warning/60"
                            : "border-rv-divider placeholder:text-rv-mute-500",
                        )}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {entries.length === 0 && (
          <div className="px-6 py-12 text-center text-[12px] text-rv-mute-500">
            No localizable strings yet. Add some pages with content in the Content tab.
          </div>
        )}
        {entries.length > 0 && filtered.length === 0 && (
          <div className="px-6 py-12 text-center text-[12px] text-rv-mute-500">
            No matches for your filter.
          </div>
        )}
      </div>

      {!hasOtherLocale && (
        <p className="mt-3 text-[11px] text-rv-mute-500">
          You only have one language. Add another one above to translate every string side-by-side.
        </p>
      )}
    </section>
  );
});
