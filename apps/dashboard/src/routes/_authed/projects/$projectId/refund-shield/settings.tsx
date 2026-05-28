import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { Button } from "../../../../../ui/button";
import { Switch } from "../../../../../ui/switch";
import { Checkbox } from "../../../../../ui/checkbox";
import { ApiError } from "../../../../../lib/api";
import {
  useRefundShieldSettings,
  useUpdateRefundShieldSettings,
} from "../../../../../lib/hooks/useRefundShield";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/settings",
)({
  component: RefundShieldSettingsRoute,
});

function RefundShieldSettingsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/settings",
  });
  return <RefundShieldSettingsPage projectId={projectId} />;
}

export function RefundShieldSettingsPage({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useRefundShieldSettings(projectId);
  const mutation = useUpdateRefundShieldSettings(projectId);

  const [enabled, setEnabled] = useState(false);
  const [delay, setDelay] = useState(60);
  const [consent, setConsent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setDelay(settings.responseDelayMinutes);
    setConsent(settings.consentAcknowledgedAt !== null);
  }, [settings]);

  if (isLoading || !settings) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }

  const consentAlreadyStamped = settings.consentAcknowledgedAt !== null;
  const consentMissing = enabled && !consentAlreadyStamped && !consent;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setSavedFlash(false);

    if (consentMissing) {
      setFormError(t("refundShield.settings.consent.requiredBeforeEnable"));
      return;
    }

    try {
      await mutation.mutateAsync({
        enabled,
        responseDelayMinutes: delay,
        consentAcknowledged:
          consent && !consentAlreadyStamped ? true : undefined,
      });
      setSavedFlash(true);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "";
      setFormError(t("refundShield.settings.error", { message: msg }));
    }
  };

  return (
    <>
      <header className="pb-5">
        <h1 className="flex items-center gap-2 text-[24px] font-semibold leading-8 tracking-tight">
          <ShieldCheck size={22} className="text-rv-accent-500" />
          {t("refundShield.settings.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
          {t("refundShield.settings.subtitle")}
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="grid max-w-3xl grid-cols-1 gap-4"
      >
        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[13px] font-medium">
                {t("refundShield.settings.enable.label")}
              </div>
              <p className="mt-1 text-[12px] text-rv-mute-500">
                {t("refundShield.settings.enable.description")}
              </p>
            </div>
            <Switch
              ariaLabel={t("refundShield.settings.enable.label")}
              checked={enabled}
              onChange={setEnabled}
            />
          </div>
        </section>

        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <div className="text-[13px] font-medium">
            {t("refundShield.settings.delay.label")}
          </div>
          <p className="mt-1 text-[12px] text-rv-mute-500">
            {t("refundShield.settings.delay.description")}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <input
              type="range"
              min={30}
              max={360}
              step={5}
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
              className="flex-1 accent-rv-accent-500"
              aria-label={t("refundShield.settings.delay.label")}
            />
            <span className="w-24 text-right font-rv-mono text-[12px] text-foreground">
              {t("refundShield.settings.delay.unit", { value: delay })}
            </span>
          </div>
          <div className="mt-1 flex justify-between font-rv-mono text-[10px] text-rv-mute-500">
            <span>{t("refundShield.settings.delay.min")}</span>
            <span>{t("refundShield.settings.delay.max")}</span>
          </div>
        </section>

        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          {consentAlreadyStamped ? (
            <p className="text-[12px] text-rv-mute-700">
              {t("refundShield.settings.consent.stamped", {
                date: new Date(
                  settings.consentAcknowledgedAt!,
                ).toLocaleDateString(),
                user: settings.consentAcknowledgedBy ?? "—",
              })}
            </p>
          ) : (
            <div className="flex items-start gap-2 text-[12px]">
              <Checkbox
                ariaLabel={t("refundShield.settings.consent.label")}
                checked={consent}
                onChange={() => setConsent((v) => !v)}
              />
              <span>{t("refundShield.settings.consent.label")}</span>
            </div>
          )}
        </section>

        {formError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {formError}
          </div>
        )}
        {savedFlash && !formError && (
          <div className="rounded-md border border-rv-success/30 bg-rv-success/10 px-3 py-2 text-[12px] text-rv-success">
            {t("refundShield.settings.saved")}
          </div>
        )}

        <div className="pt-1">
          <Button
            type="submit"
            variant="solid-primary"
            disabled={mutation.isPending}
          >
            {mutation.isPending
              ? t("refundShield.settings.submitting")
              : t("refundShield.settings.submit")}
          </Button>
        </div>
      </form>
    </>
  );
}
