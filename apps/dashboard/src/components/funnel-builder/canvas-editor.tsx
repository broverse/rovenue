import { useState } from "react";
import { component, useService } from "impair";
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
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const CanvasEditor = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const [addOpen, setAddOpen] = useState(false);
  const page = vm.selectedPage;
  if (!page) return null;
  const meta = PAGE_TYPES[page.type];
  const Ico = meta.icon;
  const idx = vm.selectedIdx;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-rv-bg">
      <div className="flex items-center gap-2 border-b border-rv-divider bg-rv-c1 px-4 py-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setAddOpen((o) => !o)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] font-medium text-foreground transition hover:bg-rv-c3"
          >
            <span className="flex h-4 w-4 items-center justify-center rounded bg-rv-accent-500 text-white">
              <Plus size={10} />
            </span>
            Add content
          </button>
          {addOpen && (
            <AddContentPopover
              onPick={() => setAddOpen(false)}
              onClose={() => setAddOpen(false)}
            />
          )}
        </div>

        <div className="mx-1 h-5 w-px bg-rv-divider" />

        <ToolBtn title="Theme & design" onClick={() => vm.setActiveTab("theme")}>
          <ImageIcon size={14} />
        </ToolBtn>
        <ToolBtn title="Device preview" onClick={() => vm.openPreview()}>
          <Smartphone size={14} />
        </ToolBtn>
        <ToolBtn title="Play through" onClick={() => vm.openPreview()}>
          <Play size={14} />
        </ToolBtn>
        <ToolBtn title="Accessibility check"><Eye size={14} /></ToolBtn>
        <ToolBtn title="Translations"><TypeIcon size={14} /></ToolBtn>
        <ToolBtn title="Page settings" onClick={() => vm.setActiveTab("settings")}>
          <Settings size={14} />
        </ToolBtn>

        <div className="ml-auto flex items-center gap-2 text-[11px]">
          <span className="font-rv-mono text-rv-mute-500">
            Page {idx + 1} of {vm.pages.length}
          </span>
          <span className="rounded border border-rv-divider bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
            {page.id}
          </span>
          {page.question_id && (
            <span className="rounded border border-rv-accent-500/40 bg-rv-accent-500/10 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-accent-500">
              @{page.question_id}
            </span>
          )}
        </div>
      </div>

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

      <div className="flex items-center justify-center gap-3 border-t border-rv-divider bg-rv-c1 py-2.5">
        <button
          type="button"
          onClick={() => vm.goPrev()}
          disabled={idx === 0}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="font-rv-mono text-[12px] tabular-nums text-rv-mute-600">
          {String(idx + 1).padStart(2, "0")} / {String(vm.pages.length).padStart(2, "0")}
        </div>
        <button
          type="button"
          onClick={() => vm.goNext()}
          disabled={idx === vm.pages.length - 1}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
});

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

