import { useTranslation } from "react-i18next";

type Props = {
  throughput: number;
  lastEvent: string;
};

export function RateStrip({ throughput, lastEvent }: Props) {
  const { t } = useTranslation();
  const sep = <span className="text-rv-mute-400">·</span>;
  return (
    <div className="mt-2 flex items-center gap-3.5 px-3.5 py-2 font-rv-mono text-[11px] tabular-nums text-rv-mute-500">
      <span>
        {t("liveEvents.rate.throughput")}{" "}
        <span className="text-foreground">{throughput.toFixed(1)}/s</span>
      </span>
      {sep}
      <span>
        {t("liveEvents.rate.lastEvent")}{" "}
        <span className="text-foreground">{lastEvent}</span>
      </span>
      {sep}
      <span>
        {t("liveEvents.rate.ingestLag")}{" "}
        <span className="text-rv-success">&lt; 50ms</span>
      </span>
      {sep}
      <span>
        {t("liveEvents.rate.retention")} <span className="text-foreground">90d</span>
      </span>
      <span className="ml-auto">
        {t("liveEvents.rate.kbdHint.before")}{" "}
        <Kbd>␣</Kbd> {t("liveEvents.rate.kbdHint.middle")} <Kbd>↵</Kbd>{" "}
        {t("liveEvents.rate.kbdHint.after")}
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[18px] items-center rounded border border-rv-divider bg-rv-c4 px-1.5 font-rv-mono text-[10px] text-rv-mute-600">
      {children}
    </span>
  );
}
