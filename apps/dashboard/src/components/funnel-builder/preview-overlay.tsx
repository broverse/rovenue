import { component, useService, useResolve } from "impair";
import { ArrowLeft, ArrowRight, RotateCcw, X } from "lucide-react";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { FunnelPreviewViewModel } from "./vm/funnel-preview.vm";
import { PagePreview } from "./page-preview";

export const PreviewOverlay = component(() => {
  const draft = useService(FunnelDraftViewModel);
  const preview = useResolve(FunnelPreviewViewModel, {
    pages: draft.pages,
    rules: draft.rules,
    defaultNext: draft.defaultNext,
    startId: draft.selectedPageId,
  });

  const idx = preview.currentPage
    ? draft.pages.findIndex((p) => p.id === preview.currentPage!.id)
    : -1;

  return (
    <div
      onClick={() => draft.closePreview()}
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-5 bg-black/85 px-4 py-8 backdrop-blur-md"
    >
      <button
        type="button"
        onClick={() => draft.closePreview()}
        aria-label="Close preview"
        className="absolute right-5 top-5 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/10 text-white transition hover:bg-white/20"
      >
        <X size={16} />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="h-[640px] w-[320px] rounded-[44px] border border-white/15 bg-rv-c1 p-2 shadow-[0_28px_60px_rgba(0,0,0,0.8)]"
      >
        <div className="relative h-full w-full overflow-hidden rounded-[36px]">
          <div className="absolute left-1/2 top-2 z-10 h-2 w-20 -translate-x-1/2 rounded-full bg-black/50" />
          {preview.currentPage ? (
            <PagePreview page={preview.currentPage} theme={draft.theme} />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-white text-[14px] text-rv-mute-700">
              {preview.finished ? "Done — end of funnel" : "No page"}
            </div>
          )}
        </div>
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-3 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur"
      >
        <button
          type="button"
          onClick={() => preview.reset()}
          title="Restart"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full hover:bg-white/15"
        >
          <RotateCcw size={12} />
        </button>
        <button
          type="button"
          onClick={() => {
            // Step back along the static page order — preview doesn't track
            // history, so this is a coarse "go to previous page" rather than
            // "undo last answer". Good enough for the editor's spot-check.
            if (idx > 0) {
              const prevId = draft.pages[idx - 1].id;
              preview.reset();
              for (let i = 0; i < idx - 1; i++) preview.answerAndAdvance(null, null);
              if (preview.currentPage?.id !== prevId) {
                preview.answerAndAdvance(null, null);
              }
            }
          }}
          disabled={idx <= 0}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowLeft size={12} />
        </button>
        <div className="font-rv-mono tabular-nums">
          {preview.currentPage
            ? `${String(idx + 1).padStart(2, "0")} / ${String(draft.pages.length).padStart(2, "0")} · ${preview.currentPage.id}`
            : "end"}
        </div>
        <button
          type="button"
          onClick={() => preview.answerAndAdvance(null, null)}
          disabled={preview.finished}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
});
