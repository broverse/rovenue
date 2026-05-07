import { AlertTriangle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "../../ui/button";

type Props = {
  onReenable: () => void;
};

/**
 * Red banner shown above the detail body when a flag's kill switch is
 * active. Clicking "Re-enable" flips the flag back on through the parent.
 */
export function KillBanner({ onReenable }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3.5 py-2.5 text-[12px]">
      <AlertTriangle size={14} className="shrink-0 text-rv-danger" />
      <div className="flex-1">
        <div className="font-medium">{t("featureFlags.kill.title")}</div>
        <div className="mt-0.5 text-[11px] text-rv-mute-600">
          <Trans
            i18nKey="featureFlags.kill.body"
            components={{ 0: <code className="font-rv-mono" /> }}
          />
        </div>
      </div>
      <Button variant="flat" size="sm" className="h-[26px]" onClick={onReenable}>
        {t("featureFlags.kill.reenable")}
      </Button>
    </div>
  );
}
