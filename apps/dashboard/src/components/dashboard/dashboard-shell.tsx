import { useState, type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar, type DateRange } from "./topbar";

type Props = {
  projectId: string;
  projectName: string;
  envLabel?: string;
  /** Page title shown in the topbar breadcrumb (e.g. "Overview"). */
  current: string;
  /** Initial date range; the topbar manages the rest internally. */
  initialRange?: DateRange;
  /** Render-prop receives `{ range, liveOn }` for pages that want to react. */
  children: ((ctx: { range: DateRange; liveOn: boolean }) => ReactNode) | ReactNode;
};

/**
 * App-shell wrapper for every project-scoped page. Holds the sidebar +
 * topbar state (date range, live ticker) and renders children inside the
 * scrolling content column. Forces dark mode so HeroUI tokens align with
 * the Rovenue dashboard palette.
 */
export function DashboardShell({
  projectId,
  projectName,
  envLabel,
  current,
  initialRange = "Last 28 days",
  children,
}: Props) {
  const [range, setRange] = useState<DateRange>(initialRange);
  const [liveOn, setLiveOn] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="dark min-h-screen bg-rv-bg font-[Geist,ui-sans-serif,system-ui,sans-serif] text-foreground antialiased">
      <Sidebar
        projectId={projectId}
        projectName={projectName}
        envLabel={envLabel}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      />

      {mobileNavOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/55 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}

      <div className="flex min-w-0 flex-col lg:ml-60">
        <Topbar
          projectName={projectName}
          current={current}
          range={range}
          onRangeChange={setRange}
          liveOn={liveOn}
          onToggleLive={() => setLiveOn((v) => !v)}
          onMenuClick={() => setMobileNavOpen(true)}
        />
        <div className="mx-auto w-full max-w-[1536px] px-4 pb-10 pt-5 sm:px-6">
          {typeof children === "function" ? children({ range, liveOn }) : children}
        </div>
      </div>
    </div>
  );
}
