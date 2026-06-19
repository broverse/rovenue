import { useTranslation } from "react-i18next";
import { Checkbox } from "../../ui/checkbox";
import { AccessList } from "../products/access-chip";
import { Chip } from "../../ui/chip";
import { cn } from "../../lib/cn";
import { CountryCell } from "./country-cell";
import { formatLastActivity, formatLtv, formatMoney } from "./format";
import { PlatformTags } from "./platform-tags";
import { RiskMeter } from "./risk-meter";
import { SubscriberStatusChip } from "./subscriber-status-chip";
import { UserAvatar } from "./user-avatar";
import type { Subscriber } from "./types";

type Props = {
  subscriber: Subscriber;
  selected: boolean;
  active: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
};

export function SubscriberRow({
  subscriber,
  selected,
  active,
  onToggleSelected,
  onOpen,
}: Props) {
  const { t } = useTranslation();
  const lastActivity = subscriber.renewsIn
    ? t("subscribers.table.renewsIn", { value: subscriber.renewsIn })
    : formatLastActivity(subscriber.lastSeenAt);

  return (
    <tr
      onClick={onOpen}
      className={cn(
        "group cursor-pointer border-b border-white/[0.04] transition hover:bg-rv-c2",
        active &&
          "bg-rv-accent-500/[0.08] [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-rv-accent-500)]",
      )}
    >
      <td className="w-7 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onChange={onToggleSelected}
          ariaLabel={`Select ${subscriber.full}`}
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <UserAvatar fullId={subscriber.full} vip={subscriber.vip} />
          <div className="min-w-0">
            <div className="truncate text-[13px] text-foreground" title={subscriber.name || undefined}>
              {subscriber.name}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span
          className="truncate font-rv-mono text-[12px] text-rv-mute-500"
          title={subscriber.rovenueId}
        >
          {subscriber.rovenueId}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <span
          className={cn(
            "truncate font-rv-mono text-[12px]",
            subscriber.full ? "text-foreground" : "text-rv-mute-500",
          )}
          title={subscriber.full || undefined}
        >
          {subscriber.full || "—"}
        </span>
      </td>
      <td className={cn("px-3 py-2.5 text-[12px]", subscriber.plan === "—" ? "text-rv-mute-500" : "text-foreground")}>
        {subscriber.plan}
      </td>
      <td className="px-3 py-2.5">
        <SubscriberStatusChip status={subscriber.status} />
        {subscriber.billingIssue && (
          <Chip tone="danger" className="ml-1">
            {t("subscribers.table.billing")}
          </Chip>
        )}
      </td>
      <td className="px-3 py-2.5">
        <AccessList
          access={subscriber.access.map((a) => ({
            id: a,
            identifier: a,
            displayName: a,
          }))}
        />
      </td>
      <td className="px-3 py-2.5">
        <CountryCell country={subscriber.country} />
      </td>
      <td className="px-3 py-2.5">
        <PlatformTags platforms={subscriber.platforms} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-rv-mono text-[13px] tabular-nums">
        {formatLtv(subscriber.ltv)}
      </td>
      <td
        className={cn(
          "whitespace-nowrap px-3 py-2.5 text-right font-rv-mono text-[13px] tabular-nums",
          subscriber.mrr === 0 ? "text-rv-mute-500" : "text-foreground",
        )}
      >
        {formatMoney(subscriber.mrr)}
      </td>
      <td className="px-3 py-2.5">
        <RiskMeter score={subscriber.risk} />
      </td>
      <td
        className={cn(
          "whitespace-nowrap px-3 py-2.5 font-rv-mono text-[12px]",
          subscriber.renewsIn ? "text-rv-warning" : "text-rv-mute-600",
        )}
      >
        {lastActivity}
      </td>
    </tr>
  );
}
