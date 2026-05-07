import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../lib/cn";
import { IconBox, IconPlus } from "../dashboard/icons";
import { ProductRow } from "./product-row";
import type { Product, SortDir, SortKey } from "./types";

type Column = {
  key: SortKey | "duration" | "entitlements" | "stores" | "status" | "actions";
  label: string;
  /** Whether the column allows sorting. */
  sortable?: boolean;
  align?: "right";
  width?: string;
};

const COLUMNS: ReadonlyArray<Column> = [
  { key: "name", label: "Product", sortable: true },
  { key: "duration", label: "Duration" },
  { key: "group", label: "Group", sortable: true },
  { key: "entitlements", label: "Entitlements" },
  { key: "price", label: "Price", sortable: true, align: "right" },
  { key: "subs", label: "Subs", sortable: true, align: "right" },
  { key: "mrr", label: "MRR", sortable: true, align: "right" },
  { key: "stores", label: "Stores" },
  { key: "status", label: "Status" },
  { key: "updated", label: "Updated", sortable: true },
  { key: "actions", label: "" },
];

type Props = {
  products: ReadonlyArray<Product>;
  /** Currently-selected ids (for bulk actions). */
  selectedIds: ReadonlySet<string>;
  /** Id of the row currently open in the drawer. */
  activeId: string | null;
  sortKey: SortKey;
  sortDir: SortDir;
  /** Toggles selection of a single row. */
  onToggleSelect: (id: string) => void;
  /** Toggles selection of all currently-visible rows. */
  onToggleSelectAll: () => void;
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  onClearFilters: () => void;
};

export function ProductsTable({
  products,
  selectedIds,
  activeId,
  sortKey,
  sortDir,
  onToggleSelect,
  onToggleSelectAll,
  onSort,
  onOpen,
  onClearFilters,
}: Props) {
  const { t } = useTranslation();
  const allChecked = products.length > 0 && products.every((p) => selectedIds.has(p.id));
  const someChecked = !allChecked && products.some((p) => selectedIds.has(p.id));

  return (
    <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="w-7 px-3 py-2.5 text-left">
              <Checkbox
                checked={allChecked}
                indeterminate={someChecked}
                onChange={onToggleSelectAll}
                ariaLabel={t("products.table.selectAll")}
              />
            </th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={cn(
                  "whitespace-nowrap border-b border-rv-divider bg-transparent px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
                  col.align === "right" ? "text-right" : "text-left",
                  col.sortable && "cursor-pointer select-none hover:text-rv-mute-700",
                )}
                onClick={col.sortable ? () => onSort(col.key as SortKey) : undefined}
              >
                {col.label}
                {col.sortable && (
                  <span className="ml-1 inline-block w-3 opacity-70">
                    {sortKey === col.key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              selected={selectedIds.has(p.id)}
              active={activeId === p.id}
              onToggleSelected={() => onToggleSelect(p.id)}
              onOpen={() => onOpen(p.id)}
            />
          ))}
        </tbody>
      </table>

      {products.length === 0 && (
        <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-3 flex size-10 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
            <IconBox size={18} />
          </div>
          <h3 className="mb-1 text-[13px] font-semibold">{t("products.empty.title")}</h3>
          <p className="mb-3 max-w-[280px] text-[12px] text-rv-mute-500">
            {t("products.empty.body")}
          </p>
          <div className="flex gap-2">
            <Button variant="flat" size="sm" onClick={onClearFilters}>
              {t("products.empty.clear")}
            </Button>
            <Button variant="solid-primary" size="sm">
              <IconPlus size={13} />
              {t("products.actions.create")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
