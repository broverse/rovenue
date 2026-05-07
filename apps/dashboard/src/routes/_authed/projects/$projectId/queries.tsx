import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Calendar, Plus } from "lucide-react";
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

function QueriesPage() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>(FALLBACK_QUERY.id);
  const [openIds, setOpenIds] = useState<ReadonlyArray<string>>(PINNED_QUERY_IDS);
  const [mode, setMode] = useState<QueryMode>("sql");
  const [resultTab, setResultTab] = useState<QueryResultTab>("table");

  const current = useMemo(
    () => SAVED_QUERY_BY_ID[selectedId] ?? FALLBACK_QUERY,
    [selectedId],
  );
  const editorQuery = current.sql ? current : FALLBACK_QUERY;

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
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

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("queries.title")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t("queries.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("queries.actions.sqlReference")}
          </Button>
          <Button variant="flat" size="sm">
            <Calendar size={13} />
            {t("queries.actions.scheduledCount", { count: 8 })}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("queries.actions.newQuery")}
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-3.5 grid-cols-1 max-[1100px]:grid-cols-1 max-[1480px]:grid-cols-[240px_minmax(0,1fr)] min-[1481px]:grid-cols-[240px_minmax(0,1fr)_280px]">
        <LibraryRail selectedId={selectedId} onSelect={handleSelect} />

        <main className="flex min-w-0 flex-col">
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

        <div className="hidden min-[1481px]:block">
          <SchemaSide />
        </div>
      </div>
    </>
  );
}
