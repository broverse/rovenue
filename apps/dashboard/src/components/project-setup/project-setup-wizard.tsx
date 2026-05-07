import { useEffect, useMemo, useState } from "react";
import { SetupTopbar } from "./setup-topbar";
import { SetupFooter } from "./setup-footer";
import { StepperRail } from "./stepper-rail";
import { StepBasics } from "./step-basics";
import { StepPlatforms } from "./step-platforms";
import { StepCurrency } from "./step-currency";
import { StepConnectors } from "./step-connectors";
import { StepTeam } from "./step-team";
import { StepReview } from "./step-review";
import { EMPTY_FORM, STEPS } from "./mock-data";
import { slugify } from "./format";
import type { PlatformId, SetupForm, SetupMode } from "./types";

type ProjectSetupWizardProps = {
  mode: SetupMode;
  initialForm?: SetupForm;
  projectName?: string | null;
  onSubmit: (form: SetupForm) => void;
  isSubmitting?: boolean;
};

const isStepCompleteFor = (form: SetupForm, stepId: number): boolean => {
  switch (stepId) {
    case 1:
      return form.name.length >= 2 && form.slug.length >= 2;
    case 2:
      return form.platforms.length > 0;
    case 3:
      return Boolean(form.currency) && Boolean(form.timezone);
    default:
      return true;
  }
};

/**
 * The full six-step setup experience. Owns transient form state, step
 * gating, and the auto-slug derivation that fires while the slug field is
 * still empty in create mode.
 */
export function ProjectSetupWizard({
  mode,
  initialForm,
  projectName,
  onSubmit,
  isSubmitting,
}: ProjectSetupWizardProps) {
  const seed = useMemo<SetupForm>(
    () => initialForm ?? EMPTY_FORM,
    [initialForm],
  );
  const [form, setForm] = useState<SetupForm>(seed);
  const [step, setStep] = useState(1);
  const isUpdate = mode === "update";

  useEffect(() => {
    setForm(seed);
    setStep(1);
  }, [seed]);

  useEffect(() => {
    if (isUpdate || !form.name || form.slug) return;
    setForm((current) => ({ ...current, slug: slugify(current.name) }));
  }, [form.name, form.slug, isUpdate]);

  const update = <Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const togglePlatform = (id: PlatformId) =>
    setForm((current) => ({
      ...current,
      platforms: current.platforms.includes(id)
        ? current.platforms.filter((existing) => existing !== id)
        : [...current.platforms, id],
    }));

  const toggleConnector = (id: string) =>
    setForm((current) => ({
      ...current,
      connectors: current.connectors.includes(id)
        ? current.connectors.filter((existing) => existing !== id)
        : [...current.connectors, id],
    }));

  const isDone = (id: number) => isStepCompleteFor(form, id);
  const canContinue = isDone(step);
  const goto = (next: number) => {
    if (next < 1 || next > STEPS.length) return;
    setStep(next);
  };

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(seed),
    [form, seed],
  );

  return (
    <div className="min-h-screen bg-rv-bg text-foreground">
      <SetupTopbar mode={mode} projectName={projectName ?? null} />

      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <StepperRail
          mode={mode}
          step={step}
          isStepDone={isDone}
          onJump={goto}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto w-full max-w-[920px] flex-1 px-8 py-10 sm:px-14">
            {step === 1 ? (
              <StepBasics form={form} mode={mode} onUpdate={update} />
            ) : null}
            {step === 2 ? (
              <StepPlatforms
                form={form}
                onUpdate={update}
                onTogglePlatform={togglePlatform}
              />
            ) : null}
            {step === 3 ? (
              <StepCurrency form={form} onUpdate={update} />
            ) : null}
            {step === 4 ? (
              <StepConnectors
                form={form}
                onToggleConnector={toggleConnector}
              />
            ) : null}
            {step === 5 ? <StepTeam form={form} onUpdate={update} /> : null}
            {step === 6 ? (
              <StepReview form={form} mode={mode} onJump={goto} />
            ) : null}
          </div>

          <SetupFooter
            mode={mode}
            step={step}
            canContinue={canContinue}
            hasUnsavedChanges={hasUnsavedChanges}
            isSubmitting={isSubmitting}
            onBack={() => goto(step - 1)}
            onContinue={() => goto(step + 1)}
            onSubmit={() => onSubmit(form)}
            onDiscard={() => setForm(seed)}
          />
        </main>
      </div>
    </div>
  );
}
