import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Eye,
  GripVertical,
  Image as ImageIcon,
  Play,
  Plus,
  Search,
  Settings,
  Smartphone,
  Type as TypeIcon,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import {
  PAGE_GROUPS,
  PAGE_TYPE_DESC,
  PAGE_TYPES,
  type Page,
  type PageType,
} from "./types";

type Props = {
  page: Page;
  allPages: Page[];
  idx: number;
  onPrev: () => void;
  onNext: () => void;
  onPreview: () => void;
};

/**
 * Center stage of the Content tab. Renders an editable card for the
 * selected page — input fields swap based on the page type, and the
 * toolbar exposes shared affordances (add content popover, preview,
 * accessibility check, etc.).
 */
export function CanvasEditor({ page, allPages, idx, onPrev, onNext, onPreview }: Props) {
  const meta = PAGE_TYPES[page.type];
  const Ico = meta.icon;
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-rv-bg">
      <CanvasToolbar
        idx={idx}
        total={allPages.length}
        pageId={page.id}
        questionId={page.question_id}
        addOpen={addOpen}
        onToggleAdd={() => setAddOpen((o) => !o)}
        onCloseAdd={() => setAddOpen(false)}
        onPreview={onPreview}
      />

      <div className="flex flex-1 items-start justify-center overflow-y-auto px-8 py-10">
        <div className="w-full max-w-[640px] rounded-2xl border border-rv-divider bg-rv-c1 px-8 py-9 shadow-[0_8px_28px_rgba(0,0,0,0.25)]">
          <div
            className={cn(
              "mb-4 inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-rv-mono text-[10px] font-semibold uppercase tracking-wider",
              meta.tone === "paywall"
                ? "border-rv-warning/30 bg-rv-warning/10 text-rv-warning"
                : meta.tone === "success"
                  ? "border-rv-success/30 bg-rv-success/10 text-rv-success"
                  : meta.tone === "result"
                    ? "border-rv-violet/30 bg-rv-violet/10 text-rv-violet"
                    : "border-rv-divider bg-rv-c2 text-rv-mute-600",
            )}
          >
            <Ico size={12} />
            {String(idx + 1).padStart(2, "0")} · {meta.label}
          </div>

          <PageBody page={page} />
        </div>
      </div>

      {/* Footer stepper */}
      <div className="flex items-center justify-center gap-3 border-t border-rv-divider bg-rv-c1 py-2.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={idx === 0}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="font-rv-mono text-[12px] tabular-nums text-rv-mute-600">
          {String(idx + 1).padStart(2, "0")} / {String(allPages.length).padStart(2, "0")}
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={idx === allPages.length - 1}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

function CanvasToolbar({
  idx,
  total,
  pageId,
  questionId,
  addOpen,
  onToggleAdd,
  onCloseAdd,
  onPreview,
}: {
  idx: number;
  total: number;
  pageId: string;
  questionId?: string;
  addOpen: boolean;
  onToggleAdd: () => void;
  onCloseAdd: () => void;
  onPreview: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-rv-divider bg-rv-c1 px-4 py-2">
      <div className="relative">
        <button
          type="button"
          onClick={onToggleAdd}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] font-medium text-foreground transition hover:bg-rv-c3"
        >
          <span className="flex h-4 w-4 items-center justify-center rounded bg-rv-accent-500 text-white">
            <Plus size={10} />
          </span>
          Add content
        </button>
        {addOpen && <AddContentPopover onPick={onCloseAdd} onClose={onCloseAdd} />}
      </div>

      <div className="mx-1 h-5 w-px bg-rv-divider" />

      <ToolBtn title="Theme & design"><ImageIcon size={14} /></ToolBtn>
      <ToolBtn title="Device preview" onClick={onPreview}><Smartphone size={14} /></ToolBtn>
      <ToolBtn title="Play through"><Play size={14} /></ToolBtn>
      <ToolBtn title="Accessibility check"><Eye size={14} /></ToolBtn>
      <ToolBtn title="Translations"><TypeIcon size={14} /></ToolBtn>
      <ToolBtn title="Page settings"><Settings size={14} /></ToolBtn>

      <div className="ml-auto flex items-center gap-2 text-[11px]">
        <span className="font-rv-mono text-rv-mute-500">
          Page {idx + 1} of {total}
        </span>
        <span className="rounded border border-rv-divider bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
          {pageId}
        </span>
        {questionId && (
          <span className="rounded border border-rv-accent-500/40 bg-rv-accent-500/10 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-accent-500">
            @{questionId}
          </span>
        )}
      </div>
    </div>
  );
}

