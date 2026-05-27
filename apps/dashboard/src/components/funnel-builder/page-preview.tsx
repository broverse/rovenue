import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import { PAGE_TYPES, type Page, type Theme } from "./types";

type Props = {
  page: Page;
  theme: Theme;
};

/**
 * Renders the mobile-screen preview for a single funnel page.
 * Pure presentational — colors come from `theme`, no editing affordances.
 * Used inside the Theme tab's live preview and the full-screen preview overlay.
 */
export function PagePreview({ page, theme }: Props) {
  const meta = PAGE_TYPES[page.type];
  const style: CSSProperties = {
    background: theme.bg,
    color: theme.text,
  };
  const stepProgress = 4 / 9;
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-[28px] px-4 pb-4 pt-2"
      style={style}
    >
      <div className="flex items-center justify-between px-1 py-1 text-[10px] font-medium opacity-70">
        <span>9:41</span>
        <span>● ● ●</span>
      </div>
      <div
        className="mx-auto mt-2 flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-bold text-white"
        style={{ background: theme.primary }}
      >
        {theme.logoLetter || "F"}
      </div>
      {page.type !== "paywall" && page.type !== "success" && (
        <div className="mt-3 px-1">
          <div className="h-1 overflow-hidden rounded-full bg-black/10">
            <span
              className="block h-full rounded-full"
              style={{ width: `${stepProgress * 100}%`, background: theme.primary }}
            />
          </div>
          <div className="mt-1.5 text-center text-[10px] opacity-60">Step 4 of 9</div>
        </div>
      )}
      <div className="mt-4 flex flex-1 flex-col gap-2 overflow-hidden">
        <h1 className="m-0 text-[18px] font-semibold leading-tight tracking-tight">
          {page.title || meta.label}
        </h1>
        {page.subtitle && (
          <p className="m-0 text-[12px] leading-relaxed opacity-70">{page.subtitle}</p>
        )}
        {(page.type === "single_choice" || page.type === "multi_choice") && (
          <div className="mt-2 flex flex-col gap-2">
            {(page.options || []).slice(0, 4).map((o, i) => (
              <div
                key={o.value}
                className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px]"
                style={{
                  background: "white",
                  border: `1px solid ${i === 0 ? theme.primary : "rgba(0,0,0,0.08)"}`,
                  boxShadow: i === 0 ? `0 0 0 2px ${theme.primary}25` : undefined,
                }}
              >
                <span
                  className="block flex-shrink-0"
                  style={{
                    width: 14,
                    height: 14,
                    border: `1.5px solid ${theme.primary}`,
                    borderRadius: page.type === "multi_choice" ? 3 : "50%",
                    background: i === 0 ? theme.primary : "transparent",
                  }}
                />
                {o.label}
              </div>
            ))}
          </div>
        )}
        {page.type === "paywall" && (
          <>
            <h2 className="mt-1 text-[18px] font-semibold leading-tight tracking-tight">
              {page.headline}
            </h2>
            <div className="mt-2 flex flex-col gap-2">
              {(page.benefits || []).map((b) => (
                <div key={b} className="flex items-center gap-2 text-[12px]">
                  <span
                    className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-white"
                    style={{ background: theme.primary }}
                  >
                    <Check size={10} />
                  </span>
                  {b}
                </div>
              ))}
            </div>
          </>
        )}
        {page.type === "success" && (
          <div className="flex flex-col items-center px-2 py-4 text-center">
            <div
              className="mb-3 flex h-14 w-14 items-center justify-center rounded-full"
              style={{
                background: `color-mix(in srgb, ${theme.primary} 18%, transparent)`,
                color: theme.primary,
              }}
            >
              <Check size={28} />
            </div>
            <h2 className="m-0 text-[18px] font-semibold leading-tight tracking-tight">
              {page.title}
            </h2>
            <p className="mt-1.5 text-[12px] leading-relaxed opacity-70">{page.body}</p>
          </div>
        )}
      </div>
      {(page.type === "single_choice" || page.type === "multi_choice") && (
        <button
          type="button"
          className="mt-3 h-10 w-full rounded-lg text-[13px] font-semibold text-white"
          style={{ background: theme.primary }}
        >
          Continue
        </button>
      )}
      {page.type === "paywall" && (
        <button
          type="button"
          className="mt-3 h-10 w-full rounded-lg text-[13px] font-semibold text-white"
          style={{ background: theme.primary }}
        >
          Start free trial
        </button>
      )}
      {page.type === "success" && (
        <button
          type="button"
          className="mt-3 h-10 w-full rounded-lg text-[13px] font-semibold text-white"
          style={{ background: theme.primary }}
        >
          {page.cta || "Open app"}
        </button>
      )}
    </div>
  );
}
