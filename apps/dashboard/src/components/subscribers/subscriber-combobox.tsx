import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "../../lib/cn";
import { useSubscribers } from "../../lib/hooks/useSubscribers";

type Row = {
  id: string;
  appUserId: string | null;
};

type Props = {
  projectId: string;
  /** Selected subscriber id (the cuid2 "Rovenue ID"), or "" when none. */
  value: string;
  onChange: (subscriberId: string) => void;
  /** Forwarded to the input for label association. */
  id?: string;
  disabled?: boolean;
};

/**
 * Searchable subscriber picker (combobox) for the grant flows.
 *
 * Typing drives a debounced server-side search — the API matches the
 * query against appUserId, rovenueId, and the subscriber id, so the
 * customer can be found by user ID or Rovenue ID. Results render in an
 * inline panel (rather than a portalled popover) so focus stays in the
 * input and the panel is never clipped by the modal's scroll container.
 */
export function SubscriberCombobox({
  projectId,
  value,
  onChange,
  id,
  disabled,
}: Props) {
  const { t } = useTranslation();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Mirror an external clear (e.g. the modal resetting on open) back
  // into the visible input.
  useEffect(() => {
    if (!value) setQuery("");
  }, [value]);

  const subscribersQuery = useSubscribers({
    projectId,
    q: debounced || undefined,
    limit: 50,
  });
  const rows: Row[] = useMemo(
    () =>
      subscribersQuery.data?.pages.flatMap((p) =>
        p.subscribers.map((s) => ({ id: s.id, appUserId: s.appUserId })),
      ) ?? [],
    [subscribersQuery.data],
  );
  const loading = subscribersQuery.isPending;

  const handleChange = (v: string) => {
    setQuery(v);
    setOpen(true);
    // Editing the text invalidates any committed selection so we never
    // submit an id that doesn't match what the user sees.
    if (value) onChange("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebounced(v), 200);
  };

  const select = (r: Row) => {
    onChange(r.id);
    setQuery(r.appUserId || r.id);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  };

  // Close on outside click (we don't close on blur so option clicks
  // register first).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Keep the highlighted option in range as the result set changes.
  useEffect(() => {
    setActiveIndex((i) =>
      rows.length === 0 ? -1 : Math.min(Math.max(i, -1), rows.length - 1),
    );
  }, [rows]);

  // Scroll the highlighted option into view during keyboard nav.
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setOpen(true);
        setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        if (open && activeIndex >= 0 && rows[activeIndex]) {
          e.preventDefault();
          select(rows[activeIndex]!);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
    }
  };

  const activeOptionId =
    open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-rv-mute-500"
        />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={query}
          placeholder={t(
            "subscribers.picker.search",
            "Search by user ID or Rovenue ID…",
          )}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            "w-full rounded-md border border-rv-divider bg-rv-c2 pl-8 pr-9 py-2 text-[13px] text-foreground transition",
            "placeholder:text-rv-mute-500 focus:border-rv-accent-500 focus:outline-none focus:ring-2 focus:ring-rv-accent-500/30",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
        <ChevronDown
          size={16}
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-rv-mute-500 transition-transform",
            open && "rotate-180",
          )}
        />
      </div>

      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-rv-divider-strong bg-rv-c2 py-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] animate-rv-menu-in"
        >
          {loading ? (
            <div className="px-3 py-2 text-[12px] text-rv-mute-500">
              {t("common.loading")}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-rv-mute-500">
              {t("subscribers.picker.empty", "No subscribers found.")}
            </div>
          ) : (
            rows.map((r, i) => {
              const selected = r.id === value;
              const active = i === activeIndex;
              return (
                <div
                  key={r.id}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={selected}
                  data-active={active}
                  // Keep focus in the input so typing continues to work.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => select(r)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5",
                    active ? "bg-rv-c4" : "hover:bg-rv-c3",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-foreground">
                      {r.appUserId ?? (
                        <span className="italic text-rv-mute-500">
                          {t("subscribers.picker.noUserId", "No user ID")}
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-rv-mono text-[11px] text-rv-mute-500">
                      {r.id}
                    </span>
                  </span>
                  {selected && (
                    <Check
                      size={14}
                      aria-hidden
                      className="shrink-0 text-rv-accent-500"
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
