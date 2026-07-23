import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { component, useService } from "impair";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Maximize, Minus, Plus } from "lucide-react";
import { PaywallRenderer } from "@rovenue/paywall-renderer";
import type { DashboardOfferingRow } from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { rpc, unwrap } from "../../lib/api";
import { useOfferingById } from "../../lib/hooks/useProjectOfferings";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import {
  buildEligibilityMap,
  computeSelectionRect,
  placeholderPriceView,
  toRendererOffering,
  type Rect,
} from "./canvas-helpers";
import { deviceById, devicesForPlatform } from "./device-catalog";
import { DeviceFrame } from "./device-frame";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
// All-sizes mode ignores the live zoom and renders every device at a fixed
// scale so the whole platform fits in a scrolling row.
const ALL_SIZES_SCALE = 0.64;

interface ProductNameDto {
  id: string;
  displayName: string;
}

/** Resolves offering package -> product displayName for the canvas preview only. */
function useProductDisplayNames(projectId: string) {
  return useQuery({
    queryKey: ["paywall-builder-product-names", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ products: ProductNameDto[]; nextCursor: string | null }>(
        rpc.dashboard.projects[":projectId"].products.$get({
          param: { projectId },
          query: {},
        }),
      ),
    select: (r) => new Map(r.products.map((p) => [p.id, p.displayName])),
  });
}

function noop() {
  // Preview canvas: purchase/close/restore/url are inert — this is a design surface, not a live paywall.
}

