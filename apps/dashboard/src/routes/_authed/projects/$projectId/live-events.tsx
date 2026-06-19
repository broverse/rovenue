import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../ui/button";
import { Sparkline } from "../../../../components/dashboard/sparkline";
import {
  ChevronsUpDown,
  Info,
  Layers,
  Search,
  X,
} from "lucide-react";
import {
  EVENT_CATEGORIES,
  EventDetailPanel,
  EventFilterPill,
  EventStream,
  messageToLiveEvent,
  RateStrip,
  formatRelative,
} from "../../../../components/live-events";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useLiveEventsStream,
  type LiveEventsStatus,
} from "../../../../lib/hooks/useLiveEventsStream";
import { cn } from "../../../../lib/cn";
import type {
  EventCategoryKey,
  EventPlatform,
  EventTypeKey,
  LiveEvent,
} from "../../../../components/live-events";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/live-events",
)({
  component: LiveEventsRoute,
});

const MAX_EVENTS = 200;
const SPARK_LEN = 30;
// Rolling window (seconds) the per-second rate is averaged over.
const RATE_WINDOW_S = 5;

type PlatformFilter = "all" | EventPlatform;

function LiveEventsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/live-events",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <LiveEventsPage projectId={projectId} />;
}

function LiveEventsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [category, setCategory] = useState<EventCategoryKey>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [typeFilters, setTypeFilters] = useState<ReadonlySet<EventTypeKey>>(
    () => new Set(),
  );
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => new Date());

  // Session-derived header stats — every value here is real, computed from
  // the events that have actually arrived over the stream this session.
  const [total, setTotal] = useState(0);
  const [perSec, setPerSec] = useState(0);
  const [sparkData, setSparkData] = useState<number[]>(() =>
    Array.from({ length: SPARK_LEN }, () => 0),
  );
  const arrivalsRef = useRef<number[]>([]);

  const onEvent = useCallback(() => {
    arrivalsRef.current.push(Date.now());
    setTotal((n) => n + 1);
  }, []);

  const { status, events: raw } = useLiveEventsStream({
    projectId,
    paused,
    maxEvents: MAX_EVENTS,
    onEvent,
  });

  // Map the raw wire buffer to render-ready events. `isNew` is true for any
  // event id we hadn't seen on the previous render, which drives the
  // one-shot fade-in animation.
  const seenRef = useRef<Set<string>>(new Set());
  const events = useMemo<LiveEvent[]>(
    () =>
      raw.map((m) =>
        messageToLiveEvent(m, { isNew: !seenRef.current.has(m.eventId) }),
      ),
    [raw],
  );
  useEffect(() => {
    seenRef.current = new Set(raw.map((m) => m.eventId));
  }, [raw]);

  // One-second tick drives the relative clock, the rolling rate and the
  // sparkline bucket — all off the real arrival timestamps.
  useEffect(() => {
    const id = window.setInterval(() => {
      const t0 = Date.now();
      setNow(new Date(t0));
      const arr = arrivalsRef.current;
      const cutoff = t0 - RATE_WINDOW_S * 1000;
      while (arr.length && (arr[0] ?? 0) < cutoff) arr.shift();
      setPerSec(arr.length / RATE_WINDOW_S);
      const lastSecond = arr.filter((ts) => ts >= t0 - 1000).length;
      setSparkData((d) => [...d.slice(1), lastSecond]);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Space toggles pause; Enter inspects the top row when none selected.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.code === "Enter" && !selectedId && eventsRef.current[0]) {
        setSelectedId(eventsRef.current[0].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: events.length };
    for (const cat of EVENT_CATEGORIES) if (cat.key !== "all") m[cat.key] = 0;
    for (const event of events) {
      const cat = event.typeMeta.category;
      m[cat] = (m[cat] ?? 0) + 1;
    }
    return m;
  }, [events]);

  const filtered = useMemo(() => {
    const cat = EVENT_CATEGORIES.find((c) => c.key === category);
    const search_ = search.trim().toLowerCase();
    return events.filter((e) => {
      if (cat?.types && !cat.types.includes(e.type)) return false;
      if (typeFilters.size > 0 && !typeFilters.has(e.type)) return false;
      if (platformFilter !== "all" && e.platform !== platformFilter) return false;
      if (search_) {
        const haystack = [
          e.user,
          e.type,
          e.eventType,
          e.product,
          e.id,
          e.country,
        ];
        if (
          !haystack.some((s) => s != null && s.toLowerCase().includes(search_))
        ) {
          return false;
        }
      }
      return true;
    });
  }, [events, category, typeFilters, platformFilter, search]);

  const selectedEvent = useMemo(() => {
    if (!selectedId) return undefined;
    return (
      filtered.find((e) => e.id === selectedId) ??
      events.find((e) => e.id === selectedId)
    );
  }, [filtered, events, selectedId]);

  const toggleType = (type: EventTypeKey) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const resetFilters = () => {
    setSearch("");
    setTypeFilters(new Set());
    setCategory("all");
    setPlatformFilter("all");
  };

  const lastEventLabel = events[0] ? formatRelative(events[0].receivedAt, now) : "—";
  const showDetail = !!selectedEvent;
  const conn = connectionState(paused, status);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-[24px] font-semibold leading-8 tracking-tight">
            {t("liveEvents.title")}
            <span
              className={cn(
                "inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium",
                conn.pillClass,
              )}
            >
              {conn.live && (
                <span className="relative inline-block size-1.5 rounded-full bg-rv-success">
                  <span className="absolute -inset-0.5 rounded-full bg-rv-success/40 animate-rv-pulse" />
                </span>
              )}
              <span>{t(conn.labelKey)}</span>
            </span>
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t("liveEvents.subtitle")} ·{" "}
            <span className="font-rv-mono">{total.toLocaleString()}</span>{" "}
            {t("liveEvents.eventsThisSession")} ·{" "}
            <span className="font-rv-mono">{perSec.toFixed(1)}</span>/s
            <span className="mx-2 text-rv-mute-500">·</span>
            <span className="inline-flex items-center gap-1.5 font-rv-mono text-[11px] text-rv-mute-500">
              <span className={cn("size-1.5 rounded-full", conn.dotClass)} />
              {t(conn.connKey)}
            </span>
            <Info
              size={12}
              className="ml-1.5 inline-block align-middle text-rv-mute-500 cursor-help"
              aria-label={t("liveEvents.sessionHint")}
            >
              <title>{t("liveEvents.sessionHint")}</title>
            </Info>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-5 w-20 align-middle">
            <Sparkline
              data={sparkData}
              color="var(--color-rv-accent-500)"
              width={80}
              height={20}
            />
          </span>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {EVENT_CATEGORIES.map((c) => (
          <EventFilterPill
            key={c.key}
            active={category === c.key}
            onClick={() => setCategory(c.key)}
            count={counts[c.key]}
          >
            {t(`liveEvents.categories.${c.key}`)}
          </EventFilterPill>
        ))}
        <span className="mx-1 h-5 w-px bg-rv-divider" />
        {(["all", "ios", "android"] as const).map((p) => (
          <EventFilterPill
            key={p}
            active={platformFilter === p}
            onClick={() => setPlatformFilter(p)}
          >
            {p === "all" ? t("liveEvents.platforms.all") : p.toUpperCase()}
          </EventFilterPill>
        ))}
        {typeFilters.size > 0 && (
          <>
            <span className="mx-1 h-5 w-px bg-rv-divider" />
            {[...typeFilters].map((type) => (
              <EventFilterPill key={type} active onClick={() => toggleType(type)}>
                <span className="font-rv-mono text-[11px]">{type}</span>
                <X size={10} />
              </EventFilterPill>
            ))}
            <Button
              variant="light"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setTypeFilters(new Set())}
            >
              {t("liveEvents.actions.clear")}
            </Button>
          </>
        )}
      </div>

      <div
        className={cn(
          "grid items-start gap-4",
          showDetail
            ? "grid-cols-[minmax(0,1fr)_420px] max-[1280px]:grid-cols-[minmax(0,1fr)_360px]"
            : "grid-cols-1",
        )}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2 rounded-t-lg border border-b-0 border-rv-divider bg-rv-c1 px-3.5 py-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("liveEvents.search.placeholder")}
            />
            <Button variant="flat" size="sm">
              <Layers size={13} />
              {t("liveEvents.actions.columns")}
            </Button>
            <Button variant="flat" size="sm">
              <ChevronsUpDown size={13} />
              {t("liveEvents.actions.sort")}
            </Button>
            <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
              {t("liveEvents.showing")}{" "}
              <span className="text-foreground">{filtered.length}</span> {t("liveEvents.of")}{" "}
              {events.length}
            </span>
          </div>

          <EventStream
            events={filtered}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onResetFilters={resetFilters}
            streamHasEvents={events.length > 0}
          />

          <RateStrip throughput={perSec} lastEvent={lastEventLabel} />
        </div>

        {showDetail && (
          <EventDetailPanel event={selectedEvent} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </>
  );
}

