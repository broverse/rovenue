import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui-components/react/popover";
import { Tag } from "lucide-react";
import type { ProductTypeName } from "@rovenue/shared";
import { Button, buttonVariants } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../lib/cn";
import type { ProductStoreFilter } from "../../lib/hooks/useProjectProducts";

export type FilterValue = {
  types: ReadonlyArray<ProductTypeName>;
  stores: ReadonlyArray<ProductStoreFilter>;
};

type Props = {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
};

const TYPE_ORDER: ReadonlyArray<ProductTypeName> = [
  "SUBSCRIPTION",
  "CONSUMABLE",
  "NON_CONSUMABLE",
];

const STORE_ORDER: ReadonlyArray<ProductStoreFilter> = ["ios", "android", "web"];

/**
 * Popover-backed multiselect over (type, store). Edits are kept in a draft
 * until "Apply" so the user can adjust both axes without watching the table
 * re-fetch on every checkbox tick.
 */
export function FilterPopover({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FilterValue>(value);

  const activeCount = value.types.length + value.stores.length;

  const handleOpen = (next: boolean) => {
    if (next) setDraft(value);
    setOpen(next);
  };

  const apply = () => {
    onChange(draft);
    setOpen(false);
  };

  const clear = () => {
    const empty: FilterValue = { types: [], stores: [] };
    setDraft(empty);
    onChange(empty);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpen}>
      <Popover.Trigger
        className={cn(
          buttonVariants({ variant: "flat", size: "sm" }),
          activeCount > 0 && "border-rv-accent-500 text-rv-accent-500",
        )}
      >
        <Tag size={13} />
        {t("products.toolbar.filter")}
        {activeCount > 0 && (
          <span className="ml-0.5 rounded-md bg-rv-accent-500/[0.15] px-1 py-0.5 font-rv-mono text-[10px] leading-none">
            {activeCount}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className="w-[280px] rounded-lg border border-rv-divider-strong bg-rv-c3 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            <div className="border-b border-rv-divider p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("products.filter.typeHeading")}
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {TYPE_ORDER.map((type) => (
                  <CheckRow
                    key={type}
                    label={t(`products.filter.types.${type}`)}
                    checked={draft.types.includes(type)}
                    onToggle={() =>
                      setDraft((d) => ({
                        ...d,
                        types: d.types.includes(type)
                          ? d.types.filter((x) => x !== type)
                          : [...d.types, type],
                      }))
                    }
                  />
                ))}
              </div>
            </div>

            <div className="border-b border-rv-divider p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("products.filter.storeHeading")}
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {STORE_ORDER.map((store) => (
                  <CheckRow
                    key={store}
                    label={t(`products.filter.stores.${store}`)}
                    checked={draft.stores.includes(store)}
                    onToggle={() =>
                      setDraft((d) => ({
                        ...d,
                        stores: d.stores.includes(store)
                          ? d.stores.filter((x) => x !== store)
                          : [...d.stores, store],
                      }))
                    }
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 p-2.5">
              <Button variant="light" size="sm" onClick={clear} type="button">
                {t("products.filter.clear")}
              </Button>
              <Button variant="solid-primary" size="sm" onClick={apply} type="button">
                {t("products.filter.apply")}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CheckRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] text-foreground hover:bg-rv-c4">
      <Checkbox checked={checked} onChange={onToggle} ariaLabel={label} />
      <span>{label}</span>
    </label>
  );
}
