import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { EntitlementChip } from "../products/entitlement-chip";
import { ChevronsUpDown, Key, MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/cn";
import { ActivityTimeline } from "./activity-timeline";
import { COUNTRIES } from "./mock-data";
import { formatLtv, formatMoney, riskColor } from "./format";
import { SubscriberStatusChip } from "./subscriber-status-chip";
import { UserAvatar } from "./user-avatar";
import type { Subscriber, TimelineEntry } from "./types";

type DetailTab = "activity" | "subs" | "entitlements";

type Props = {
  subscriber: Subscriber;
  timeline: ReadonlyArray<TimelineEntry>;
};

/**
 * Sticky right-rail panel. Shows the selected user's headline info + KPI
 * strip + tabbed content (activity / subscription / entitlements) and a
 * footer of grant/refund actions.
 */
export function SubscriberDetailPanel({ subscriber, timeline }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DetailTab>("activity");
  const country = COUNTRIES[subscriber.country];

  return (
    <aside className="sticky top-[76px] overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-center gap-3 border-b border-rv-divider p-4">
        <UserAvatar fullId={subscriber.full} size="lg" vip={subscriber.vip} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-rv-mono text-[13px] font-medium text-foreground">
              {subscriber.full}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-rv-mute-500">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-3.5 shrink-0 rounded-[1px] border border-white/10"
              style={{ background: country.flag }}
            />
            {country.name} ·
            <SubscriberStatusChip status={subscriber.status} />
          </div>
        </div>
        <Button variant="light" size="icon" aria-label={t("subscribers.panel.actions.more")}>
          <MoreHorizontal size={14} />
        </Button>
      </div>

      <div className="grid grid-cols-3 border-b border-rv-divider">
        <KpiCell label={t("subscribers.table.ltv")} value={formatLtv(subscriber.ltv)} />
        <KpiCell label={t("subscribers.table.mrr")} value={formatMoney(subscriber.mrr)} />
        <KpiCell
          label={t("subscribers.table.risk")}
          value={String(subscriber.risk)}
          valueStyle={{ color: riskColor(subscriber.risk) }}
          isLast
        />
      </div>

      <div role="tablist" className="flex border-b border-rv-divider">
        <DetailTabBtn active={tab === "activity"} onClick={() => setTab("activity")}>
          {t("subscribers.panel.tabs.activity")}
          <span className="ml-1 font-rv-mono text-[10px] text-rv-mute-500">
            {timeline.length}
          </span>
        </DetailTabBtn>
        <DetailTabBtn active={tab === "subs"} onClick={() => setTab("subs")}>
          {t("subscribers.panel.tabs.subs")}
          <span className="ml-1 font-rv-mono text-[10px] text-rv-mute-500">1</span>
        </DetailTabBtn>
        <DetailTabBtn active={tab === "entitlements"} onClick={() => setTab("entitlements")}>
          {t("subscribers.panel.tabs.entitlements")}
          <span className="ml-1 font-rv-mono text-[10px] text-rv-mute-500">
            {subscriber.entitlements.length}
          </span>
        </DetailTabBtn>
      </div>

      {tab === "activity" && (
        <>
          <SectionHeading>{t("subscribers.panel.lastEvents")}</SectionHeading>
          <ActivityTimeline entries={timeline} />
        </>
      )}

      {tab === "subs" && (
        <div className="flex flex-col gap-2 px-4 pb-4 pt-2">
          <div className="rounded-md border border-rv-divider bg-rv-c2 p-3">
            <div className="mb-2 flex items-start justify-between">
              <div>
                <div className="font-rv-mono text-[12px] font-semibold">
                  {subscriber.product}
                </div>
                <div className="mt-0.5 text-[11px] text-rv-mute-500">
                  {t("subscribers.panel.viaStore", {
                    store: t("subscribers.panel.stores.appStore"),
                  })}
                </div>
              </div>
              <SubscriberStatusChip status={subscriber.status} />
            </div>
            <Kv k={t("subscribers.panel.kv.started")} v={subscriber.created} />
            <Kv k={t("subscribers.panel.kv.renews")} v={subscriber.renew} />
            <Kv k={t("subscribers.panel.kv.price")} v={"$79.99"} />
            <Kv
              k={t("subscribers.panel.kv.storeId")}
              v="tx_1Ow9…k8Q"
              vClassName="text-[10px]"
            />
          </div>
        </div>
      )}

      {tab === "entitlements" && (
        <div className="flex flex-col gap-2 px-4 pb-4 pt-2">
          {subscriber.entitlements.length === 0 ? (
            <div className="py-5 text-center text-[12px] text-rv-mute-500">
              {t("subscribers.panel.noGrants")}
            </div>
          ) : (
            subscriber.entitlements.map((e) => (
              <div
                key={e}
                className="flex items-center justify-between border-b border-rv-divider py-2 last:border-b-0"
              >
                <EntitlementChip>
                  <Key size={9} />
                  {e}
                </EntitlementChip>
                <span className="text-[11px] text-rv-mute-500">
                  {t("subscribers.panel.viaProduct", { product: subscriber.product })}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      <div className="flex gap-1.5 border-t border-rv-divider p-3">
        <Button variant="flat" size="sm" className="flex-1 justify-center">
          <Key size={13} />
          {t("subscribers.panel.actions.grant")}
        </Button>
        <Button variant="flat" size="sm" className="flex-1 justify-center">
          <ChevronsUpDown size={13} />
          {t("subscribers.panel.actions.refund")}
        </Button>
        <Button variant="flat" size="icon" aria-label={t("subscribers.panel.actions.more")}>
          <MoreHorizontal size={14} />
        </Button>
      </div>
    </aside>
  );
}

function KpiCell({
  label,
  value,
  valueStyle,
  isLast,
}: {
  label: string;
  value: string;
  valueStyle?: React.CSSProperties;
  isLast?: boolean;
}) {
  return (
    <div className={cn("px-3.5 py-3", !isLast && "border-r border-rv-divider")}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div
        className="mt-1 font-rv-mono text-[15px] font-medium tabular-nums text-foreground"
        style={valueStyle}
      >
        {value}
      </div>
    </div>
  );
}

function DetailTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex-1 cursor-pointer px-3.5 py-2 text-[12px] transition",
        active ? "text-foreground" : "text-rv-mute-600 hover:text-foreground",
      )}
    >
      {children}
      {active && (
        <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-sm bg-rv-accent-500" />
      )}
    </button>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pb-2 pt-3 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
      {children}
    </div>
  );
}

function Kv({
  k,
  v,
  vClassName,
}: {
  k: string;
  v: string;
  vClassName?: string;
}) {
  return (
    <div className="flex justify-between py-0.5 text-[12px]">
      <span className="text-rv-mute-500">{k}</span>
      <span className={cn("font-rv-mono text-foreground", vClassName)}>{v}</span>
    </div>
  );
}
