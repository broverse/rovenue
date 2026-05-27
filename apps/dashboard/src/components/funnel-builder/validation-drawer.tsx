import { ArrowRight, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ValidationIssue } from "./types";

type Props = {
  issues: ReadonlyArray<ValidationIssue>;
  onClose: () => void;
  onJump: (issue: ValidationIssue) => void;
};

/**
 * Slide-in panel from the right edge that surfaces publish-blocking
 * errors and informational warnings. Clicking "Fix" deep-links into
 * the relevant tab + page.
 */
export function ValidationDrawer({ issues, onClose, onJump }: Props) {
  const errors = issues.filter((i) => i.kind === "error");
  const warns = issues.filter((i) => i.kind === "warning");

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px]"
      />
      <div className="fixed right-0 top-0 z-[61] flex h-screen w-full max-w-[440px] flex-col border-l border-rv-divider-strong bg-rv-c1 shadow-[0_0_60px_rgba(0,0,0,0.5)]">
        <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
          <div>
            <h2 className="m-0 text-[16px] font-semibold tracking-tight">Can't publish yet</h2>
            <p className="mt-1 m-0 text-[12px] text-rv-mute-500">
              {errors.length} error{errors.length === 1 ? "" : "s"} · {warns.length} warning
              {warns.length === 1 ? "" : "s"}. Errors block publish; warnings don't.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {errors.length > 0 && (
            <>
              <SectionLabel>Errors</SectionLabel>
              {errors.map((iss, i) => (
                <IssueRow key={`err-${i}`} issue={iss} onJump={onJump} />
              ))}
            </>
          )}
          {warns.length > 0 && (
            <>
              <SectionLabel className="mt-5">Warnings</SectionLabel>
              {warns.map((iss, i) => (
                <IssueRow key={`warn-${i}`} issue={iss} onJump={onJump} />
              ))}
            </>
          )}
          <div className="mt-4 flex items-start gap-2 rounded-md border border-rv-accent-500/25 bg-rv-accent-500/[0.08] px-3 py-2.5">
            <Info size={14} className="mt-0.5 flex-shrink-0 text-rv-accent-500" />
            <div className="text-[12px] leading-relaxed text-rv-mute-700">
              <b className="text-foreground">Backend publish check.</b>
              <p className="m-0 mt-0.5">
                The publish endpoint also re-runs these checks server-side and rejects drafts with
                missing paywall, missing success, cycles, duplicate question_ids, or unresolved
                gotos.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-1.5 mt-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500",
        className,
      )}
    >
      {children}
    </div>
  );
}

function IssueRow({
  issue,
  onJump,
}: {
  issue: ValidationIssue;
  onJump: (issue: ValidationIssue) => void;
}) {
  const isError = issue.kind === "error";
  return (
    <div
      className={cn(
        "mb-2.5 rounded-md border bg-rv-c2 p-3",
        isError ? "border-rv-danger/30" : "border-rv-warning/30",
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded",
            isError
              ? "bg-rv-danger/15 text-rv-danger"
              : "bg-rv-warning/15 text-rv-warning",
          )}
        >
          <TriangleAlert size={12} />
        </div>
        <div className="text-[13px] font-semibold text-foreground">{issue.title}</div>
        <div className="ml-auto font-rv-mono text-[10px] text-rv-mute-500">{issue.where}</div>
      </div>
      <div className="mt-1.5 text-[12px] leading-relaxed text-rv-mute-700">{issue.desc}</div>
      <div className="mt-2.5">
        <button
          type="button"
          onClick={() => onJump(issue)}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-rv-divider bg-rv-c1 px-2.5 text-[11px] font-medium text-rv-mute-800 transition hover:bg-rv-c3 hover:text-foreground"
        >
          {issue.fix} <ArrowRight size={11} />
        </button>
      </div>
    </div>
  );
}
