import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Check, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { CopyButton } from "../../ui/copy-button";
import { useUpdateRefundShieldSettings } from "../../lib/hooks/useRefundShield";
import { cn } from "../../lib/cn";

type Step = 1 | 2 | 3 | 4;

export interface OnboardingWizardProps {
  projectId: string;
  onComplete: () => void;
  onCancel?: () => void;
}

export function OnboardingWizard({
  projectId,
  onComplete,
  onCancel,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const mutation = useUpdateRefundShieldSettings(projectId);
  const [step, setStep] = useState<Step>(1);
  const [delay, setDelay] = useState(60);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = () => setStep((s) => Math.min(4, (s + 1) as Step));
  const back = () => setStep((s) => Math.max(1, (s - 1) as Step));

  const finish = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({
        enabled: true,
        responseDelayMinutes: delay,
        consentAcknowledged: true,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-rv-accent-500" />
          <span className="text-[13px] font-medium">
            {t("refundShield.wizard.title")}
          </span>
        </div>
        <span className="font-rv-mono text-[10px] text-rv-mute-500">
          {t("refundShield.wizard.step", { n: step })}
        </span>
      </header>

      <div className="flex items-center gap-1 border-b border-rv-divider bg-rv-c2/50 px-5 py-2">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              i <= step ? "bg-rv-accent-500" : "bg-rv-c4",
            )}
          />
        ))}
      </div>

      <div className="px-5 py-5">
        {step === 1 && <Step1 onContinue={next} />}
        {step === 2 && <Step2 onContinue={next} />}
        {step === 3 && (
          <Step3 delay={delay} onDelay={setDelay} onNext={next} />
        )}
        {step === 4 && (
          <Step4
            consent={consent}
            onConsent={setConsent}
            onSubmit={finish}
            isPending={mutation.isPending}
          />
        )}
        {error && (
          <div className="mt-3 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {error}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-rv-divider px-5 py-3">
        <div>
          {step > 1 && (
            <Button variant="light" size="sm" onClick={back}>
              <ArrowLeft size={12} />
              {t("refundShield.wizard.back")}
            </Button>
          )}
        </div>
        {onCancel && (
          <Button variant="light" size="sm" onClick={onCancel}>
            {t("refundShield.wizard.exit")}
          </Button>
        )}
      </footer>
    </div>
  );
}

function Step1({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.sdkCheck.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.sdkCheck.body")}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="flat" size="sm" onClick={onContinue}>
          {t("refundShield.wizard.steps.sdkCheck.skip")}
        </Button>
        <Button variant="solid-primary" size="sm" onClick={onContinue}>
          {t("refundShield.wizard.steps.sdkCheck.okay")}
          <ArrowRight size={12} />
        </Button>
      </div>
    </div>
  );
}

function Step2({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  const template = t("refundShield.wizard.steps.tos.template");
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.tos.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.tos.body")}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
        {template}
      </pre>
      <div className="flex items-center justify-between">
        <CopyButton value={template} label="Copy" />
        <Button variant="solid-primary" size="sm" onClick={onContinue}>
          {t("refundShield.wizard.steps.tos.acknowledged")}
          <ArrowRight size={12} />
        </Button>
      </div>
    </div>
  );
}

function Step3({
  delay,
  onDelay,
  onNext,
}: {
  delay: number;
  onDelay: (n: number) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.delay.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.delay.body")}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <input
          type="range"
          min={30}
          max={360}
          step={5}
          value={delay}
          onChange={(e) => onDelay(Number(e.target.value))}
          className="flex-1 accent-rv-accent-500"
          aria-label={t("refundShield.settings.delay.label")}
        />
        <span className="w-24 text-right font-rv-mono text-[12px]">
          {t("refundShield.settings.delay.unit", { value: delay })}
        </span>
      </div>
      <div className="flex justify-end">
        <Button variant="solid-primary" size="sm" onClick={onNext}>
          {t("refundShield.wizard.steps.delay.next")}
          <ArrowRight size={12} />
        </Button>
      </div>
    </div>
  );
}

function Step4({
  consent,
  onConsent,
  onSubmit,
  isPending,
}: {
  consent: boolean;
  onConsent: (v: boolean) => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.enable.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.enable.body")}
      </p>
      <div className="flex items-start gap-2 text-[12px]">
        <Checkbox
          ariaLabel={t("refundShield.settings.consent.label")}
          checked={consent}
          onChange={() => onConsent(!consent)}
        />
        <span>{t("refundShield.settings.consent.label")}</span>
      </div>
      <div className="flex justify-end">
        <Button
          variant="solid-primary"
          size="sm"
          disabled={!consent || isPending}
          onClick={onSubmit}
        >
          {isPending ? (
            t("refundShield.wizard.steps.enable.submitting")
          ) : (
            <>
              <Check size={12} />
              {t("refundShield.wizard.steps.enable.submit")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
