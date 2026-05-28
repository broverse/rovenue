import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
} from "@heroui/react";
import { ChevronDown, Languages, Settings2 } from "lucide-react";
import type { LocaleCode } from "@rovenue/shared/i18n";
import { cn } from "../../lib/cn";

interface Props {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
  editLocale: LocaleCode;
  onSelect: (locale: LocaleCode) => void;
  onManage: () => void;
}

function localeName(code: LocaleCode): string {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
}

const MANAGE_KEY = "__manage__";

export function LocaleSwitcher(props: Props) {
  const { defaultLocale, locales, editLocale, onSelect, onManage } = props;

  return (
    <Dropdown>
      <DropdownTrigger
        aria-label={`Edit language: ${editLocale}`}
        className={cn(
          "inline-flex h-7 cursor-pointer items-center gap-1.5",
          "rounded-md border border-rv-divider bg-rv-c2 px-2",
          "font-rv-mono text-[11px] uppercase text-foreground",
          "transition hover:bg-rv-c3 focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500",
        )}
      >
        <Languages size={13} className="text-rv-mute-500" aria-hidden />
        <span>{editLocale}</span>
        <ChevronDown size={12} className="text-rv-mute-500" aria-hidden />
      </DropdownTrigger>
      <DropdownPopover
        placement="bottom end"
        className="min-w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1 shadow-[0_18px_44px_rgba(0,0,0,0.5)]"
      >
        <DropdownMenu
          aria-label="Switch edit language"
          selectionMode="single"
          selectedKeys={new Set([editLocale])}
          disallowEmptySelection
          onAction={(key) => {
            const k = String(key);
            if (k === MANAGE_KEY) {
              onManage();
              return;
            }
            onSelect(k);
          }}
          className="flex flex-col gap-0.5"
        >
          {[
            ...locales.map((loc) => (
              <DropdownItem
                key={loc}
                id={loc}
                textValue={loc}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5",
                  "text-[12px] text-foreground outline-none",
                  "data-[hovered=true]:bg-rv-c2 data-[focused=true]:bg-rv-c2",
                  "data-[selected=true]:bg-rv-c2",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="font-rv-mono text-[11px] uppercase">{loc}</span>
                  <span className="text-rv-mute-600">{localeName(loc)}</span>
                </span>
                {loc === defaultLocale && (
                  <span className="font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                    Default
                  </span>
                )}
              </DropdownItem>
            )),
            <DropdownItem
              key={MANAGE_KEY}
              id={MANAGE_KEY}
              textValue="Manage languages"
              className={cn(
                "mt-0.5 flex cursor-pointer items-center gap-2 rounded border-t border-rv-divider px-2 pt-2 pb-1.5",
                "text-[12px] text-rv-mute-700 outline-none",
                "data-[hovered=true]:bg-rv-c2 data-[focused=true]:bg-rv-c2",
              )}
            >
              <Settings2 size={13} aria-hidden />
              <span>Manage languages…</span>
            </DropdownItem>,
          ]}
        </DropdownMenu>
      </DropdownPopover>
    </Dropdown>
  );
}
