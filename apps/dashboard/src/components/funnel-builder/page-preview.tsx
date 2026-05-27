import { Check, GitBranch, GripVertical, X } from "lucide-react";
import { useService } from "impair";
import type { CSSProperties } from "react";
import { PAGE_TYPES, type Page, type Theme } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

type Props = {
  page: Page;
  theme: Theme;
  // When `editable`, choice rows surface hover affordances (drag handle on
  // the left, delete + branch icons on the right) and an "Add choice"
  // button appears below the list. The CanvasEditor turns this on; the
  // play-through PreviewOverlay and ThemeTab live preview leave it off.
  editable?: boolean;
};

/**
 * Renders the mobile-screen preview for a single funnel page.
 * Pure presentation when `editable` is false — colors come from `theme`.
 * When `editable`, in-place edit affordances appear on hover.
 */
export function PagePreview({ page, theme, editable = false }: Props) {
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
        {(page.type === "single_choice" || page.type === "multi_choice") &&
          (editable ? (
            <ChoiceListEditable page={page} theme={theme} />
          ) : (
            <ChoiceListReadOnly page={page} theme={theme} />
          ))}
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

// ---------- Choice list ----------

function ChoiceListReadOnly({ page, theme }: { page: Page; theme: Theme }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {(page.options || []).slice(0, 6).map((o, i) => (
        <div
          key={i}
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
  );
}

function ChoiceListEditable({ page, theme }: { page: Page; theme: Theme }) {
  const vm = useService(FunnelDraftViewModel);
  const options = page.options ?? [];

  // HTML5 drag-and-drop reordering. dataTransfer carries the source index;
  // dragover preventDefault is required for drop to fire.
  const onDragStart = (e: React.DragEvent, i: number) => {
    e.dataTransfer.setData("text/plain", String(i));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (e: React.DragEvent, to: number) => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isFinite(from) && from !== to) {
      vm.reorderOption(page.id, from, to);
    }
  };

  // Seed a draft branching rule for this option (question_id eq value) and
  // jump to the Workflow tab so the user can pick the goto target.
  const onBranch = (optionValue: string) => {
    if (!page.question_id) return;
    vm.addRule(page.id, {
      id: Math.random().toString(36).slice(2, 10),
      condition: {
        op: "all",
        clauses: [
          {
            question_id: page.question_id,
            op: "eq",
            value: optionValue,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ],
      },
      goto: "end",
    });
    vm.setActiveTab("workflow");
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      {options.map((o, i) => (
        <div
          key={i}
          onDragOver={onDragOver}
          onDrop={(e) => onDrop(e, i)}
          className="group relative flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px]"
          style={{
            background: "white",
            border: `1px solid ${i === 0 ? theme.primary : "rgba(0,0,0,0.08)"}`,
            boxShadow: i === 0 ? `0 0 0 2px ${theme.primary}25` : undefined,
          }}
        >
          {/* Drag handle (left, hover-only) */}
          <button
            type="button"
            draggable
            onDragStart={(e) => onDragStart(e, i)}
            title="Drag to reorder"
            className="absolute -left-7 top-1/2 hidden -translate-y-1/2 cursor-grab items-center justify-center text-rv-mute-500 group-hover:flex hover:text-foreground active:cursor-grabbing"
            style={{ color: "rgba(0,0,0,0.5)" }}
          >
            <GripVertical size={14} />
          </button>

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
          <span className="min-w-0 flex-1 truncate">{o.label}</span>

          {/* Hover actions (right, outside the card) */}
          <div className="absolute -right-16 top-1/2 hidden -translate-y-1/2 items-center gap-1 group-hover:flex">
            <button
              type="button"
              onClick={() => vm.removeOption(page.id, i)}
              title="Delete option"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border bg-white text-rv-danger transition hover:scale-110"
              style={{ borderColor: "rgba(0,0,0,0.12)" }}
            >
              <X size={12} />
            </button>
            {page.question_id && (
              <button
                type="button"
                onClick={() => onBranch(o.value)}
                title="Branch from this option"
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border bg-white text-rv-mute-700 transition hover:scale-110"
                style={{ borderColor: "rgba(0,0,0,0.12)" }}
              >
                <GitBranch size={12} />
              </button>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => vm.addOption(page.id)}
        className="mt-1 self-start text-[12px] font-medium"
        style={{ color: theme.primary }}
      >
        + Add choice
      </button>
    </div>
  );
}
