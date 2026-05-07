import { ChevronRight, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { STEPS } from "./mock-data";
import type { SetupMode } from "./types";

type SetupFooterProps = {
  mode: SetupMode;
  step: number;
  canContinue: boolean;
  hasUnsavedChanges?: boolean;
  onBack: () => void;
  onContinue: () => void;
  onSubmit: () => void;
  onDiscard?: () => void;
  isSubmitting?: boolean;
  meta?: string;
};

export function SetupFooter({
  mode,
  step,
  canContinue,
  hasUnsavedChanges,
  onBack,
  onContinue,
  onSubmit,
  onDiscard,
  isSubmitting,
  meta,
}: SetupFooterProps) {
  const { t } = useTranslation();
  const isUpdate = mode === "update";
  const currentStep = STEPS.find((entry) => entry.id === step);
  const fallbackMeta = isUpdate
    ? t("projectSetup.footer.editing")
    : t("projectSetup.footer.stepMeta", {
        step,
        total: STEPS.length,
        label: currentStep ? t(`projectSetup.steps.${currentStep.key}.label`) : "",
      });
  const isLast = step >= STEPS.length;

  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-rv-divider bg-rv-c1 px-4 py-3 sm:flex-nowrap sm:px-8 sm:py-3.5 lg:px-14">
      <div className="hidden font-rv-mono text-[12px] text-rv-mute-500 sm:block">
        {meta ?? fallbackMeta}
      </div>
      <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
        {!isUpdate && step > 1 ? (
          <Button type="button" variant="flat" onClick={onBack}>
            {t("projectSetup.footer.back")}
          </Button>
        ) : null}
        {isUpdate && hasUnsavedChanges && onDiscard ? (
          <Button type="button" variant="flat" onClick={onDiscard}>
            {t("projectSetup.footer.discard")}
          </Button>
        ) : null}
        {!isLast ? (
          <Button
            type="button"
            variant="solid-primary"
            disabled={!canContinue}
            onClick={onContinue}
          >
            {t("projectSetup.footer.continue")}
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="solid-primary"
            disabled={isSubmitting}
            onClick={onSubmit}
          >
            <Check className="size-3.5" aria-hidden="true" />
            {isUpdate
              ? t("projectSetup.footer.saveAll")
              : t("projectSetup.footer.create")}
          </Button>
        )}
      </div>
    </div>
  );
}
