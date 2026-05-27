import { component, useService } from "impair";
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
import {
  TABS,
  type Funnel as FunnelView,
  type Rule as RuleView,
  type RuleClause,
  type Operator,
  type TabId,
  type ValidationIssue,
} from "./types";
import type { NextRule, ValidatorIssue } from "@rovenue/shared/funnel";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
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

// Until Tasks 19–35 convert each child to consume the VM directly,
// BuilderShell synthesises the legacy prop shapes that the existing
// children expect. The converters below are intentionally lossy —
// they're throw-away glue that vanishes commit-by-commit as each
// child migrates to `useService(FunnelDraftViewModel)`.
function legacyOperator(op: string): Operator {
  switch (op) {
    case "eq": return "equals";
    case "neq": return "not_equals";
    case "gt": return ">";
    case "gte": return ">=";
    case "lt": return "<";
    case "lte": return "<=";
    case "between": return "between";
    case "in": return "is_one_of";
    case "not_in": return "not_one_of";
    case "contains": return "contains";
    case "is_answered": return "is_answered";
    case "is_not_answered": return "not_answered";
    default: return "equals";
  }
}

function toLegacyRules(rules: Record<string, NextRule[]>): Record<string, RuleView[]> {
  const out: Record<string, RuleView[]> = {};
  for (const [pageId, list] of Object.entries(rules)) {
    out[pageId] = list.map((r) => ({
      id: r.id,
      combinator: r.condition.op,
      clauses: r.condition.clauses.map<RuleClause>((c) => ({
        qid: c.question_id,
        op: legacyOperator(c.op),
        value: (c as { value?: unknown }).value as RuleClause["value"],
      })),
      goto: r.goto,
    }));
  }
  return out;
}

function toLegacyIssues(errors: ValidatorIssue[], warnings: ValidatorIssue[]): ValidationIssue[] {
  const map = (iss: ValidatorIssue, kind: "error" | "warning"): ValidationIssue => {
    const where = "pageId" in iss ? (iss as { pageId: string }).pageId : "funnel";
    return { kind, where, title: iss.code, desc: iss.message, fix: "Open page" };
  };
  return [
    ...errors.map((e) => map(e, "error")),
    ...warnings.map((w) => map(w, "warning")),
  ];
}

export const BuilderShell = component(({ projectId }: Props) => {
  const vm = useService(FunnelDraftViewModel);

  if (vm.isLoading) {
    return <div className="fixed inset-0 z-50 bg-rv-bg" />;
  }
  if (vm.error || !vm.funnel) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-rv-bg text-rv-mute-700">
        Failed to load funnel.
      </div>
    );
  }

  // Synthesised legacy view used by children that haven't migrated yet.
  const legacyFunnel: FunnelView = {
    id: vm.funnel.id,
    name: vm.name,
    slug: vm.slug,
    status: vm.status,
    version: vm.funnel.currentVersionNo ?? 0,
    draftDiffersFromPublished: vm.funnel.draftDiffersFromPublished,
    theme: vm.theme,
    settings: vm.settings,
    pages: vm.pages,
    rules: toLegacyRules(vm.rules),
    default_next: vm.defaultNext,
  };
  const issues = toLegacyIssues(vm.validation.errors, vm.validation.warnings);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-rv-bg text-foreground">
      <TopBar projectId={projectId} />

      <main className="flex flex-1 overflow-hidden">
        {vm.activeTab === "content" && (
          <>
            <ThumbRail />
            <CanvasEditor />
            <PropertiesPanel />
          </>
        )}
        {vm.activeTab === "workflow" && <WorkflowTab />}
        {vm.activeTab === "theme" && <ThemeTab />}
        {vm.activeTab === "settings" && <SettingsTab />}
        {vm.activeTab === "sessions" && <SessionsTab />}
        {vm.activeTab === "share" && <ShareTab funnel={legacyFunnel} />}
      </main>

      {vm.activeTab === "content" && <AiChatFab />}

      {vm.showPreview && (
        <PreviewOverlay
          pages={vm.pages}
          currentId={vm.selectedPageId ?? vm.pages[0]?.id ?? ""}
          theme={vm.theme}
          onClose={() => vm.closePreview()}
          onSelect={(id) => vm.selectPage(id)}
        />
      )}

      {vm.showValidation && (
        <ValidationDrawer
          issues={issues}
          onClose={() => vm.closeValidation()}
          onJump={(iss) => {
            vm.closeValidation();
            if (iss.where.startsWith("pg_")) {
              vm.setActiveTab("content");
              vm.selectPage(iss.where);
            } else if (iss.where === "theme") {
              vm.setActiveTab("theme");
            }
          }}
        />
      )}
    </div>
  );
});

