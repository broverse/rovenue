import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Users, Webhook, X, Zap } from "lucide-react";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { formatAmount } from "./format";
import { buildEventPayload, PayloadViewer } from "./payload-viewer";
import { PlatformBadge } from "./platform-badge";
import type { LiveEvent } from "./types";

const TABS = ["overview", "payload"] as const;
type Tab = (typeof TABS)[number];

type Props = {
  event: LiveEvent | undefined;
  onClose: () => void;
};

const tabBase =
  "cursor-pointer border-b-2 border-transparent px-2.5 py-2 text-[12px] font-medium text-rv-mute-500 transition hover:text-rv-mute-800";
const tabActive = "border-rv-accent-500 text-foreground";

export function EventDetailPanel({ event, onClose }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("overview");

  const payload = useMemo(() => (event ? buildEventPayload(event) : null), [event]);

  if (!event || !payload) {
    return (
      <aside className="sticky top-[72px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="flex flex-col items-center justify-center px-6 py-16 text-center text-[12px] text-rv-mute-500">
          <div className="mb-3 flex size-10 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
            <Zap size={16} />
          </div>
          <div className="mb-1 text-[13px] font-semibold text-rv-mute-700">
            {t("liveEvents.detail.emptyTitle")}
          </div>
          <p className="m-0 max-w-[260px]">{t("liveEvents.detail.emptyBody")}</p>
        </div>
      </aside>
    );
  }

  const copyId = () => {
    void navigator.clipboard?.writeText(event.id);
  };
  const copyPayload = () => {
    void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  };

  return (
    <aside className="sticky top-[72px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-start justify-between gap-2 border-b border-rv-divider px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 flex items-center gap-1.5 font-rv-mono text-[13px] font-semibold">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: event.typeMeta.color }}
              aria-hidden="true"
            />
            {event.typeMeta.label}
          </h2>
          <div className="mt-1 break-all font-rv-mono text-[11px] text-rv-mute-500">
            {event.id}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="light"
            size="icon"
            aria-label={t("liveEvents.detail.copyId")}
            title={t("liveEvents.detail.copyId")}
            onClick={copyId}
          >
            <BookOpen size={13} />
          </Button>
          <Button
            variant="light"
            size="icon"
            aria-label={t("liveEvents.detail.close")}
            onClick={onClose}
          >
            <X size={14} />
          </Button>
        </div>
      </div>

      <div role="tablist" className="flex gap-0.5 border-b border-rv-divider px-2">
        {TABS.map((tabId) => (
          <button
            key={tabId}
            type="button"
            role="tab"
            aria-selected={tab === tabId}
            onClick={() => setTab(tabId)}
            className={cn(tabBase, tab === tabId && tabActive)}
          >
            {t(`liveEvents.detail.tabs.${tabId}`)}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-3.5 pb-5 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
        {tab === "overview" && <OverviewTab event={event} />}

        {tab === "payload" && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("liveEvents.detail.jsonPayload")}
              </span>
              <Button
                variant="light"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={copyPayload}
              >
                {t("liveEvents.detail.copy")}
              </Button>
            </div>
            <PayloadViewer payload={payload} />
          </div>
        )}
      </div>
    </aside>
  );
}

function OverviewTab({ event }: { event: LiveEvent }) {
  const { t } = useTranslation();
  const refund = event.amount != null && event.amount < 0;
  const amountText =
    event.amount == null
      ? "—"
      : `${formatAmount(event.amount)}${event.currency ? ` ${event.currency}` : ""}`;

  const dash = (v: string | null) => v ?? "—";

  const rows: ReadonlyArray<{ key: string; value: React.ReactNode; danger?: boolean }> = [
    { key: "event_type", value: event.eventType },
    { key: "aggregate", value: event.aggregateType },
    { key: "type", value: event.type },
    { key: "user", value: dash(event.user) },
    { key: "product", value: dash(event.product) },
    { key: "amount", value: amountText, danger: refund },
    {
      key: "platform",
      value: event.platform ? (
        <span className="flex items-center gap-1.5">
          <PlatformBadge platform={event.platform} />
          {event.store ? <> · {event.store}</> : null}
        </span>
      ) : (
        dash(event.store)
      ),
    },
    { key: "country", value: dash(event.country) },
    { key: "received_at", value: event.receivedAt.toISOString() },
  ];

  return (
    <div>
      <dl className="m-0">
        {rows.map((row) => (
          <div
            key={row.key}
            className="grid grid-cols-[110px_minmax(0,1fr)] items-baseline gap-3 border-b border-white/[0.04] py-1.5 text-[12px] last:border-b-0"
          >
            <dt className="font-rv-mono text-[11px] text-rv-mute-500">{row.key}</dt>
            <dd
              className={cn(
                "m-0 break-all font-rv-mono tabular-nums",
                row.danger ? "text-rv-danger" : "text-rv-mute-800",
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="flat" size="sm">
          <Users size={13} />
          {t("liveEvents.detail.viewSubscriber")}
        </Button>
        <Button variant="flat" size="sm">
          <Webhook size={13} />
          {t("liveEvents.detail.replayWebhook")}
        </Button>
      </div>
    </div>
  );
}
