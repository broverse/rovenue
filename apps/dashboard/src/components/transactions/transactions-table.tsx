import { useTranslation } from "react-i18next";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../lib/cn";
import { TransactionRow } from "./transaction-row";
import { TransactionsPaginator } from "./transactions-paginator";
import type { Transaction } from "./types";

const COLUMNS = [
  { key: "transaction", align: "left" as const },
  { key: "userSubscription", align: "left" as const },
  { key: "product", align: "left" as const },
  { key: "store", align: "left" as const },
  { key: "gross", align: "right" as const },
  { key: "fee", align: "right" as const },
  { key: "net", align: "right" as const },
  { key: "status", align: "left" as const },
  { key: "when", align: "right" as const },
];

type Props = {
  transactions: ReadonlyArray<Transaction>;
  selectedIds: ReadonlySet<string>;
  activeId: string | null;
  total: number;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onOpen: (id: string) => void;
};

export function TransactionsTable({
  transactions,
  selectedIds,
  activeId,
  total,
  onToggleSelect,
  onToggleSelectAll,
  onOpen,
}: Props) {
  const { t } = useTranslation();
  const allChecked = transactions.length > 0 && transactions.every((t) => selectedIds.has(t.id));
  const someChecked = !allChecked && transactions.some((t) => selectedIds.has(t.id));

  return (
    <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="w-7 px-3 py-2.5 text-left">
                <Checkbox
                  checked={allChecked}
                  indeterminate={someChecked}
                  onChange={onToggleSelectAll}
                  ariaLabel={t("transactions.table.selectAllAria")}
                />
              </th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "whitespace-nowrap border-b border-rv-divider bg-transparent px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
                    col.align === "right" ? "text-right" : "text-left",
                  )}
                >
                  {t(`transactions.table.${col.key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                selected={selectedIds.has(tx.id)}
                active={activeId === tx.id}
                onToggleSelected={() => onToggleSelect(tx.id)}
                onOpen={() => onOpen(tx.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <TransactionsPaginator
        visible={transactions.length}
        total={total}
        page={1}
        totalPages={4}
        onPageChange={() => {}}
      />
    </div>
  );
}