function ToolBtn({
  title,
  children,
  onClick,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function AddContentPopover({
  onPick,
  onClose,
}: {
  onPick: (type: PageType) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[49]" onClick={onClose} />
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute left-0 top-9 z-50 w-[360px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.5)]"
      >
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2">
          <Search size={13} className="text-rv-mute-500" />
          <input
            autoFocus
            placeholder="Search content type… (e.g. paywall, slider)"
            className="h-7 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-rv-mute-500"
          />
        </div>
        {PAGE_GROUPS.map((g) => (
          <div key={g.label} className="mt-2">
            <div className="mb-1.5 px-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
              {g.label}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {g.types.map((t) => {
                const m = PAGE_TYPES[t];
                const I = m.icon;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onPick(t)}
                    className="flex cursor-pointer items-start gap-2 rounded border border-rv-divider bg-rv-c2 p-2 text-left transition hover:border-rv-accent-500 hover:bg-rv-c3"
                  >
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-rv-c3 text-rv-mute-600">
                      <I size={14} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-foreground">
                        {m.label}
                      </div>
                      <div className="text-[10px] text-rv-mute-500">
                        {PAGE_TYPE_DESC[t]}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PageBody({ page }: { page: Page }) {
  const hasFreeTitle =
    page.type !== "paywall" &&
    page.type !== "success" &&
    page.type !== "loading" &&
    page.type !== "result";

  return (
    <>
      {hasFreeTitle && (
        <>
          <TitleInput defaultValue={page.title} placeholder="Your question here. Recall information with @" />
          <SubInput defaultValue={page.subtitle} placeholder="Description (optional)" />
        </>
      )}

      {(page.type === "single_choice" || page.type === "multi_choice") && (
        <div className="mt-6 flex flex-col gap-2">
          {(page.options ?? []).map((o, i) => (
            <div
              key={`${o.value}-${i}`}
              className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2 py-1.5"
            >
              <GripVertical size={12} className="cursor-grab text-rv-mute-500" />
              <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-rv-divider bg-rv-c3 font-rv-mono text-[10px] font-bold text-rv-mute-600">
                {String.fromCharCode(65 + i)}
              </div>
              <input
                defaultValue={o.label}
                placeholder="Option label"
                className="flex-1 bg-transparent text-[13px] text-foreground outline-none"
              />
              <input
                defaultValue={o.value}
                className="w-32 rounded border border-rv-divider bg-rv-c1 px-2 py-1 font-rv-mono text-[11px] text-rv-mute-600 outline-none focus:border-rv-accent-500"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  title="Duplicate"
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground"
                >
                  <Copy size={11} />
                </button>
                <button
                  type="button"
                  title="Remove"
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="mt-1 inline-flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-3 text-[12px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
          >
            <Plus size={12} />
            Add choice
          </button>
        </div>
      )}

      {page.type === "number_input" && (
        <div className="mt-7 rounded-lg border border-rv-divider bg-rv-c2 px-6 py-6 text-center">
          <div className="font-rv-mono text-[44px] font-bold leading-none">
            32
            <span className="ml-1 text-[18px] font-normal text-rv-mute-500">
              {page.suffix}
            </span>
          </div>
          <div className="mt-2 font-rv-mono text-[11px] text-rv-mute-500">
            Range {page.min}–{page.max} · step {page.step}
          </div>
        </div>
      )}

      {page.type === "slider" && (
        <div className="mt-7 rounded-lg border border-rv-divider bg-rv-c2 px-6 py-6">
          <div className="mb-3.5 text-center font-rv-mono text-[36px] font-bold leading-none">
            72 kg
          </div>
          <div className="relative h-1.5 rounded-full bg-rv-c4">
            <div className="absolute inset-y-0 left-0 w-[32%] rounded-full bg-rv-accent-500" />
            <div className="absolute -top-1.5 left-[32%] h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-rv-accent-500 bg-white" />
          </div>
          <div className="mt-2 flex justify-between font-rv-mono text-[11px] text-rv-mute-500">
            <span>{page.min} kg</span>
            <span>{page.max} kg</span>
          </div>
        </div>
      )}

      {page.type === "loading" && (
        <>
          <TitleInput defaultValue={page.title} placeholder="What should we show while loading?" />
          <div className="mt-7 rounded-lg border border-rv-divider bg-rv-c2 px-10 py-10 text-center">
            <div className="mx-auto mb-4 h-14 w-14 animate-spin rounded-full border-4 border-rv-c4 border-t-rv-accent-500" />
            <div className="text-[14px] font-medium text-rv-mute-700">
              {(page.steps && page.steps[1]) || "Loading…"}
            </div>
            <div className="mt-2 font-rv-mono text-[11px] text-rv-mute-500">
              {(page.steps || []).length} steps · {((page.duration ?? 0) / 1000).toFixed(1)}s
            </div>
          </div>
        </>
      )}

      {page.type === "result" && (
        <>
          <TitleInput
            defaultValue={page.title}
            placeholder="Your result title — supports {{question_id}}"
          />
          <div className="mt-4 rounded-lg border border-rv-divider bg-rv-c2 p-4">
            <div className="mb-1.5 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-violet">
              Result body
            </div>
            <textarea
              defaultValue={page.body}
              rows={3}
              className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-rv-mute-700 outline-none"
            />
          </div>
        </>
      )}

      {page.type === "paywall" && (
        <>
          <TitleInput defaultValue={page.headline} placeholder="Headline — Unlock your plan" />
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-rv-divider bg-rv-c2 px-3 py-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-gradient-to-br from-rv-warning to-[#fb923c] text-[13px] font-bold text-white">
              P
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                Posely Pro · Annual
              </div>
              <div className="font-rv-mono text-[11px] text-rv-mute-500">
                {page.productId} · $79.99/yr · 7-day trial
              </div>
            </div>
            <button
              type="button"
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded border border-rv-divider bg-rv-c1 px-2 text-[11px] font-medium text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
            >
              <ArrowRight size={11} />
              Change
            </button>
          </div>
          <div className="mt-5 mb-1.5 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
            Benefits
          </div>
          <div className="flex flex-col gap-1.5">
            {(page.benefits ?? []).map((b) => (
              <div
                key={b}
                className="group flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2 py-1.5"
              >
                <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-rv-success/15 text-rv-success">
                  <Check size={12} />
                </div>
                <input
                  defaultValue={b}
                  className="flex-1 bg-transparent text-[13px] text-foreground outline-none"
                />
                <button
                  type="button"
                  title="Remove"
                  className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 opacity-50 transition hover:bg-rv-c3 hover:text-rv-danger hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="mt-1 inline-flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-3 text-[12px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
            >
              <Plus size={12} />
              Add benefit
            </button>
          </div>
        </>
      )}

      {page.type === "success" && (
        <>
          <div className="flex flex-col items-center pb-4 pt-2">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-rv-success/15 text-rv-success">
              <Check size={28} />
            </div>
          </div>
          <TitleInput defaultValue={page.title} placeholder="Success headline" centered />
          <SubInput defaultValue={page.body} placeholder="Body — what happens next" centered />
          <div className="mt-7 rounded-lg border border-rv-accent-500/30 bg-rv-accent-500/[0.08] p-4 text-center">
            <div className="mb-1.5 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-accent-500">
              Hand-off button
            </div>
            <input
              defaultValue={page.cta}
              className="mx-auto block w-full max-w-[240px] rounded border border-rv-divider bg-rv-c1 px-3 py-1.5 text-center text-[13px] text-foreground outline-none focus:border-rv-accent-500"
            />
            <div className="mt-2 font-rv-mono text-[11px] text-rv-mute-500">
              Opens universal-link → app store fallback
            </div>
          </div>
        </>
      )}

      {page.type === "info" && (
        <>
          <TitleInput defaultValue={page.title} placeholder="Info screen title" />
          <SubInput defaultValue={page.subtitle} placeholder="Body — markdown supported" />
          <div className="mt-6 rounded-lg border border-dashed border-rv-divider-strong bg-rv-c2 px-5 py-6 text-center text-[12px] text-rv-mute-500">
            <ImageIcon size={20} className="mx-auto mb-1.5 opacity-60" />
            <div>Optional hero image — drag here or set in properties</div>
          </div>
        </>
      )}
    </>
  );
}

function TitleInput({
  defaultValue,
  placeholder,
  centered,
}: {
  defaultValue?: string;
  placeholder?: string;
  centered?: boolean;
}) {
  return (
    <input
      defaultValue={defaultValue ?? ""}
      placeholder={placeholder}
      className={cn(
        "w-full border-none bg-transparent text-[26px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-rv-mute-500",
        centered && "text-center",
      )}
    />
  );
}

function SubInput({
  defaultValue,
  placeholder,
  centered,
}: {
  defaultValue?: string;
  placeholder?: string;
  centered?: boolean;
}) {
  return (
    <input
      defaultValue={defaultValue ?? ""}
      placeholder={placeholder}
      className={cn(
        "mt-2 w-full border-none bg-transparent text-[14px] leading-relaxed text-rv-mute-600 outline-none placeholder:text-rv-mute-500",
        centered && "text-center",
      )}
    />
  );
}
