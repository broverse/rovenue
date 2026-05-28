import { useState } from "react";
import type { LocaleCode } from "@rovenue/shared/i18n";

interface Props {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
  editLocale: LocaleCode;
  onSelect: (locale: LocaleCode) => void;
  onAdd: (locale: LocaleCode) => void;
  onRemove: (locale: LocaleCode) => void;
}

const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/;

export function LocaleSwitcher(props: Props) {
  const { defaultLocale, locales, editLocale, onSelect, onAdd, onRemove } = props;
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submitAdd = () => {
    const code = draft.trim();
    if (!BCP47.test(code)) return;
    if (locales.includes(code)) {
      setAdding(false);
      setDraft("");
      return;
    }
    onAdd(code);
    setAdding(false);
    setDraft("");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
        aria-label={editLocale}
      >
        <span>{editLocale}</span>
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-56 rounded-md border bg-white p-1 shadow-md">
          {locales.map((loc) => (
            <div key={loc} className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-100">
              <button
                type="button"
                className="flex-1 text-left"
                onClick={() => {
                  onSelect(loc);
                  setOpen(false);
                }}
              >
                <span>{loc}</span>
                {loc === defaultLocale && <span className="ml-2 text-[10px] uppercase opacity-60">default</span>}
              </button>
              {loc === editLocale && loc !== defaultLocale && (
                <button
                  type="button"
                  aria-label={`Remove ${loc}`}
                  onClick={() => {
                    onRemove(loc);
                    setOpen(false);
                  }}
                  className="text-xs opacity-60 hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          <div className="mt-1 border-t pt-1">
            {adding ? (
              <div className="flex gap-1 px-2 py-1">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="BCP47 (e.g. tr, pt-BR)"
                  className="flex-1 rounded border px-1 py-0.5 text-xs"
                />
                <button type="button" onClick={submitAdd} className="rounded bg-black px-2 py-0.5 text-xs text-white">
                  Add
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full rounded px-2 py-1 text-left text-sm hover:bg-gray-100"
              >
                + Add language
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
