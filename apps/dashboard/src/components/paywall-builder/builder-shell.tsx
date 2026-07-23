import { useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { TopBar } from "./top-bar";
import { LayerTree } from "./layer-tree";
import { Canvas } from "./canvas";
import { PropertiesPanel } from "./properties-panel";
import { ValidationDrawer } from "./validation-drawer";
import { DiffModal } from "./diff-modal";
import { LocalizationModal } from "./localization-modal";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";

type Props = {
  projectId: string;
};

export const BuilderShell = component(({ projectId }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [showValidation, setShowValidation] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showLocalization, setShowLocalization] = useState(false);

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
      />
      <main className="flex flex-1 overflow-hidden">
        <LayerTree />
        <Canvas />
        <PropertiesPanel />
      </main>
      {showValidation && <ValidationDrawer onClose={() => setShowValidation(false)} />}
      {showDiff && <DiffModal onClose={() => setShowDiff(false)} />}
      {showLocalization && <LocalizationModal onClose={() => setShowLocalization(false)} />}
    </div>
  );
});
