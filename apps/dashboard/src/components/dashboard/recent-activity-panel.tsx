import { useTranslation } from "react-i18next";
import { Card, CardFooter, CardHeader } from "../../ui/card";
import { Button } from "../../ui/button";
import { IconAlert, IconArrowDown, IconArrowUp, IconMore, IconRotate } from "./icons";

export type ActivityKind = "up" | "down" | "renew" | "alert";

export type ActivityEvent = {
  id: string;
  type: string;
  color: string;
  icon: ActivityKind;
  label: string;
  user: string;
  product: string;
  amount: number | null;
  secondsAgo: number;
  isNew?: boolean;
};

const fmtTime = (s: number): string => {
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function ActivityIcon({ kind, color }: { kind: ActivityKind; color: string }) {
  const props = { size: 12 };
  return (
    <div
      className="flex size-5 items-center justify-center rounded"
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
    >
      {kind === "up" && <IconArrowUp {...props} />}
      {kind === "down" && <IconArrowDown {...props} />}
      {kind === "renew" && <IconRotate {...props} />}
      {kind === "alert" && <IconAlert {...props} />}
    </div>
  );
}

type Props = {
  events: ReadonlyArray<ActivityEvent>;
  live?: boolean;
};

/**
 * Real-time event ticker — last 6 events with fade-in animation on
 * incoming rows.
 */
export function RecentActivityPanel({ events, live }: Props) {
  const { t } = useTranslation();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <div className="flex items-center gap-2">
            <span>{t("panels.activity.title")}</span>
            {live && (
              <span className="inline-flex h-5 items-center gap-1 rounded-full border border-rv-success/25 bg-rv-success/10 px-2 text-[10px] font-medium text-rv-success">
                <span className="relative inline-block size-1.5 rounded-full bg-rv-success">
                  <span className="absolute -inset-0.5 rounded-full bg-rv-success/40 animate-rv-pulse" />
                </span>
                {t("panels.activity.live")}
              </span>
            )}
          </div>
        }
        subtitle={t("panels.activity.subtitle")}
        right={
          <Button variant="light" size="icon" aria-label={t("panels.activity.filter")}>
            <IconMore size={14} />
          </Button>
        }
      />
      <div className="flex-1 overflow-hidden px-5 pb-1 pt-1">
        {events.slice(0, 6).map((e, i) => (
          <div
            key={e.id}
            className={`grid grid-cols-[20px_1fr_auto] items-center gap-2.5 border-b border-rv-divider py-2.5 last:border-b-0 ${
              i === 0 && e.isNew ? "animate-rv-fade-in" : ""
            }`}
          >
            <ActivityIcon kind={e.icon} color={e.color} />
            <div className="min-w-0">
              <div className="font-rv-mono text-[12px] font-medium text-rv-mute-800">{e.label}</div>
              <div className="mt-0.5 truncate text-[12px] text-rv-mute-500">
                <code className="rounded border border-rv-divider bg-rv-c4 px-1 py-px text-[10px] text-rv-mute-700">
                  {e.user}
                </code>
                <span className="mx-1.5 text-rv-mute-400">·</span>
                {e.product}
              </div>
            </div>
            <div className="text-right font-rv-mono text-[12px] tabular-nums text-rv-mute-600">
              <div>{e.amount == null ? "—" : `${e.amount < 0 ? "-" : ""}$${Math.abs(e.amount).toFixed(2)}`}</div>
              <div className="mt-0.5 text-[11px] text-rv-mute-500">{fmtTime(e.secondsAgo)}</div>
            </div>
          </div>
        ))}
      </div>
      <CardFooter>
        <Button variant="light" className="h-6 p-0 text-xs">
          {t("panels.activity.viewAllEvents")}
        </Button>
      </CardFooter>
    </Card>
  );
}
