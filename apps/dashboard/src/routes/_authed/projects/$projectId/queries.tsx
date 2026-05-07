import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Calendar, Plus } from "lucide-react";
import { cn } from "../../../../lib/cn";
import { Button } from "../../../../ui/button";
import {
  EditorFooter,
  LibraryRail,
  PINNED_QUERY_IDS,
  QueryActions,
  QueryTabs,
  ResultsPanel,
  SAVED_QUERIES,
  SAVED_QUERY_BY_ID,
  SchemaSide,
  SqlEditor,
  type QueryMode,
  type QueryResultTab,
  type SavedQuery,
} from "../../../../components/queries";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/queries")({
  component: QueriesRoute,
});

function QueriesRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/queries",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <QueriesPage />;
}

const FALLBACK_QUERY: SavedQuery =
  SAVED_QUERY_BY_ID["mrr_by_country"] ?? SAVED_QUERIES[0];

type MobilePane = "library" | "editor" | "schema";

function QueriesPage() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>(FALLBACK_QUERY.id);
  const [openIds, setOpenIds] = useState<ReadonlyArray<string>>(PINNED_QUERY_IDS);
  const [mode, setMode] = useState<QueryMode>("sql");
  const [resultTab, setResultTab] = useState<QueryResultTab>("table");
  const [mobilePane, setMobilePane] = useState<MobilePane>("editor");

  const current = useMemo(
    () => SAVED_QUERY_BY_ID[selectedId] ?? FALLBACK_QUERY,
    [selectedId],
  );
  const editorQuery = current.sql ? current : FALLBACK_QUERY;

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setMobilePane("editor");
  };

  const handleClose = (id: string) => {
    setOpenIds((prev) => {
      const next = prev.filter((openId) => openId !== id);
      if (id === selectedId && next.length > 0) {
        setSelectedId(next[next.length - 1]);
      }
      return next;
    });
  };

  const paneTabs: ReadonlyArray<{ k: MobilePane; labelKey: string }> = [
    { k: "library", labelKey: "queries.library.title" },
    { k: "editor", labelKey: "queries.mobile.paneEditor" },
    { k: "schema", labelKey: "queries.schema.title" },
  ];

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="min-w-0 max-w-3xl">
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
            {t("queries.title")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t("queries.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            <span className="hidden sm:inline">{t("queries.actions.sqlReference")}</span>
          </Button>
          <Button variant="flat" size="sm">
            <Calendar size={13} />
            <span className="hidden sm:inline">
              {t("queries.actions.scheduledCount", { count: 8 })}
            </span>
            <span className="sm:hidden">8</span>
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            <span className="hidden sm:inline">{t("queries.actions.newQuery")}</span>
            <span className="sm:hidden">{t("queries.mobile.newShort")}</span>
          </Button>
        </div>
      </header>

      <div
        className="mb-3 inline-flex w-full gap-0.5 rounded-md border border-rv-divider bg-rv-c1 p-0.5 lg:hidden"
        role="tablist"
        aria-label={t("queries.mobile.paneTablistAria")}
      >
        {paneTabs.map((tab) => {
          const active = mobilePane === tab.k;
          return (
            <button
              key={tab.k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setMobilePane(tab.k)}
              className={cn(
                "flex-1 cursor-pointer rounded px-2 py-1.5 text-[12px] font-medium transition",
                active
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="grid items-start gap-3.5 grid-cols-1 min-[1024px]:grid-cols-[240px_minmax(0,1fr)] min-[1481px]:grid-cols-[240px_minmax(0,1fr)_280px]">
        <div
          className={cn(
            mobilePane === "library" ? "block" : "hidden",
            "min-[1024px]:block",
          )}
        >
          <LibraryRail selectedId={selectedId} onSelect={handleSelect} />
        </div>

        <main
          className={cn(
            "min-w-0 flex-col",
            mobilePane === "editor" ? "flex" : "hidden",
            "min-[1024px]:flex",
          )}
        >
          <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
            <QueryTabs
              openIds={openIds}
              selectedId={selectedId}
              dirtyIds={["refund_anomalies"]}
              onSelect={setSelectedId}
              onClose={handleClose}
            />
            <QueryActions
              mode={mode}
              onModeChange={setMode}
              savedAgoLabel={t("queries.actions.savedAgo", {
                minutes: 4,
                user: "furkan@rovenue.dev",
              })}
            />
            {editorQuery.sql && <SqlEditor lines={editorQuery.sql} />}
            <EditorFooter query={editorQuery} />
          </div>

          <ResultsPanel
            query={editorQuery}
            resultTab={resultTab}
            onResultTabChange={setResultTab}
          />
        </main>

        <div
          className={cn(
            mobilePane === "schema" ? "block" : "hidden",
            "min-[1481px]:block",
          )}
        >
          <SchemaSide />
        </div>
      </div>
    </>
  );
}
