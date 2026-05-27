import { ArrowLeft, ArrowRight, X } from "lucide-react";
import type { Page, Theme } from "./types";
import { PagePreview } from "./page-preview";

type Props = {
  pages: Page[];
  currentId: string;
  theme: Theme;
  onClose: () => void;
  onSelect: (id: string) => void;
};

/**
 * Full-screen overlay with a phone frame showing the active page as
 * it would render in production. Arrow controls step through pages
 * without leaving the overlay.
 */
export function PreviewOverlay({ pages, currentId, theme, onClose, onSelect }: Props) {
  const idx = pages.findIndex((p) => p.id === currentId);
  const page = pages[idx];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-5 bg-black/85 px-4 py-8 backdrop-blur-md"
    >
      <button
        type="button"
        onClick={onClose}
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
          <PagePreview page={page} theme={theme} />
        </div>
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-3 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur"
      >
        <button
          type="button"
          onClick={() => idx > 0 && onSelect(pages[idx - 1].id)}
          disabled={idx === 0}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowLeft size={12} />
        </button>
        <div className="font-rv-mono tabular-nums">
          {String(idx + 1).padStart(2, "0")} / {String(pages.length).padStart(2, "0")} · {page.id}
        </div>
        <button
          type="button"
          onClick={() => idx < pages.length - 1 && onSelect(pages[idx + 1].id)}
          disabled={idx === pages.length - 1}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}