const PageBody = component(({ page }: { page: Page }) => {
  const vm = useService(FunnelDraftViewModel);
  const hasFreeTitle =
    page.type !== "paywall" &&
    page.type !== "success" &&
    page.type !== "loading" &&
    page.type !== "result";

  const set = (patch: Partial<Page>) => vm.updatePage(page.id, patch);

  return (
    <>
      {hasFreeTitle && (
        <>
          <input
            value={page.title ?? ""}
            onChange={(e) => set({ title: e.currentTarget.value })}
            placeholder="Your question here. Recall information with @"
            className="w-full border-none bg-transparent text-[26px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-rv-mute-500"
          />
          <input
            value={page.subtitle ?? ""}
            onChange={(e) => set({ subtitle: e.currentTarget.value })}
            placeholder="Description (optional)"
            className="mt-2 w-full border-none bg-transparent text-[14px] leading-relaxed text-rv-mute-600 outline-none placeholder:text-rv-mute-500"
          />
        </>
      )}

      {(page.type === "single_choice" || page.type === "multi_choice") && (
        <div className="mt-6 flex flex-col gap-2">
          {(page.options ?? []).map((o, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2 py-1.5"
            >
              <GripVertical size={12} className="cursor-grab text-rv-mute-500" />
              <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-rv-divider bg-rv-c3 font-rv-mono text-[10px] font-bold text-rv-mute-600">
                {String.fromCharCode(65 + i)}
              </div>
              <input
                value={o.label}
                onChange={(e) => vm.updateOption(page.id, i, { label: e.currentTarget.value })}
                placeholder="Option label"
                className="flex-1 bg-transparent text-[13px] text-foreground outline-none"
              />
              <input
                value={o.value}
                onChange={(e) => vm.updateOption(page.id, i, { value: e.currentTarget.value })}
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
                  onClick={() => vm.removeOption(page.id, i)}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => vm.addOption(page.id)}
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
            {Math.round(((page.min ?? 0) + (page.max ?? 100)) / 2)}
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
            {Math.round(((page.min ?? 0) + (page.max ?? 100)) / 2)} {page.suffix ?? ""}
          </div>
          <div className="relative h-1.5 rounded-full bg-rv-c4">
            <div className="absolute inset-y-0 left-0 w-[32%] rounded-full bg-rv-accent-500" />
            <div className="absolute -top-1.5 left-[32%] h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-rv-accent-500 bg-white" />
          </div>
          <div className="mt-2 flex justify-between font-rv-mono text-[11px] text-rv-mute-500">
            <span>{page.min} {page.suffix}</span>
            <span>{page.max} {page.suffix}</span>
          </div>
        </div>
      )}

      {page.type === "loading" && (
        <>
          <input
            value={page.title ?? ""}
            onChange={(e) => set({ title: e.currentTarget.value })}
            placeholder="What should we show while loading?"
            className="w-full border-none bg-transparent text-[26px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-rv-mute-500"
          />
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
          <input
            value={page.title ?? ""}
            onChange={(e) => set({ title: e.currentTarget.value })}
            placeholder="Your result title — supports {{question_id}}"
            className="w-full border-none bg-transparent text-[26px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-rv-mute-500"
          />
          <div className="mt-4 rounded-lg border border-rv-divider bg-rv-c2 p-4">
            <div className="mb-1.5 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-violet">
              Result body
            </div>
            <textarea
              value={page.body ?? ""}
              onChange={(e) => set({ body: e.currentTarget.value })}
              rows={3}
              className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-rv-mute-700 outline-none"
            />
          </div>
        </>
      )}

      {page.type === "paywall" && (
        <>
          <input
            value={page.headline ?? ""}
            onChange={(e) => set({ headline: e.currentTarget.value })}
            placeholder="Headline — Unlock your plan"
            className="w-full border-none bg-transparent text-[26px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-rv-mute-500"
          />
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-rv-divider bg-rv-c2 px-3 py-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-gradient-to-br from-rv-warning to-[#fb923c] text-[13px] font-bold text-white">
              P
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {page.productId ? page.productId : "No product selected"}
              </div>
              <div className="font-rv-mono text-[11px] text-rv-mute-500">
                Pick a product in the side panel
              </div>
            </div>
          </div>
          <div className="mt-5 mb-1.5 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
            Benefits
          </div>
          <div className="flex flex-col gap-1.5">
            {(page.benefits ?? []).map((b, i) => (
              <div
                key={i}
                className="group flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2 py-1.5"
              >
                <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-rv-success/15 text-rv-success">
                  <Check size={12} />
                </div>
                <input
                  value={b}
                  onChange={(e) => {
                    const next = [...(page.benefits ?? [])];
                    next[i] = e.currentTarget.value;
                    set({ benefits: next });
                  }}
                  className="flex-1 bg-transparent text-[13px] text-foreground outline-none"
                />
                <button
                  type="button"
                  title="Remove"
                  onClick={() => {
                    const next = [...(page.benefits ?? [])];
                    next.splice(i, 1);
                    set({ benefits: next });
                  }}
                  className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 opacity-50 transition hover:bg-rv-c3 hover:text-rv-danger hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => set({ benefits: [...(page.benefits ?? []), "New benefit"] })}
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
          <input
            value={page.title ?? ""}
            onChange={(e) => set({ title: e.currentTarget.value })}
            placeholder="Success headline"
            className="w-full border-none bg-transparent text-center text-[26px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-rv-mute-500"
          />
          <input
            value={page.body ?? ""}
            onChange={(e) => set({ body: e.currentTarget.value })}
            placeholder="Body — what happens next"
            className="mt-2 w-full border-none bg-transparent text-center text-[14px] leading-relaxed text-rv-mute-600 outline-none placeholder:text-rv-mute-500"
          />
          <div className="mt-7 rounded-lg border border-rv-accent-500/30 bg-rv-accent-500/[0.08] p-4 text-center">
            <div className="mb-1.5 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-accent-500">
              Hand-off button
            </div>
            <input
              value={page.cta ?? ""}
              onChange={(e) => set({ cta: e.currentTarget.value })}
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
          <input
            value={page.title ?? ""}
            onChange={(e) => set({ title: e.currentTarget.value })}
            placeholder="Info screen title"
            className="w-full border-none bg-transparent text-[26px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-rv-mute-500"
          />
          <input
            value={page.subtitle ?? ""}
            onChange={(e) => set({ subtitle: e.currentTarget.value })}
            placeholder="Body — markdown supported"
            className="mt-2 w-full border-none bg-transparent text-[14px] leading-relaxed text-rv-mute-600 outline-none placeholder:text-rv-mute-500"
          />
          <div className="mt-6 rounded-lg border border-dashed border-rv-divider-strong bg-rv-c2 px-5 py-6 text-center text-[12px] text-rv-mute-500">
            <ImageIcon size={20} className="mx-auto mb-1.5 opacity-60" />
            <div>Optional hero image — drag here or set in properties</div>
          </div>
        </>
      )}
    </>
  );
});