// Resolve the header connection pill + inline status from the stream state.
function connectionState(paused: boolean, status: LiveEventsStatus) {
  if (paused) {
    return {
      live: false,
      labelKey: "liveEvents.status.paused",
      connKey: "liveEvents.conn.paused",
      pillClass: "border-rv-divider bg-rv-c2 text-rv-mute-500",
      dotClass: "bg-rv-mute-500",
    } as const;
  }
  if (status === "open") {
    return {
      live: true,
      labelKey: "liveEvents.status.streaming",
      connKey: "liveEvents.conn.connected",
      pillClass: "border-rv-success/25 bg-rv-success/10 text-rv-success",
      dotClass: "bg-rv-success ring-2 ring-rv-success/15",
    } as const;
  }
  if (status === "error") {
    return {
      live: false,
      labelKey: "liveEvents.status.disconnected",
      connKey: "liveEvents.conn.disconnected",
      pillClass: "border-rv-danger/25 bg-rv-danger/10 text-rv-danger",
      dotClass: "bg-rv-danger",
    } as const;
  }
  return {
    live: false,
    labelKey: "liveEvents.status.connecting",
    connKey: "liveEvents.conn.connecting",
    pillClass: "border-rv-warning/25 bg-rv-warning/10 text-rv-warning",
    dotClass: "bg-rv-warning",
  } as const;
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex h-[30px] min-w-[220px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
      <Search size={12} className="text-rv-mute-500" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="cursor-pointer text-rv-mute-500 hover:text-foreground"
          aria-label="Clear search"
        >
          <X size={12} />
        </button>
      )}
      <span className="inline-flex h-[18px] items-center rounded border border-rv-divider bg-rv-c4 px-1.5 font-rv-mono text-[10px] text-rv-mute-600">
        /
      </span>
    </label>
  );
}
