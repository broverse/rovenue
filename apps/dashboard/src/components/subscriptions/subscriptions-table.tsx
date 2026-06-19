import { Fragment } from "react";
import { ChevronDown, ChevronRight, ChevronUp, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SubscriptionSortKey } from "@rovenue/shared";
import { Checkbox } from "../../ui/checkbox";
import { Chip } from "../../ui/chip";
import { cn } from "../../lib/cn";
import { UserAvatar } from "../subscribers/user-avatar";
import { CountdownCell } from "./countdown-cell";
import { ExpandedRow } from "./expanded-row";
import { LifecycleStrip } from "./lifecycle-strip";
import { StoreChip } from "./store-chip";
import { SubscriptionStatusChip } from "./subscription-status-chip";
import type { Subscription } from "./types";

export type SortColumn = "started" | "renews" | "price" | "status";

const COLUMN_KEYS: Record<
  SortColumn,
  {
    asc: SubscriptionSortKey;
    desc: SubscriptionSortKey;
    defaultDir: "asc" | "desc";
  }
> = {
  started: { asc: "started_asc", desc: "started_desc", defaultDir: "desc" },
  renews: { asc: "renews_asc", desc: "renews_desc", defaultDir: "asc" },
  price: { asc: "price_asc", desc: "price_desc", defaultDir: "desc" },
  status: { asc: "status", desc: "status", defaultDir: "asc" },
};

function currentColumn(sort: SubscriptionSortKey): SortColumn | null {
  for (const col of Object.keys(COLUMN_KEYS) as SortColumn[]) {
    if (COLUMN_KEYS[col].asc === sort || COLUMN_KEYS[col].desc === sort)
      return col;
  }
  return null;
}

function currentDirection(sort: SubscriptionSortKey): "asc" | "desc" {
  return sort.endsWith("_asc") ? "asc" : "desc";
}

export function nextSort(
  sort: SubscriptionSortKey,
  target: SortColumn,
): SubscriptionSortKey {
  const col = currentColumn(sort);
  if (col === target) {
    return currentDirection(sort) === "asc"
      ? COLUMN_KEYS[target].desc
      : COLUMN_KEYS[target].asc;
  }
  return COLUMN_KEYS[target].defaultDir === "asc"
    ? COLUMN_KEYS[target].asc
    : COLUMN_KEYS[target].desc;
}

type Props = {
  subscriptions: ReadonlyArray<Subscription>;
  selectedIds: ReadonlySet<string>;
  expandedId: string | null;
  sort: SubscriptionSortKey;
  onSortChange: (next: SubscriptionSortKey) => void;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onToggleExpand: (id: string) => void;
};

