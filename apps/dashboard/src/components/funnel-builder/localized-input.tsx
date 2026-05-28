import { useCallback } from "react";
import type { ChangeEvent, InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { Localized, LocaleCode } from "@rovenue/shared/i18n";

type Base<E extends HTMLElement> = {
  value: Localized<string> | undefined;
  editLocale: LocaleCode;
  defaultLocale: LocaleCode;
  onChange: (next: Localized<string>) => void;
  placeholder?: string;
} & Omit<InputHTMLAttributes<E> | TextareaHTMLAttributes<E>, "value" | "onChange" | "placeholder">;

function resolvePlaceholder(
  value: Localized<string> | undefined,
  editLocale: LocaleCode,
  defaultLocale: LocaleCode,
  fallback: string | undefined,
): string | undefined {
  if (editLocale === defaultLocale) return fallback;
  const def = value?.[defaultLocale];
  return def && def !== "" ? def : fallback;
}

function writeKey(
  value: Localized<string> | undefined,
  key: LocaleCode,
  next: string,
): Localized<string> {
  return { ...(value ?? {}), [key]: next };
}

export function LocalizedInput(
  props: Base<HTMLInputElement> & { type?: "text" | "url" | "email" },
) {
  const { value, editLocale, defaultLocale, onChange, placeholder, type = "text", ...rest } = props;
  const current = value?.[editLocale] ?? "";
  const handle = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onChange(writeKey(value, editLocale, e.target.value)),
    [value, editLocale, onChange],
  );
  return (
    <input
      {...(rest as InputHTMLAttributes<HTMLInputElement>)}
      type={type}
      value={current}
      placeholder={resolvePlaceholder(value, editLocale, defaultLocale, placeholder)}
      onChange={handle}
    />
  );
}

export function LocalizedTextarea(props: Base<HTMLTextAreaElement> & { rows?: number }) {
  const { value, editLocale, defaultLocale, onChange, placeholder, rows = 3, ...rest } = props;
  const current = value?.[editLocale] ?? "";
  const handle = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => onChange(writeKey(value, editLocale, e.target.value)),
    [value, editLocale, onChange],
  );
  return (
    <textarea
      {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
      rows={rows}
      value={current}
      placeholder={resolvePlaceholder(value, editLocale, defaultLocale, placeholder)}
      onChange={handle}
    />
  );
}

type ArrayBase = {
  value: Localized<string[]> | undefined;
  editLocale: LocaleCode;
  defaultLocale: LocaleCode;
  onChange: (next: Localized<string[]>) => void;
  placeholder?: string;
  className?: string;
};

export function LocalizedArrayInput(props: ArrayBase) {
  const { value, editLocale, defaultLocale, onChange, placeholder, className } = props;
  const items = value?.[editLocale] ?? [];
  const setItems = (next: string[]) =>
    onChange({ ...(value ?? {}), [editLocale]: next });

  return (
    <div className={className}>
      {items.map((item, i) => (
        <input
          key={i}
          value={item}
          placeholder={resolvePlaceholder(
            value as Localized<string> | undefined,
            editLocale,
            defaultLocale,
            placeholder,
          )}
          onChange={(e) => {
            const next = [...items];
            next[i] = e.target.value;
            setItems(next);
          }}
        />
      ))}
      <button type="button" onClick={() => setItems([...items, ""])}>+ Add</button>
    </div>
  );
}
