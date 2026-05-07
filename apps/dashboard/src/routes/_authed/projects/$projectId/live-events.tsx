import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../ui/button";
import { Sparkline } from "../../../../components/dashboard/sparkline";
import {
  IconArrows,
  IconLayers,
  IconSearch,
  IconTerminal,
  IconWebhook,
  IconX,
  IconZap,
} from "../../../../components/dashboard/icons";
import {
  EVENT_CATEGORIES,
  EventDetailPanel,
  EventFilterPill,
  EventStream,
  RateStrip,
  formatRelative,
  generateLiveEvent,
  seedLiveEvents,
} from "../../../../components/live-events";
import { useProject } from "../../../../lib/hooks/useProject";
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

const STREAM_INTERVAL_MS = 1000;
const MAX_EVENTS = 200;
const SPARK_LEN = 30;

type PlatformFilter = "all" | EventPlatform;

function LiveEventsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/live-events",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <LiveEventsPage projectName={project.name} />;
}

function LiveEventsPage({ projectName }: { projectName: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<LiveEvent[]>(() => seedLiveEvents(40));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [category, setCategory] = useState<EventCategoryKey>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [typeFilters, setTypeFilters] = useState<ReadonlySet<EventTypeKey>>(
    () => new Set(),
  );
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [counter, setCounter] = useState({ total: 2147, perSec: 1.3 });
  const [sparkData, setSparkData] = useState<number[]>(() =>
    Array.from({ length: SPARK_LEN }, () => 0.8 + Math.random() * 0.8),
  );

  // Tick the relative-time clock once per second.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Drive the live event simulator.
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setEvents((prev) => {
        const aged = prev.map((e) => (e.isNew ? { ...e, isNew: false } : e));
        const fresh = generateLiveEvent({ isNew: true });
        return [fresh, ...aged].slice(0, MAX_EVENTS);
      });
      setCounter((c) => ({
        total: c.total + 1,
        perSec: +(0.9 + Math.random() * 0.4).toFixed(1),
      }));
      setSparkData((data) => [...data.slice(1), 0.6 + Math.random() * 1.2]);
    }, STREAM_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [paused]);

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
    const m: Record<EventCategoryKey, number> = {
      all: events.length,
      subscription: 0,
      billing: 0,
      entitlement: 0,
      ledger: 0,
    };
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
          e.product.toLowerCase(),
          e.id,
          e.productSku,
          e.country.toLowerCase(),
        ];
        if (!haystack.some((s) => s.includes(search_))) return false;
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

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-[24px] font-semibold leading-8 tracking-tight">
            {t("liveEvents.title")}
            <span
              className={cn(
                "inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium",
                paused
                  ? "border-rv-divider bg-rv-c2 text-rv-mute-500"
                  : "border-rv-success/25 bg-rv-success/10 text-rv-success",
              )}
            >
              {!paused && (
                <span className="relative inline-block size-1.5 rounded-full bg-rv-success">
                  <span className="absolute -inset-0.5 rounded-full bg-rv-success/40 animate-rv-pulse" />
                </span>
              )}
              <span>
                {paused ? t("liveEvents.status.paused") : t("liveEvents.status.streaming")}
              </span>
            </span>
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t("liveEvents.subtitle")} ·{" "}
            <span className="font-rv-mono">{counter.total.toLocaleString()}</span>{" "}
            {t("liveEvents.eventsToday")} ·{" "}
            <span className="font-rv-mono">{counter.perSec.toFixed(1)}</span>/s
            <span className="mx-2 text-rv-mute-500">·</span>
            <span className="inline-flex items-center gap-1.5 font-rv-mono text-[11px] text-rv-mute-500">
              <span className="size-1.5 rounded-full bg-rv-success ring-2 ring-rv-success/15" />
              {t("liveEvents.websocketConnected")}{" "}
              <span className="opacity-70">wss://ingest.{projectName.toLowerCase()}.io</span>
            </span>
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
          <Button variant="flat" size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? <IconZap size={13} /> : <IconX size={13} />}
            {paused ? t("liveEvents.actions.resume") : t("liveEvents.actions.pause")}
          </Button>
          <Button variant="flat" size="sm">
            <IconTerminal size={13} />
            {t("liveEvents.actions.export")}
          </Button>
          <Button variant="flat" size="sm">
            <IconWebhook size={13} />
            {t("liveEvents.actions.replay")}
          </Button>
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
                <IconX size={10} />
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
              <IconLayers size={13} />
              {t("liveEvents.actions.columns")}
            </Button>
            <Button variant="flat" size="sm">
              <IconArrows size={13} />
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
          />

          <RateStrip throughput={counter.perSec} lastEvent={lastEventLabel} />
        </div>

        {showDetail && (
          <EventDetailPanel event={selectedEvent} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </>
  );
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
      <IconSearch size={12} className="text-rv-mute-500" />
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
          <IconX size={12} />
        </button>
      )}
      <span className="inline-flex h-[18px] items-center rounded border border-rv-divider bg-rv-c4 px-1.5 font-rv-mono text-[10px] text-rv-mute-600">
        /
      </span>
    </label>
  );
}
