import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { Button } from "../../../../ui/button";
import { Segmented } from "../../../../ui/segmented";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  FEATURE_FLAGS,
  FlagDetail,
  FlagsList,
  STALE_FLAGS_COUNT,
  ScopeTabs,
  TOTAL_EVALUATIONS_24H,
  type FeatureFlag,
  type FlagEnv,
  type FlagScope,
} from "../../../../components/feature-flags";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/feature-flags",
)({
  component: FeatureFlagsRouteComponent,
});

const ENV_OPTIONS: ReadonlyArray<FlagEnv> = ["prod", "staging", "development"];

function FeatureFlagsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/feature-flags",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <FeatureFlagsPage />;
}

function FeatureFlagsPage() {
  const { t } = useTranslation();
  const [env, setEnv] = useState<FlagEnv>("prod");
  const [scope, setScope] = useState<FlagScope>("all");
  const [search, setSearch] = useState("");
  const [flags, setFlags] = useState<ReadonlyArray<FeatureFlag>>(FEATURE_FLAGS);
  const [selectedKey, setSelectedKey] = useState<string>(FEATURE_FLAGS[0].key);

  const counts = useMemo<Record<FlagScope, number>>(
    () => ({
      all: flags.length,
      on: flags.filter((f) => f.enabled && !f.killed).length,
      off: flags.filter((f) => !f.enabled || f.killed).length,
      killed: flags.filter((f) => f.killed).length,
      experiment: flags.filter((f) => f.linkedExperiment).length,
    }),
    [flags],
  );

  const visible = useMemo<ReadonlyArray<FeatureFlag>>(() => {
    let arr: ReadonlyArray<FeatureFlag> = flags;
    if (scope === "on") arr = arr.filter((f) => f.enabled && !f.killed);
    if (scope === "off") arr = arr.filter((f) => !f.enabled || f.killed);
    if (scope === "killed") arr = arr.filter((f) => f.killed);
    if (scope === "experiment") arr = arr.filter((f) => f.linkedExperiment);

    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((f) => {
        const haystack = [
          f.key.toLowerCase(),
          f.description.toLowerCase(),
          ...f.tags.map((tag) => tag.toLowerCase()),
        ];
        return haystack.some((s) => s.includes(q));
      });
    }
    return arr;
  }, [flags, scope, search]);

  const selected = useMemo(
    () => flags.find((f) => f.key === selectedKey) ?? flags[0],
    [flags, selectedKey],
  );

  const selectedSeed = useMemo(
    () => flags.findIndex((f) => f.key === selected.key),
    [flags, selected.key],
  );

  const toggleFlag = (key: string) => {
    setFlags((prev) =>
      prev.map((f) =>
        f.key === key
          ? {
              ...f,
              enabled: !f.enabled,
              killed: false,
              rolloutPct: f.enabled ? 0 : f.rolloutPct || 100,
            }
          : f,
      ),
    );
  };

  const totalProd = flags.filter((f) => f.env === "prod").length;

  // Press `/` to focus the search input.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }
      if (searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
        searchRef.current.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("featureFlags.title")}
          </h1>
          <p className="mt-0.5 max-w-3xl text-[13px] text-rv-mute-500">
            {t("featureFlags.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("featureFlags.actions.sdkDocs")}
          </Button>
          <Button variant="flat" size="sm">
            <Upload size={13} />
            {t("featureFlags.actions.import")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("featureFlags.actions.newFlag")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("featureFlags.kpi.totalProd")}
          value={totalProd}
          description={t("featureFlags.kpi.totalProdBreakdown", {
            on: counts.on,
            off: counts.off,
            killed: counts.killed,
          })}
        />
        <StatCard
          label={t("featureFlags.kpi.evaluations")}
          value={TOTAL_EVALUATIONS_24H}
          description={t("featureFlags.kpi.evaluationsLatency")}
        />
        <StatCard
          label={t("featureFlags.kpi.linkedExperiments")}
          value={counts.experiment}
          description={t("featureFlags.kpi.linkedExperimentsDescription")}
        />
        <StatCard
          label={t("featureFlags.kpi.staleFlags")}
          value={
            <span className="text-rv-warning">{STALE_FLAGS_COUNT}</span>
          }
          description={t("featureFlags.kpi.staleFlagsDescription")}
          descriptionTone="warning"
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5">
        <Segmented
          options={ENV_OPTIONS}
          value={env}
          onChange={setEnv}
          ariaLabel={t("featureFlags.env.ariaLabel")}
        />
        <label className="flex h-7 min-w-[200px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
          <Search size={12} className="text-rv-mute-500" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("featureFlags.search.placeholder")}
            className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
          />
        </label>
        <ScopeTabs value={scope} onChange={setScope} counts={counts} />
      </div>

      <div className="grid items-start gap-4 max-[1280px]:grid-cols-1 grid-cols-[minmax(0,1fr)_460px]">
        <FlagsList
          flags={visible}
          selectedKey={selected.key}
          onSelect={setSelectedKey}
          onToggle={toggleFlag}
        />

        <FlagDetail
          flag={selected}
          seed={selectedSeed >= 0 ? selectedSeed : 0}
          onToggle={() => toggleFlag(selected.key)}
        />
      </div>
    </>
  );
}
