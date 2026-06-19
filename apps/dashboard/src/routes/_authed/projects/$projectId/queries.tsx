import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Plus } from "lucide-react";
import type {
  DashboardSavedQuery,
  QueryExecuteResponse,
} from "@rovenue/shared";
import { cn } from "../../../../lib/cn";
import { Button } from "../../../../ui/button";
import {
  EditorFooter,
  LibraryRail,
  QueryActions,
  QueryTabs,
  ResultsPanel,
  SaveQueryDialog,
  SchemaSide,
  SqlEditor,
  VisualBuilder,
  type QueryMode,
  type QueryResultTab,
} from "../../../../components/queries";
import {
  useCreateSavedQuery,
  useExecuteQuery,
  useSavedQueries,
  useUpdateSavedQuery,
} from "../../../../lib/hooks/useProjectQueries";
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
  return <QueriesPage projectId={projectId} />;
}

type MobilePane = "library" | "editor" | "schema";

/** Local-only working state for an open editor tab. */
interface EditorTab {
  id: string;
  savedId: string | null;
  name: string;
  /** The text that was last persisted (used for dirty detection). */
  baselineSql: string;
  /** The text currently in the editor. */
  sql: string;
  result: QueryExecuteResponse | null;
  error: string | null;
}

const newDraftId = () =>
  `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function makeDraft(): EditorTab {
  return {
    id: newDraftId(),
    savedId: null,
    name: "",
    baselineSql: "",
    sql: "",
    result: null,
    error: null,
  };
}

function makeFromSaved(q: DashboardSavedQuery): EditorTab {
  return {
    id: q.id,
    savedId: q.id,
    name: q.name,
    baselineSql: q.sql,
    sql: q.sql,
    result: null,
    error: null,
  };
}

function QueriesPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const list = useSavedQueries(projectId);
  const execute = useExecuteQuery(projectId);
  const createMut = useCreateSavedQuery(projectId);
  const updateMut = useUpdateSavedQuery(projectId);

  const queries = list.data?.queries ?? [];
  const queriesById = useMemo(() => {
    const map: Record<string, DashboardSavedQuery> = {};
    for (const q of queries) map[q.id] = q;
    return map;
  }, [queries]);

  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<QueryMode>("sql");
  const [resultTab, setResultTab] = useState<QueryResultTab>("table");
  const [mobilePane, setMobilePane] = useState<MobilePane>("editor");
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const seededRef = useRef(false);

  // Seed the editor with the first saved query (if any) on first load.
  useEffect(() => {
    if (seededRef.current) return;
    if (list.isLoading) return;
    seededRef.current = true;
    if (queries.length > 0) {
      const first = makeFromSaved(queries[0]);
      setTabs([first]);
      setSelectedId(first.id);
    } else {
      const draft = makeDraft();
      setTabs([draft]);
      setSelectedId(draft.id);
    }
  }, [list.isLoading, queries]);

  // When a tab's underlying saved query changes (e.g. after a save), pull
  // the new persisted SQL in so dirty detection stays accurate.
  useEffect(() => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (!tab.savedId) return tab;
        const persisted = queriesById[tab.savedId];
        if (!persisted) return tab;
        if (
          persisted.name === tab.name &&
          persisted.sql === tab.baselineSql
        ) {
          return tab;
        }
        // If the editor is unchanged from the previous baseline, accept
        // the new persisted text. Otherwise leave the local edits alone.
        const sqlInSync = tab.sql === tab.baselineSql;
        return {
          ...tab,
          name: persisted.name,
          baselineSql: persisted.sql,
          sql: sqlInSync ? persisted.sql : tab.sql,
        };
      }),
    );
  }, [queriesById]);

  const current = tabs.find((t) => t.id === selectedId) ?? null;
  const dirtyIds = useMemo(
    () => tabs.filter((t) => t.sql !== t.baselineSql).map((t) => t.id),
    [tabs],
  );
  const draftIds = useMemo(
    () => tabs.filter((t) => !t.savedId).map((t) => t.id),
    [tabs],
  );
  const draftNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const tab of tabs) {
      if (!tab.savedId) {
        map[tab.id] = tab.name || t("queries.draft.untitled");
      }
    }
    return map;
  }, [tabs, t]);

  const nameFor = useCallback(
    (id: string) => {
      const tab = tabs.find((tt) => tt.id === id);
      if (tab) {
        if (!tab.savedId) return tab.name || t("queries.draft.untitled");
        return tab.name;
      }
      return queriesById[id]?.name ?? id;
    },
    [tabs, queriesById, t],
  );

  const openSaved = useCallback(
    (id: string) => {
      const existing = tabs.find((tt) => tt.id === id);
      if (existing) {
        setSelectedId(id);
        setMobilePane("editor");
        return;
      }
      const q = queriesById[id];
      if (!q) return;
      const next = makeFromSaved(q);
      setTabs((prev) => [...prev, next]);
      setSelectedId(next.id);
      setMobilePane("editor");
    },
    [tabs, queriesById],
  );

  const handleSelect = (id: string) => {
    // Drafts only live in `tabs`; saved queries live in the API list.
    if (tabs.some((tt) => tt.id === id)) {
      setSelectedId(id);
      setMobilePane("editor");
      return;
    }
    openSaved(id);
  };

  const handleNew = () => {
    const draft = makeDraft();
    setTabs((prev) => [...prev, draft]);
    setSelectedId(draft.id);
    setMobilePane("editor");
  };

  const handleClose = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((tt) => tt.id !== id);
      if (id === selectedId) {
        setSelectedId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const updateCurrent = useCallback(
    (patch: Partial<EditorTab>) => {
      setTabs((prev) =>
        prev.map((tt) => (tt.id === selectedId ? { ...tt, ...patch } : tt)),
      );
    },
    [selectedId],
  );

  // Stable so VisualBuilder's emit-SQL effect doesn't refire every render
  // (an inline arrow would change identity each render → render loop).
  const setCurrentSql = useCallback(
    (next: string) => updateCurrent({ sql: next }),
    [updateCurrent],
  );

  const handleRun = useCallback(async () => {
    if (!current) return;
    const sql = current.sql.trim();
    if (!sql) {
      updateCurrent({ error: t("queries.editor.errorEmpty") });
      return;
    }
    updateCurrent({ error: null });
    try {
      const res = await execute.mutateAsync({ sql });
      updateCurrent({ result: res, error: null });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("queries.editor.errorRun");
      updateCurrent({ result: null, error: message });
    }
  }, [current, execute, t, updateCurrent]);

  const handleSave = useCallback(async () => {
    if (!current) return;
    const sql = current.sql.trim();
    if (!sql) {
      updateCurrent({ error: t("queries.editor.errorEmpty") });
      return;
    }
    if (current.savedId) {
      try {
        const res = await updateMut.mutateAsync({
          id: current.savedId,
          sql: current.sql,
        });
        updateCurrent({
          baselineSql: res.query.sql,
          sql: res.query.sql,
          name: res.query.name,
          error: null,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("queries.editor.errorSave");
        updateCurrent({ error: message });
      }
      return;
    }
    // Draft → create. Collect a name via the modal.
    setSaveDialogOpen(true);
  }, [current, updateMut, t, updateCurrent]);

  // Confirm handler for the save-name modal. Rejects so the dialog can keep
  // itself open and surface the error.
  const handleConfirmSaveName = useCallback(
    async (name: string) => {
      if (!current) return;
      const sql = current.sql.trim();
      const res = await createMut.mutateAsync({ name, sql });
      const saved = res.query;
      setTabs((prev) =>
        prev.map((tt) =>
          tt.id === current.id
            ? {
                ...tt,
                id: saved.id,
                savedId: saved.id,
                name: saved.name,
                baselineSql: saved.sql,
                sql: saved.sql,
                error: null,
              }
            : tt,
        ),
      );
      setSelectedId(saved.id);
    },
    [current, createMut],
  );

  // Keyboard ⌘/Ctrl + S → save the current tab.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  const paneTabs: ReadonlyArray<{ k: MobilePane; labelKey: string }> = [
    { k: "library", labelKey: "queries.library.title" },
    { k: "editor", labelKey: "queries.mobile.paneEditor" },
    { k: "schema", labelKey: "queries.schema.title" },
  ];

  const savedAgoLabel = current?.savedId
    ? t("queries.actions.savedSaved")
    : t("queries.actions.savedDraft");

  const openIds = tabs.map((t) => t.id);
  const isDirty = current ? current.sql !== current.baselineSql : false;

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
            <span className="hidden sm:inline">
              {t("queries.actions.sqlReference")}
            </span>
          </Button>
          <Button variant="solid-primary" size="sm" onClick={handleNew}>
            <Plus size={13} />
            <span className="hidden sm:inline">
              {t("queries.actions.newQuery")}
            </span>
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
          <LibraryRail
            queries={queries}
            draftIds={draftIds}
            draftNames={draftNames}
            selectedId={selectedId}
            onSelect={handleSelect}
            onNew={handleNew}
            loading={list.isLoading}
            error={Boolean(list.error)}
            onRetry={() => list.refetch()}
          />
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
              dirtyIds={dirtyIds}
              draftIds={draftIds}
              nameFor={nameFor}
              onSelect={setSelectedId}
              onClose={handleClose}
              onNew={handleNew}
            />
            <QueryActions
              mode={mode}
              onModeChange={setMode}
              savedAgoLabel={savedAgoLabel}
              onRun={handleRun}
              onSave={handleSave}
              runDisabled={!current || !current.sql.trim()}
              runLoading={execute.isPending}
              saveDisabled={
                !current ||
                !current.sql.trim() ||
                (Boolean(current.savedId) && !isDirty)
              }
              saveLoading={createMut.isPending || updateMut.isPending}
            />
            {current ? (
              mode === "visual" ? (
                <VisualBuilder
                  projectId={projectId}
                  onChange={setCurrentSql}
                />
              ) : (
                <SqlEditor
                  value={current.sql}
                  onChange={setCurrentSql}
                  onSubmit={handleRun}
                />
              )
            ) : (
              <div className="flex min-h-[280px] items-center justify-center bg-rv-bg px-4 text-center font-rv-mono text-[12px] text-rv-mute-500">
                <button
                  type="button"
                  onClick={handleNew}
                  className="cursor-pointer underline-offset-2 hover:underline"
                >
                  {t("queries.editor.startNew")}
                </button>
              </div>
            )}
            <EditorFooter sql={current?.sql ?? ""} errorMessage={current?.error ?? null} />
          </div>

          <ResultsPanel
            result={current?.result ?? null}
            loading={execute.isPending}
            error={current?.error ?? null}
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

      <SaveQueryDialog
        open={saveDialogOpen}
        initialName={current?.name || t("queries.draft.defaultName")}
        onSave={handleConfirmSaveName}
        onClose={() => setSaveDialogOpen(false)}
      />
    </>
  );
}
