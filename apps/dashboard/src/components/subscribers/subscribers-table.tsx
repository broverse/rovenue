import { useTranslation } from "react-i18next";
import { Checkbox } from "../../ui/checkbox";
import { SubscriberRow } from "./subscriber-row";
import type { Subscriber } from "./types";

const COLUMNS = [
  { key: "user", align: "left" as const },
  { key: "rovenueId", align: "left" as const },
  { key: "plan", align: "left" as const },
  { key: "status", align: "left" as const },
  { key: "entitlements", align: "left" as const },
  { key: "country", align: "left" as const },
  { key: "platform", align: "left" as const },
  { key: "ltv", align: "right" as const },
  { key: "mrr", align: "right" as const },
  { key: "risk", align: "left" as const },
  { key: "lastActivity", align: "left" as const },
];

type Props = {
  subscribers: ReadonlyArray<Subscriber>;
  selectedIds: ReadonlySet<string>;
  activeId: string | null;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onOpen: (id: string) => void;
};

export function SubscribersTable({
  subscribers,
  selectedIds,
  activeId,
  onToggleSelect,
  onToggleSelectAll,
  onOpen,
}: Props) {
  const { t } = useTranslation();
  const allChecked =
    subscribers.length > 0 &&
    subscribers.every((s) => selectedIds.has(s.rovenueId));
  const someChecked =
    !allChecked && subscribers.some((s) => selectedIds.has(s.rovenueId));

  return (
    <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="w-7 px-3 py-2.5 text-left">
                <Checkbox
                  checked={allChecked}
                  indeterminate={someChecked}
                  onChange={onToggleSelectAll}
                  ariaLabel={t("subscribers.table.selectAllAria")}
                />
              </th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={`whitespace-nowrap border-b border-rv-divider bg-transparent px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500 ${col.align === "right" ? "text-right" : "text-left"}`}
                >
                  {t(`subscribers.table.${col.key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {subscribers.map((s, idx) => (
              <SubscriberRow
                key={s.rovenueId}
                subscriber={s}
                index={idx}
                selected={selectedIds.has(s.rovenueId)}
                active={activeId === s.rovenueId}
                onToggleSelected={() => onToggleSelect(s.rovenueId)}
                onOpen={() => onOpen(s.rovenueId)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
