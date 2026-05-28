import { Sparkles } from "lucide-react";

// Suggested-prompt chips shown when the thread is empty. Clicking a
// chip pre-fills the composer AND auto-submits via `onPickPrompt`
// (wired up by `RoviPanel` → `sendMessage`).
//
// Copy is deliberately a mix of read-only queries ("How is MRR
// trending?") and mutation requests ("Refund the last failed charge…")
// to remind the user that Rovi can do both — mutations still surface
// an approval card before anything ships.
const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: "How is MRR trending this month?",
    prompt: "How is MRR trending this month? Show the daily breakdown.",
  },
  {
    label: "Find churned users this month",
    prompt:
      "List subscribers who churned in the last 30 days, sorted by lifetime revenue.",
  },
  {
    label: "Gross sales by product SKU",
    prompt: "Show me product gross sales by SKU for the last 7 days.",
  },
  {
    label: "Refund last failed charge for sub_xxx",
    prompt:
      "Refund the last failed charge for subscriber sub_xxx and pause their subscription.",
  },
];

export function RoviEmptyState({
  onPickPrompt,
}: {
  onPickPrompt?: (prompt: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-8">
      <div className="relative mb-5">
        {/* Soft ambient glow behind the icon — uses the rv-pulse
            keyframe that already lives in index.css. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 rounded-full bg-foreground/[0.06] blur-xl"
        />
        <div className="flex size-12 items-center justify-center rounded-2xl border border-rv-divider bg-gradient-to-b from-rv-c2 to-rv-c1 text-foreground shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
          <Sparkles size={20} strokeWidth={1.75} />
        </div>
      </div>

      <p className="text-center text-[15px] font-medium tracking-tight text-foreground">
        Ask Rovi
      </p>
      <p className="mt-1.5 max-w-[300px] text-balance text-center text-[12.5px] leading-relaxed text-rv-mute-600">
        Query subscribers, dig into metrics, or kick off an action. Mutations
        always wait for your approval first.
      </p>

      <div className="mt-6 grid w-full max-w-[360px] grid-cols-1 gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.prompt}
            type="button"
            onClick={() => onPickPrompt?.(s.prompt)}
            disabled={!onPickPrompt}
            className="group flex items-center justify-between gap-3 rounded-xl border border-rv-divider bg-rv-c1 px-3 py-2.5 text-left text-[12.5px] text-rv-mute-700 transition hover:border-rv-divider-strong hover:bg-rv-c2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="truncate">{s.label}</span>
            <span
              aria-hidden="true"
              className="shrink-0 text-rv-mute-500 transition group-hover:translate-x-0.5 group-hover:text-rv-mute-700"
            >
              ↗
            </span>
          </button>
        ))}
      </div>

      <p className="mt-6 text-[10.5px] uppercase tracking-[0.18em] text-rv-mute-500">
        Press <span className="font-rv-mono normal-case">⌘K</span> to focus
      </p>
    </div>
  );
}
