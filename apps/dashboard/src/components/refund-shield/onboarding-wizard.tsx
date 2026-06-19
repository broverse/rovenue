import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Spinner } from "@heroui/react";
import { Check, Link2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { useUpdateRefundShieldSettings } from "../../lib/hooks/useRefundShield";
import { useProjectCredentials } from "../../lib/hooks/useProjectCredentials";
import { cn } from "../../lib/cn";

/** Default response delay applied on first enable; tunable later in Settings. */
const DEFAULT_DELAY_MINUTES = 60;

export interface OnboardingWizardProps {
  projectId: string;
  onComplete: () => void;
  onCancel?: () => void;
}

/**
 * Single-screen setup for Refund Shield. Refund Shield only acts on Apple
 * CONSUMPTION_REQUEST notifications, so an App Store connection is mandatory:
 * when Apple credentials are missing we send the operator to connect first
 * instead of letting them enable a feature that can never fire.
 */
export function OnboardingWizard({
  projectId,
  onComplete,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const credentials = useProjectCredentials(projectId);
  const mutation = useUpdateRefundShieldSettings(projectId);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appleConfigured =
    credentials.data?.credentials.apple.configured ?? false;

  const enable = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({
        enabled: true,
        responseDelayMinutes: DEFAULT_DELAY_MINUTES,
        consentAcknowledged: true,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-lg rounded-lg border border-rv-divider bg-rv-c1 p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck size={18} className="text-rv-accent-500" />
        <h2 className="text-[15px] font-medium">
          {t("refundShield.setup.title")}
        </h2>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-rv-mute-500">
        {t("refundShield.setup.body")}
      </p>

      {credentials.isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-rv-mute-500">
          <Spinner /> <span className="text-sm">{t("common.loading")}</span>
        </div>
      ) : !appleConfigured ? (
        <AppleConnectRequired projectId={projectId} />
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-rv-mute-700">
            <Checkbox
              ariaLabel={t("refundShield.settings.consent.label")}
              checked={consent}
              onChange={() => setConsent((v) => !v)}
            />
            <span>{t("refundShield.settings.consent.label")}</span>
          </label>

          {error && (
            <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-rv-mute-500">
              {t("refundShield.setup.delayNote", {
                value: DEFAULT_DELAY_MINUTES,
              })}
            </span>
            <Button
              variant="solid-primary"
              size="sm"
              disabled={!consent || mutation.isPending}
              onClick={enable}
            >
              {mutation.isPending ? (
                t("refundShield.setup.enabling")
              ) : (
                <>
                  <Check size={12} />
                  {t("refundShield.setup.enable")}
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shown when the project has no Apple App Store connection yet. */
function AppleConnectRequired({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-5 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <TriangleAlert
          size={15}
          className="mt-0.5 shrink-0 text-rv-warning"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">
            {t("refundShield.setup.appleRequired.title")}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
            {t("refundShield.setup.appleRequired.body")}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Link
          to="/projects/$projectId/stores"
          params={{ projectId }}
          className={cn(buttonVariants({ variant: "solid-primary", size: "sm" }))}
        >
          <Link2 size={13} aria-hidden />
          {t("refundShield.setup.appleRequired.connect")}
        </Link>
      </div>
    </div>
  );
}