export function SubscriptionsTable({
  subscriptions,
  selectedIds,
  expandedId,
  sort,
  onSortChange,
  onToggleSelect,
  onToggleSelectAll,
  onToggleExpand,
}: Props) {
  const { t } = useTranslation();
  const allChecked =
    subscriptions.length > 0 &&
    subscriptions.every((s) => selectedIds.has(s.id));
  const someChecked =
    !allChecked && subscriptions.some((s) => selectedIds.has(s.id));
  const activeCol = currentColumn(sort);
  const activeDir = currentDirection(sort);

  return (
    <div className="overflow-x-auto rounded-lg border border-rv-divider bg-rv-c1">
      <table className="w-full min-w-[1100px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-rv-divider text-left">
            <th className="w-7 px-3 py-2.5" />
            <th className="w-8 px-3 py-2.5">
              <Checkbox
                checked={allChecked}
                indeterminate={someChecked}
                onChange={onToggleSelectAll}
                ariaLabel={t("subscriptions.table.selectAll")}
              />
            </th>
            <Th>{t("subscriptions.table.subscription")}</Th>
            <Th>{t("subscriptions.table.user")}</Th>
            <Th>{t("subscriptions.table.product")}</Th>
            <SortableTh
              label={t("subscriptions.table.status")}
              column="status"
              active={activeCol === "status"}
              direction={activeDir}
              onClick={() => onSortChange(nextSort(sort, "status"))}
            />
            <Th>{t("subscriptions.table.store")}</Th>
            <SortableTh
              label={t("subscriptions.table.price")}
              column="price"
              active={activeCol === "price"}
              direction={activeDir}
              align="right"
              onClick={() => onSortChange(nextSort(sort, "price"))}
            />
            <SortableTh
              label={t("subscriptions.table.term")}
              column="started"
              active={activeCol === "started"}
              direction={activeDir}
              onClick={() => onSortChange(nextSort(sort, "started"))}
            />
            <Th>{t("subscriptions.table.lifecycle")}</Th>
            <SortableTh
              label={t("subscriptions.table.nextEvent")}
              column="renews"
              active={activeCol === "renews"}
              direction={activeDir}
              onClick={() => onSortChange(nextSort(sort, "renews"))}
            />
          </tr>
        </thead>

        <tbody>
          {subscriptions.length === 0 && (
            <tr>
              <td colSpan={11} className="px-6 py-12 text-center">
                <p className="text-[13px] text-rv-mute-500">
                  {t("subscriptions.table.empty")}
                </p>
              </td>
            </tr>
          )}

          {subscriptions.map((sub) => {
            const isExpanded = expandedId === sub.id;
            return (
              <Fragment key={sub.id}>
                <tr
                  onClick={() => onToggleExpand(sub.id)}
                  className={cn(
                    "cursor-pointer border-b border-white/[0.03] transition hover:bg-rv-c2",
                    isExpanded && "bg-rv-c2",
                  )}
                >
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={t("subscriptions.table.toggleRow", {
                        defaultValue: "Toggle details",
                      })}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpand(sub.id);
                      }}
                      className={cn(
                        "inline-flex size-5 cursor-pointer items-center justify-center text-rv-mute-500 transition hover:text-foreground",
                        isExpanded && "rotate-90 text-rv-accent-400",
                      )}
                    >
                      <ChevronRight size={13} />
                    </button>
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(sub.id)}
                      onChange={() => onToggleSelect(sub.id)}
                      ariaLabel={t("subscriptions.table.selectRow", { id: sub.id })}
                    />
                  </td>

                  <td className="px-3 py-2.5">
                    <div className="font-rv-mono text-[12px] font-medium">{sub.id}</div>
                    <div className="font-rv-mono text-[10px] text-rv-mute-500">
                      {sub.autoRenew
                        ? t("subscriptions.table.autoRenew")
                        : t("subscriptions.table.manual")}
                      {sub.intro && ` · ${t("subscriptions.table.intro")}`}
                    </div>
                  </td>

                  <td className="px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2 font-rv-mono text-[12px]">
                      <UserAvatar fullId={sub.user} size="sm" className="size-[22px] text-[9px]" />
                      <span className="truncate">{sub.user}</span>
                    </div>
                  </td>

                  <td className="px-3 py-2.5 font-rv-mono text-[12px]">{sub.product}</td>

                  <td className="px-3 py-2.5">
                    <div className="inline-flex items-center gap-1">
                      <SubscriptionStatusChip status={sub.status} />
                      {sub.lastIssue && (
                        <Chip tone="danger" aria-label={sub.lastIssue}>!</Chip>
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2.5">
                    <StoreChip store={sub.store} />
                  </td>

                  <td className="px-3 py-2.5 text-right font-rv-mono text-[12px] tabular-nums">
                    ${sub.price.toFixed(2)}
                    <span className="ml-0.5 text-rv-mute-500">/{sub.billingCycle[0]}</span>
                  </td>

                  <td className="px-3 py-2.5 font-rv-mono text-[11px] text-rv-mute-600">
                    {sub.term}
                  </td>

                  <td className="px-3 py-2.5">
                    <LifecycleStrip pct={sub.renewsPct} hasIssue={!!sub.lastIssue} />
                  </td>

                  <td className="px-3 py-2.5">
                    <CountdownCell sub={sub} />
                  </td>
                </tr>

                {isExpanded && (
                  <tr className="border-y border-rv-divider bg-rv-c2">
                    <td colSpan={11} className="p-0">
                      <ExpandedRow sub={sub} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {subscriptions.length > 0 && (
        <div className="flex items-center justify-between border-t border-rv-divider px-3 py-2 text-[11px] text-rv-mute-500">
          <span className="inline-flex items-center gap-1.5 font-rv-mono">
            <RefreshCw size={11} className="text-rv-mute-500" />
            {t("subscriptions.table.footerHint")}
          </span>
          <span className="font-rv-mono">
            {t("subscriptions.table.rowCount", { count: subscriptions.length })}
          </span>
        </div>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-rv-divider px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

export function SortableTh({
  label,
  column,
  active,
  direction,
  align,
  onClick,
}: {
  label: string;
  column: SortColumn;
  active: boolean;
  direction: "asc" | "desc";
  align?: "right";
  onClick: () => void;
}) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-rv-divider px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" && "text-right",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`Sort by ${column}`}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 transition hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? (
          direction === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />
        ) : (
          <ChevronDown size={11} className="opacity-30" />
        )}
      </button>
    </th>
  );
}
