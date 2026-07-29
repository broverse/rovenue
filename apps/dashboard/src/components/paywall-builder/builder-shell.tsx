import { useEffect, useRef, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { TopBar } from "./top-bar";
import { LayerTree } from "./layer-tree";
import { Canvas } from "./canvas";
import { PropertiesPanel } from "./properties-panel";
import { ValidationDrawer } from "./validation-drawer";
import { DiffModal } from "./diff-modal";
import { LocalizationModal } from "./localization-modal";
import { StartModal } from "./start-modal";
import { ExperimentPopover } from "./experiment-popover";
import { DevicePreviewModal } from "./device-preview-modal";
import { shouldAutoOpenStart } from "./start-model";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { useRovi } from "../../lib/hooks/useRovi";

type Props = {
  projectId: string;
};

export const BuilderShell = component(({ projectId }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  // Destructured rather than kept as `const rovi = useRovi()`: `setOpen`,
  // `setChatContext` and `registerPaywallPatchListener` are individually
  // stable (RoviProvider wraps each in a bare `useCallback`), but the
  // CONTEXT VALUE OBJECT they come back inside of is re-created on every
  // `chatContext`/`open` change. Depending on that whole object below
  // would re-run the chatContext effect every time it itself just wrote
  // to `chatContext` — an infinite update loop.
  const { open: roviOpen, setOpen: setRoviOpen, setChatContext, registerPaywallPatchListener } = useRovi();
  const [showValidation, setShowValidation] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showLocalization, setShowLocalization] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [showExperiment, setShowExperiment] = useState(false);
  const [showDevicePreview, setShowDevicePreview] = useState(false);
  /** Auto-open is decided exactly once, at the first render after the paywall loads. */
  const startDecided = useRef(false);
  useEffect(() => {
    if (startDecided.current || vm.isLoading || !vm.paywall) return;
    startDecided.current = true;
    if (shouldAutoOpenStart(vm.config)) setShowStart(true);
  }, [vm.isLoading, vm.paywall]);

  // Autosave is throttled, so closing the builder mid-window would drop
  // everything since the last successful save. Flush on the way out.
  useEffect(() => {
    return () => {
      if (vm.isDirty) void vm.saveNow();
    };
  }, [vm]);

  // A full page unload is NOT flushed here on purpose: a credentialed
  // cross-origin JSON beacon needs a CORS preflight, which browsers drop
  // during unload, so the decision is handed to the person instead. That
  // prompt already exists — PaywallBuilderViewModel.guardUnload registers
  // the `beforeunload` handler. Do not add a second one here.

  // Rovi → builder bridge (spec §3.3): only the builder route registers a
  // patch listener, so `ApprovalCard`'s execute handler can forward an
  // approved `action_paywall_editTree` op while a builder is mounted, and
  // falls back to its "open the builder" state otherwise. Registered under
  // THIS builder's own `paywallId` — `dispatchPaywallPatch` refuses an op
  // whose `paywallId` doesn't match, so a stale approval from a different
  // paywall (approved before navigating here, or approved while THIS
  // builder has since navigated away) can never land on the wrong tree:
  // every paywall's root node id is literally `"root"`, so an unscoped
  // "insert under root" would otherwise apply silently cross-paywall.
  // Unregisters on unmount (route change / paywall switch).
  useEffect(() => {
    return registerPaywallPatchListener(vm.paywallId, (op) => {
      try {
        vm.applyExternalTreeOp(op);
        return true;
      } catch {
        return false;
      }
    });
  }, [registerPaywallPatchListener, vm, vm.paywallId]);

  // Tells Rovi which paywall is open and which node the author has
  // selected (spec §3.1) — `useRoviChat` forwards both `paywallId` and
  // `focusedEntityId` to the backend: `paywallId` drives the paywall-context
  // block itself, `focusedEntityId` (the selected node) is mentioned as an
  // extra sentence inside it. Reset to empty on unmount so leaving the
  // builder doesn't leak paywall context into chats on other pages.
  useEffect(() => {
    setChatContext({
      paywallId: vm.paywallId || undefined,
      focusedEntityId: vm.selectedNodeId ?? undefined,
    });
  }, [setChatContext, vm.paywallId, vm.selectedNodeId]);

  useEffect(() => {
    return () => setChatContext({});
  }, [setChatContext]);

  if (vm.isLoading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-rv-bg font-rv-mono text-[11px] text-rv-mute-500">
        {t("paywalls.builder.loading", "loading paywall…")}
      </div>
    );
  }
  if (vm.error || !vm.paywall) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-rv-bg p-6 text-rv-mute-700">
        <div className="text-[14px] font-medium">
          {t("paywalls.builder.loadFailed", "Failed to load paywall.")}
        </div>
        {vm.error && (
          <pre className="max-w-[640px] overflow-auto rounded border border-rv-divider bg-rv-c2 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-600">
            {vm.error.name}: {vm.error.message}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-rv-bg text-foreground">
      <TopBar
        projectId={projectId}
        onOpenValidation={() => setShowValidation(true)}
        onOpenDiff={() => setShowDiff(true)}
        onOpenLocalization={() => setShowLocalization(true)}
        onOpenStart={() => setShowStart(true)}
        onOpenExperiment={() => setShowExperiment(true)}
        onOpenDevicePreview={() => setShowDevicePreview(true)}
      />
      <main className="flex flex-1 overflow-hidden">
        <LayerTree />
        <Canvas />
        <PropertiesPanel />
      </main>
      {/* AI FAB (spec §3.1) — the topbar Rovi button is covered by this
          overlay's own inset-0, so this is the builder's only visible
          opener short of ⌘/Ctrl+.; hidden while the panel is already open
          so it doesn't float over the open drawer. */}
      {!roviOpen && (
        <button
          type="button"
          onClick={() => setRoviOpen(true)}
          aria-label={t("paywalls.builder.ai.fabLabel", "Ask Rovi")}
          title={t("paywalls.builder.ai.fabLabel", "Ask Rovi")}
          className="fixed bottom-6 right-6 z-[55] flex size-12 items-center justify-center rounded-full bg-rv-accent-500 text-white shadow-[0_12px_28px_rgba(0,0,0,0.45)] transition hover:bg-rv-accent-600"
        >
          <Sparkles size={20} />
        </button>
      )}
      {showValidation && <ValidationDrawer onClose={() => setShowValidation(false)} />}
      {showDiff && <DiffModal onClose={() => setShowDiff(false)} />}
      {(showLocalization || vm.localizationFocusKey !== null) && (
        <LocalizationModal
          focusKey={vm.localizationFocusKey}
          onClose={() => {
            setShowLocalization(false);
            vm.clearLocalizationFocusKey();
          }}
        />
      )}
      {showStart && <StartModal onClose={() => setShowStart(false)} />}
      {showExperiment && <ExperimentPopover onClose={() => setShowExperiment(false)} />}
      {showDevicePreview && (
        <DevicePreviewModal onClose={() => setShowDevicePreview(false)} />
      )}
    </div>
  );
});
