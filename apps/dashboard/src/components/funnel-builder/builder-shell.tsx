import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Book,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  RotateCcw,
  Share2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { FUNNEL, SESSIONS, VALIDATION_ISSUES, VERSIONS } from "./data";
import { TABS, type TabId, type ValidationIssue } from "./types";
import { ThumbRail } from "./thumb-rail";
import { CanvasEditor } from "./canvas-editor";
import { PropertiesPanel } from "./properties-panel";
import { WorkflowTab } from "./workflow-tab";
import { ThemeTab } from "./theme-tab";
import { SettingsTab } from "./settings-tab";
import { SessionsTab } from "./sessions-tab";
import { ShareTab } from "./share-tab";
import { ValidationDrawer } from "./validation-drawer";
import { PreviewOverlay } from "./preview-overlay";

type Props = {
  projectId: string;
};

/**
 * Full-bleed funnel editor. Lives as a `fixed inset-0` overlay so it
 * paints over the dashboard shell — gives the editor its own topbar
 * + tab nav without restructuring parent routes.
 */
export function BuilderShell({ projectId }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("content");
  const [selectedPageId, setSelectedPageId] = useState<string>(FUNNEL.pages[0].id);
  const [showVal, setShowVal] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const [autosave, setAutosave] = useState<"saved" | "saving">("saved");

  const errorCount = VALIDATION_ISSUES.filter((i) => i.kind === "error").length;
  const warnCount = VALIDATION_ISSUES.filter((i) => i.kind === "warning").length;
  const selectedIdx = FUNNEL.pages.findIndex((p) => p.id === selectedPageId);
  const selectedPage = FUNNEL.pages[selectedIdx] ?? FUNNEL.pages[0];

  // Fake autosave indicator — every page/tab switch flickers "saving".
  // The real backend hook would replace this with a mutation status.
  useEffect(() => {
    setAutosave("saving");
    const t = setTimeout(() => setAutosave("saved"), 600);
    return () => clearTimeout(t);
  }, [selectedPageId, activeTab]);

  const goPrev = () =>
    selectedIdx > 0 && setSelectedPageId(FUNNEL.pages[selectedIdx - 1].id);
  const goNext = () =>
    selectedIdx < FUNNEL.pages.length - 1 &&
    setSelectedPageId(FUNNEL.pages[selectedIdx + 1].id);

  const jumpToIssue = (iss: ValidationIssue) => {
    setShowVal(false);
    if (iss.where.startsWith("pg_")) {
      setActiveTab("content");
      const pageId = iss.where.split(" ")[0];
      setSelectedPageId(pageId);
    } else if (iss.where === "theme") {
      setActiveTab("theme");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-rv-bg text-foreground">
      <TopBar
        projectId={projectId}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        autosave={autosave}
        errorCount={errorCount}
        warnCount={warnCount}
        onShowValidation={() => setShowVal(true)}
        versionMenuOpen={versionMenuOpen}
        onToggleVersionMenu={() => setVersionMenuOpen((o) => !o)}
        onCloseVersionMenu={() => setVersionMenuOpen(false)}
      />

      <main className="flex flex-1 overflow-hidden">
        {activeTab === "content" && (
          <>
            <ThumbRail
              pages={FUNNEL.pages}
              selectedId={selectedPageId}
              onSelect={setSelectedPageId}
            />
            <CanvasEditor
              page={selectedPage}
              allPages={FUNNEL.pages}
              idx={selectedIdx}
              onPrev={goPrev}
              onNext={goNext}
              onPreview={() => setShowPreview(true)}
            />
            <PropertiesPanel
              page={selectedPage}
              allPages={FUNNEL.pages}
              allRules={FUNNEL.rules}
            />
          </>
        )}
        {activeTab === "workflow" && <WorkflowTab funnel={FUNNEL} />}
        {activeTab === "theme" && <ThemeTab theme={FUNNEL.theme} currentPage={selectedPage} />}
        {activeTab === "settings" && <SettingsTab settings={FUNNEL.settings} />}
        {activeTab === "sessions" && <SessionsTab sessions={SESSIONS} />}
        {activeTab === "share" && <ShareTab funnel={FUNNEL} />}
      </main>

      {activeTab === "content" && <AiChatFab />}

      {showPreview && (
        <PreviewOverlay
          pages={FUNNEL.pages}
          currentId={selectedPageId}
          theme={FUNNEL.theme}
          onClose={() => setShowPreview(false)}
          onSelect={setSelectedPageId}
        />
      )}

      {showVal && (
        <ValidationDrawer
          issues={VALIDATION_ISSUES}
          onClose={() => setShowVal(false)}
          onJump={jumpToIssue}
        />
      )}
    </div>
  );
}

function TopBar({
  projectId,
  activeTab,
  onTabChange,
  autosave,
  errorCount,
  warnCount,
  onShowValidation,
  versionMenuOpen,
  onToggleVersionMenu,
  onCloseVersionMenu,
}: {
  projectId: string;
  activeTab: TabId;
  onTabChange: (t: TabId) => void;
  autosave: "saved" | "saving";
  errorCount: number;
  warnCount: number;
  onShowValidation: () => void;
  versionMenuOpen: boolean;
  onToggleVersionMenu: () => void;
  onCloseVersionMenu: () => void;
}) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-rv-divider bg-rv-c1 px-4">
      <div className="flex items-center gap-2 text-[13px]">
        <Link
          to="/projects/$projectId/funnels"
          params={{ projectId }}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-rv-accent-500 to-rv-accent-700 text-[14px] font-bold text-white"
          title="Back to all funnels"
        >
          R
        </Link>
        <Link
          to="/projects/$projectId/funnels"
          params={{ projectId }}
          className="text-rv-mute-600 hover:text-foreground"
        >
          Funnels
        </Link>
        <ChevronRight size={12} className="text-rv-mute-500" />
        <span className="font-medium text-foreground">{FUNNEL.name}</span>
        <ChevronDown size={12} className="text-rv-mute-500" />
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        <div className="flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              title={t.hint}
              className={cn(
                "relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded px-3 text-[12px] font-medium transition",
                activeTab === t.id
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t.label}
              {t.pip && (
                <span className="h-1.5 w-1.5 rounded-full bg-rv-accent-500" title="Active rules" />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span
          title="Autosaved on every change"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-rv-mute-600"
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              autosave === "saving" ? "animate-pulse bg-rv-warning" : "bg-rv-success",
            )}
          />
          {autosave === "saving" ? "saving" : "saved · 12s"}
        </span>

        {errorCount > 0 ? (
          <button
            type="button"
            onClick={onShowValidation}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-danger/40 bg-rv-danger/15 px-2 text-[11px] font-medium text-rv-danger transition hover:bg-rv-danger/20"
          >
            <TriangleAlert size={12} />
            {errorCount} issue{errorCount === 1 ? "" : "s"}
          </button>
        ) : (
          warnCount > 0 && (
            <button
              type="button"
              onClick={onShowValidation}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-warning/40 bg-rv-warning/15 px-2 text-[11px] font-medium text-rv-warning transition hover:bg-rv-warning/20"
            >
              <TriangleAlert size={12} />
              {warnCount} warning{warnCount === 1 ? "" : "s"}
            </button>
          )
        )}

        <button
          type="button"
          onClick={() => onTabChange("share")}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] font-medium text-rv-mute-800 transition hover:bg-rv-c3"
        >
          <Share2 size={13} />
          Share
        </button>

        <div className="relative flex">
          <button
            type="button"
            disabled={errorCount > 0}
            className={cn(
              "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-l-md bg-rv-accent-500 px-3 text-[12px] font-medium text-white transition hover:bg-rv-accent-600",
              errorCount > 0 && "cursor-not-allowed opacity-50",
            )}
          >
            <Check size={13} />
            Publish v{FUNNEL.version + 1}
          </button>
          <button
            type="button"
            onClick={onToggleVersionMenu}
            title="Version history"
            className="flex h-8 w-7 cursor-pointer items-center justify-center rounded-r-md bg-rv-accent-600 text-white transition hover:bg-rv-accent-700"
          >
            <ChevronDown size={11} />
          </button>
          {versionMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={onCloseVersionMenu} />
              <div className="absolute right-0 top-10 z-50 w-[300px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
                <div className="px-2 py-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                  Recent versions
                </div>
                {VERSIONS.slice(0, 4).map((v) => (
                  <div
                    key={v.num}
                    className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-rv-c2"
                  >
                    <span className="min-w-[32px] font-rv-mono text-[11px] text-rv-mute-500">
                      v{v.num}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-foreground">
                        {v.notes.split(".")[0]}
                      </div>
                      <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">
                        {v.when} · @{v.who}
                      </div>
                    </div>
                    {v.isCurrent && (
                      <span className="inline-flex h-4 items-center rounded-full bg-rv-success/15 px-1.5 font-rv-mono text-[9px] font-medium text-rv-success">
                        LIVE
                      </span>
                    )}
                  </div>
                ))}
                <div className="my-1 border-t border-rv-divider" />
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-rv-mute-700 hover:bg-rv-c2"
                >
                  <History size={12} />
                  All versions…
                </button>
                {FUNNEL.draftDiffersFromPublished && (
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-rv-mute-700 hover:bg-rv-c2"
                  >
                    <RotateCcw size={12} />
                    Discard unpublished changes
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          title="Help"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
        >
          <Book size={14} />
        </button>
        <div
          title="Furkan N."
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-rv-c4 font-rv-mono text-[11px] font-bold text-rv-mute-800"
        >
          FN
        </div>
      </div>
    </header>
  );
}

function AiChatFab() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-[680px] items-center gap-2 rounded-full border border-rv-divider-strong bg-rv-c1/95 px-4 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.5)] backdrop-blur">
        <Sparkles size={14} className="text-rv-accent-500" />
        <input
          placeholder='Describe a change — e.g. "add a 3-step loading screen before the result"'
          className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-rv-mute-500"
        />
        <button
          type="button"
          title="Send"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-rv-accent-500 text-white transition hover:bg-rv-accent-600"
        >
          <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}
