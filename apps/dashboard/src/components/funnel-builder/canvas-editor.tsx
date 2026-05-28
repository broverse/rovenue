import { useCallback, useRef, useState } from "react";
import { component, useService } from "impair";
import {
  ArrowLeft,
  ArrowRight,
  Maximize,
  Minus,
  Monitor,
  Play,
  Plus,
  Smartphone,
  Tablet,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { AddContentPopover } from "./add-content-popover";
import { blankPage } from "./blank-page";
import { PagePreview } from "./page-preview";

type Device = "phone" | "tablet" | "desktop";

// Outer chrome + screen viewport per device. Phone/tablet wrap with a
// physical frame (rounded chassis, notch); desktop renders a flat 16:10
// monitor. Heights drive the aspect ratio inside the scroll container.
const DEVICE_FRAMES: Record<
  Device,
  { label: string; icon: typeof Smartphone; outer: string; screen: string; notch: boolean }
> = {
  phone: {
    label: "Phone",
    icon: Smartphone,
    outer: "h-[640px] w-[320px] rounded-[44px] border border-white/15 bg-rv-c1 p-2",
    screen: "rounded-[36px]",
    notch: true,
  },
  tablet: {
    label: "Tablet",
    icon: Tablet,
    outer: "h-[760px] w-[560px] rounded-[28px] border border-white/15 bg-rv-c1 p-3",
    screen: "rounded-[18px]",
    notch: false,
  },
  desktop: {
    label: "Desktop",
    icon: Monitor,
    outer:
      "h-[600px] w-[900px] rounded-[12px] border border-white/15 bg-rv-c1 p-2 shadow-[0_28px_60px_rgba(0,0,0,0.5)]",
    screen: "rounded-[6px]",
    notch: false,
  },
};

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const CanvasEditor = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const [addOpen, setAddOpen] = useState(false);
  // Callback ref binds the native wheel listener directly during React's
  // commit phase — bypasses useEffect entirely, which impair's component()
  // wrapper doesn't reliably invoke for inner-rendered hooks. Cleanup
  // ref keeps the prior listener so we can detach on element swap/unmount.
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const setCanvasEl = useCallback(
    (el: HTMLDivElement | null) => {
      // Tear down the previous binding regardless of new element.
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        vm.handleCanvasWheel(e.deltaY, e.ctrlKey);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanupRef.current = () => el.removeEventListener("wheel", onWheel);
    },
    [vm],
  );

  const page = vm.selectedPage;
  if (!page) return null;
  const device = vm.canvasDevice;
  const zoom = vm.canvasZoom;
  const idx = vm.selectedIdx;
  const frame = DEVICE_FRAMES[device];

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
            Add page
          </button>
          {addOpen && (
            <AddContentPopover
              onPick={(t) => {
                setAddOpen(false);
                vm.addPage(blankPage(t, vm.defaultLocale), page.id);
              }}
              onClose={() => setAddOpen(false)}
            />
          )}
        </div>

        <div className="mx-1 h-5 w-px bg-rv-divider" />

        {/* Device segmented switcher */}
        <div className="inline-flex rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {(Object.keys(DEVICE_FRAMES) as Device[]).map((d) => {
            const D = DEVICE_FRAMES[d];
            const Ico = D.icon;
            const active = device === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => vm.setCanvasDevice(d)}
                title={D.label}
                className={cn(
                  "flex h-6 w-7 cursor-pointer items-center justify-center rounded transition",
                  active ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
                )}
              >
                <Ico size={13} />
              </button>
            );
          })}
        </div>

        <div className="inline-flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 px-0.5">
          <button
            type="button"
            onClick={() => vm.zoomStep(-1)}
            title="Zoom out"
            disabled={zoom === ZOOM_STEPS[0]}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={() => vm.setCanvasZoom(1)}
            title="Reset zoom (1×)"
            className="min-w-[44px] cursor-pointer rounded px-1 font-rv-mono text-[11px] tabular-nums text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => vm.zoomStep(1)}
            title="Zoom in"
            disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={12} />
          </button>
        </div>
        <ToolBtn title="Fit to canvas (1×)" onClick={() => vm.setCanvasZoom(1)}>
          <Maximize size={13} />
        </ToolBtn>

        <ToolBtn title="Play through" onClick={() => vm.openPreview()}>
          <Play size={14} />
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

      <div
        ref={setCanvasEl}
        className="relative flex flex-1 items-center justify-center overflow-auto bg-gradient-to-b from-rv-c1 to-rv-bg p-8"
      >
        {/* Floating page navigator — top-right of the canvas. Independent
            of the bottom strip so the user can flip pages without leaving
            the preview area. */}
        <div className="pointer-events-none absolute right-4 top-4 z-20 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => vm.goPrev()}
            disabled={idx === 0}
            title="Previous page"
            className="pointer-events-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-rv-divider bg-rv-c1/90 text-rv-mute-600 shadow-sm backdrop-blur-sm transition hover:bg-rv-c2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => vm.goNext()}
            disabled={idx === vm.pages.length - 1}
            title="Next page"
            className="pointer-events-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-rv-divider bg-rv-c1/90 text-rv-mute-600 shadow-sm backdrop-blur-sm transition hover:bg-rv-c2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowRight size={14} />
          </button>
        </div>
        <div
          style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
          className="transition-transform duration-150"
        >
          <div className={cn("relative", frame.outer)}>
            <div className={cn("relative h-full w-full overflow-hidden bg-white", frame.screen)}>
              {frame.notch && (
                <div className="absolute left-1/2 top-2 z-10 h-1.5 w-20 -translate-x-1/2 rounded-full bg-black/40" />
              )}
              <PagePreview page={page} theme={vm.theme} pages={vm.pages} editable />
            </div>
          </div>
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
