import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { component, useService } from "impair";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Maximize, Minus, Plus } from "lucide-react";
import { PaywallRenderer } from "@rovenue/paywall-renderer";
import type { DashboardOfferingRow } from "@rovenue/shared";
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
import { deviceById } from "./device-catalog";
import { DeviceFrame } from "./device-frame";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

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

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-rv-bg">
      <div className="flex items-center gap-2 border-b border-rv-divider bg-rv-c1 px-4 py-2">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 px-0.5">
          <button
            type="button"
            onClick={() => vm.zoomStep(-1)}
            title={t("paywalls.builder.canvas.zoomOut", "Zoom out")}
            disabled={zoom === ZOOM_STEPS[0]}
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
            disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
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

        <div className="ml-auto font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.canvas.previewBadge", "Preview — placeholder prices")}
        </div>
      </div>

      <div
        ref={setViewportEl}
        className="relative flex flex-1 items-center justify-center overflow-auto bg-gradient-to-b from-rv-c1 to-rv-bg p-8"
      >
        <DeviceFrame spec={spec} scale={zoom} scheme={vm.colorScheme} showSafeArea={vm.showSafeArea}>
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
        </DeviceFrame>

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