const TopBar = component(({ projectId }: { projectId: string }) => {
  const vm = useService(FunnelDraftViewModel);
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
        <span className="font-medium text-foreground">{vm.name}</span>
        <ChevronDown size={12} className="text-rv-mute-500" />
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        <div className="flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => vm.setActiveTab(t.id as TabId)}
              title={t.hint}
              className={cn(
                "relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded px-3 text-[12px] font-medium transition",
                vm.activeTab === t.id
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t.label}
              {t.pip && Object.keys(vm.rules).length > 0 && (
                <span className="h-1.5 w-1.5 rounded-full bg-rv-accent-500" title="Active rules" />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <AutosaveBadge />
        {vm.errorCount > 0 ? (
          <button
            type="button"
            onClick={() => vm.openValidation()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-danger/40 bg-rv-danger/15 px-2 text-[11px] font-medium text-rv-danger transition hover:bg-rv-danger/20"
          >
            <TriangleAlert size={12} />
            {vm.errorCount} issue{vm.errorCount === 1 ? "" : "s"}
          </button>
        ) : vm.warnCount > 0 ? (
          <button
            type="button"
            onClick={() => vm.openValidation()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-warning/40 bg-rv-warning/15 px-2 text-[11px] font-medium text-rv-warning transition hover:bg-rv-warning/20"
          >
            <TriangleAlert size={12} />
            {vm.warnCount} warning{vm.warnCount === 1 ? "" : "s"}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => vm.setActiveTab("share")}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] font-medium text-rv-mute-800 transition hover:bg-rv-c3"
        >
          <Share2 size={13} />
          Share
        </button>

        <PublishDropdown />

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
});

const AutosaveBadge = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const saving = vm.autosaveStatus === "saving";
  const err = vm.autosaveStatus === "error";
  return (
    <span
      title={err ? "Save failed — retrying" : "Autosaved on every change"}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-rv-mute-600"
    >
      <span className={cn(
        "h-1.5 w-1.5 rounded-full",
        saving ? "animate-pulse bg-rv-warning" : err ? "bg-rv-danger" : "bg-rv-success",
      )} />
      {saving ? "saving" : err ? "retrying" : "saved"}
    </span>
  );
});

const PublishDropdown = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const nextVersionNo = (vm.funnel?.currentVersionNo ?? 0) + 1;
  return (
    <div className="relative flex">
      <button
        type="button"
        disabled={vm.errorCount > 0}
        onClick={() => vm.publish()}
        className={cn(
          "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-l-md bg-rv-accent-500 px-3 text-[12px] font-medium text-white transition hover:bg-rv-accent-600",
          vm.errorCount > 0 && "cursor-not-allowed opacity-50",
        )}
      >
        <Check size={13} />
        Publish v{nextVersionNo}
      </button>
      <button
        type="button"
        onClick={() => vm.toggleVersionMenu()}
        title="Version history"
        className="flex h-8 w-7 cursor-pointer items-center justify-center rounded-r-md bg-rv-accent-600 text-white transition hover:bg-rv-accent-700"
      >
        <ChevronDown size={11} />
      </button>
      {vm.versionMenuOpen && <VersionMenu />}
    </div>
  );
});

const VersionMenu = component(() => {
  const vm = useService(FunnelDraftViewModel);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => vm.closeVersionMenu()} />
      <div className="absolute right-0 top-10 z-50 w-[300px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
        <div className="px-2 py-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
          Recent versions
        </div>
        <div className="px-2 py-1 text-[11px] text-rv-mute-500">Version dropdown wired in Task 32</div>
        <div className="my-1 border-t border-rv-divider" />
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-rv-mute-700 hover:bg-rv-c2"
        >
          <History size={12} />
          All versions…
        </button>
        {vm.funnel?.draftDiffersFromPublished && (
          <button
            type="button"
            onClick={() => vm.discardDraft()}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-rv-mute-700 hover:bg-rv-c2"
          >
            <RotateCcw size={12} />
            Discard unpublished changes
          </button>
        )}
      </div>
    </>
  );
});

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
