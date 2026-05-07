import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";

type SessionRowProps = {
  device: string;
  meta: string;
  current?: boolean;
  onRevoke?: () => void;
};

export function SessionRow({ device, meta, current, onRevoke }: SessionRowProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 items-center gap-3 border-b border-white/5 py-3 last:border-b-0 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
          <span>{device}</span>
          {current ? (
            <span className="rounded bg-rv-success/15 px-2 py-0.5 font-rv-mono text-[10px] text-rv-success">
              {t("account.security.sessions.thisDevice")}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 break-all font-rv-mono text-[11px] text-rv-mute-500">{meta}</div>
      </div>
      {!current ? (
        <Button variant="light" onClick={onRevoke} className="justify-self-start sm:justify-self-auto">
          {t("account.security.sessions.revoke")}
        </Button>
      ) : null}
    </div>
  );
}