export const Canvas = component(() => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);

  const offeringQuery = useOfferingById(vm.projectId, vm.paywall?.offeringId ?? null);
  const { data: displayNameById = new Map<string, string>() } = useProductDisplayNames(vm.projectId);

  const offering = useMemo(
    () => toRendererOffering(offeringQuery.data?.offering as DashboardOfferingRow | undefined, displayNameById),
    [offeringQuery.data, displayNameById],
  );
  const priceView = useMemo(() => placeholderPriceView(offering), [offering]);
  const eligibility = useMemo(
    () => buildEligibilityMap(offering, vm.previewEligible),
    [offering, vm.previewEligible],
  );

  // The renderer's package selection is one-shot (useState initializer) —
  // remount it whenever `config`'s identity changes so structural edits
  // (e.g. picking a different defaultSelected, adding/removing packages)
  // are always reflected instead of showing a stale selection.
  const prevConfigRef = useRef(vm.config);
  const revisionRef = useRef(0);
  if (prevConfigRef.current !== vm.config) {
    prevConfigRef.current = vm.config;
    revisionRef.current += 1;
  }
  const rendererKey = `${revisionRef.current}`;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const setViewportEl = useCallback(
    (el: HTMLDivElement | null) => {
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
      viewportRef.current = el;
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

  const [ring, setRing] = useState<Rect | null>(null);
  // Bumped by viewport scroll / window resize so the ring re-anchors —
  // without this it drifts off the selected node until a zoom/device/
  // selection change forces a recompute (whole-phase review follow-up).
  const [ringTick, setRingTick] = useState(0);

  useLayoutEffect(() => {
    const container = viewportRef.current;
    const bump = () => setRingTick((t) => t + 1);
    container?.addEventListener("scroll", bump, { passive: true });
    window.addEventListener("resize", bump);
    return () => {
      container?.removeEventListener("scroll", bump);
      window.removeEventListener("resize", bump);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererKey]);

  useLayoutEffect(() => {
    const container = viewportRef.current;
    const id = vm.selectedNodeId;
    if (!container || !id) {
      setRing(null);
      return;
    }
    const target = container.querySelector<HTMLElement>(`[data-rov-node="${CSS.escape(id)}"]`);
    if (!target) {
      setRing(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    setRing(
      computeSelectionRect(
        { left: containerRect.left, top: containerRect.top },
        { left: container.scrollLeft, top: container.scrollTop },
        {
          left: targetRect.left,
          top: targetRect.top,
          width: targetRect.width,
          height: targetRect.height,
        },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm.selectedNodeId, rendererKey, vm.canvasZoom, vm.canvasDevice, ringTick]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest("[data-rov-node]");
      if (!el) return;
      const id = el.getAttribute("data-rov-node");
      if (id) vm.selectNode(id);
    },
    [vm],
  );

  const zoom = vm.canvasZoom;
  const spec = deviceById(vm.canvasDevice);

  // Factored so the single-device and all-sizes branches share one renderer
  // element; each DeviceFrame is a distinct parent, so React mounts an
  // independent renderer instance per frame.
  const renderPaywall = (
    <div onClick={handleClick} className="min-h-full">
      <PaywallRenderer
        key={rendererKey}
        config={vm.config}
        offering={offering}
        locale={vm.editLocale}
        colorScheme={vm.colorScheme}
        priceView={priceView}
        eligibility={eligibility}
        onPurchase={noop}
        onClose={noop}
        onRestore={noop}
        onUrl={noop}
      />
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-rv-bg">
      <div className="flex items-center gap-2 border-b border-rv-divider bg-rv-c1 px-4 py-2">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 px-0.5">
          <button
            type="button"
            onClick={() => vm.zoomStep(-1)}
            title={t("paywalls.builder.canvas.zoomOut", "Zoom out")}
            disabled={vm.showAllSizes || zoom === ZOOM_STEPS[0]}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={() => vm.resetCanvasZoom()}
            title={t("paywalls.builder.canvas.zoomReset", "Reset zoom (1×)")}
            className="min-w-[44px] cursor-pointer rounded px-1 font-rv-mono text-[11px] tabular-nums text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => vm.zoomStep(1)}
            title={t("paywalls.builder.canvas.zoomIn", "Zoom in")}
            disabled={vm.showAllSizes || zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={12} />
          </button>
        </div>
        <button
          type="button"
          title={t("paywalls.builder.canvas.fit", "Fit to canvas (1×)")}
          onClick={() => vm.resetCanvasZoom()}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
        >
          <Maximize size={13} />
        </button>

        <div className="mx-1 h-5 w-px bg-rv-divider" />

        {/* platform segment */}
        <div className="inline-flex rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {(["ios", "android"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => vm.setCanvasPlatform(p)}
              className={cn(
                "cursor-pointer rounded px-2 py-1 text-[11px] font-medium capitalize transition",
                vm.canvasPlatform === p ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {p === "ios" ? "iOS" : "Android"}
            </button>
          ))}
        </div>

        {/* device dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setDeviceMenuOpen((o) => !o)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[11px] text-foreground transition hover:bg-rv-c3"
          >
            {deviceById(vm.canvasDevice).label}
            <span className="font-rv-mono text-[10px] text-rv-mute-500">
              {deviceById(vm.canvasDevice).w}×{deviceById(vm.canvasDevice).h}
            </span>
          </button>
          {deviceMenuOpen && (
            <>
              <div className="fixed inset-0 z-[49]" onClick={() => setDeviceMenuOpen(false)} />
              <div className="absolute left-0 top-full z-50 mt-1 w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
                <div className="mb-1 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                  {t("paywalls.builder.canvas.devices", "{{platform}} devices", { platform: vm.canvasPlatform })}
                </div>
                {devicesForPlatform(vm.canvasPlatform).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      vm.setCanvasDevice(d.id);
                      vm.setAllSizes(false);
                      setDeviceMenuOpen(false);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px]",
                      d.id === vm.canvasDevice ? "bg-rv-c2 text-foreground" : "text-foreground hover:bg-rv-c2",
                    )}
                  >
                    <span>{d.label}</span>
                    <span className="font-rv-mono text-[10px] text-rv-mute-500">{d.w}×{d.h}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* all-sizes + safe-area chips */}
        <button
          type="button"
          onClick={() => vm.toggleAllSizes()}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
            vm.showAllSizes
              ? "border-rv-accent-500/40 bg-rv-accent-500/10 text-rv-accent-500"
              : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
          )}
        >
          {t("paywalls.builder.canvas.allSizes", "All sizes")}
        </button>
        <button
          type="button"
          onClick={() => vm.toggleSafeArea()}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
            vm.showSafeArea
              ? "border-rv-accent-500/40 bg-rv-accent-500/10 text-rv-accent-500"
              : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
          )}
        >
          {t("paywalls.builder.canvas.safeArea", "Safe area")}
        </button>

        <div className="ml-auto font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.canvas.previewBadge", "Preview — placeholder prices")}
        </div>
      </div>

      <div
        ref={setViewportEl}
        className="relative flex flex-1 items-center justify-center overflow-auto bg-gradient-to-b from-rv-c1 to-rv-bg p-8"
      >
        {!vm.showAllSizes && (
          <DeviceFrame spec={spec} scale={zoom} scheme={vm.colorScheme} showSafeArea={vm.showSafeArea}>
            {renderPaywall}
          </DeviceFrame>
        )}

        {vm.showAllSizes && (
          <div className="flex items-start gap-6">
            {devicesForPlatform(vm.canvasPlatform).map((d) => (
              <DeviceFrame
                key={d.id}
                spec={d}
                scale={ALL_SIZES_SCALE}
                scheme={vm.colorScheme}
                showSafeArea={vm.showSafeArea}
                label
              >
                {renderPaywall}
              </DeviceFrame>
            ))}
          </div>
        )}

        {ring && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-sm ring-2 ring-rv-accent-500 ring-offset-1 ring-offset-transparent"
            style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
          />
        )}
      </div>
    </div>
  );
});
