import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";

type ApiKeyRowProps = {
  name: string;
  meta: string;
  secret: string;
  onRevoke?: () => void;
};

export function ApiKeyRow({ name, meta, secret, onRevoke }: ApiKeyRowProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 grid grid-cols-1 items-center gap-3 rounded-md border border-rv-divider bg-rv-c2 px-3.5 py-3 last:mb-0 sm:grid-cols-[1fr_auto_auto]">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{name}</div>
        <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">{meta}</div>
      </div>
      <span className="overflow-hidden truncate rounded border border-rv-divider bg-rv-c3 px-2 py-1 font-rv-mono text-[11px] text-rv-mute-600">
        {secret}
      </span>
      <Button variant="light" onClick={onRevoke} className="justify-self-start sm:justify-self-auto">
        {t("account.api.revoke")}
      </Button>
    </div>
  );
}
