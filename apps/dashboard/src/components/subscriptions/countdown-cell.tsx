import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { renewalProgressColor } from "./format";
import type { Subscription } from "./types";

type Props = { sub: Subscription };

/**
 * Renders the "Next event" cell. Different states (cancellation,
 * retry, imminent, future) get different visual treatments — the
 * progress bar is only used for upcoming renewals.
 */
export function CountdownCell({ sub }: Props) {
  const { t } = useTranslation();
  const { renewsIn, status, renewsPct } = sub;

  if (renewsIn < 0) {
    return (
      <span className="font-rv-mono text-[12px] text-rv-mute-500">
        {t("subscriptions.countdown.endedAgo", { days: -renewsIn })}
      </span>
    );
  }

  if (status === "canceling") {
    return (
      <span className="font-rv-mono text-[12px] text-rv-warning">
        {t("subscriptions.countdown.endsIn", { days: renewsIn })}
      </span>
    );
  }

  if (renewsIn === 0) {
    return (
      <span className="font-rv-mono text-[12px] text-rv-danger">
        {t("subscriptions.countdown.retryToday")}
      </span>
    );
  }

  const imminent = renewsIn <= 7;
  const fillPct = imminent ? 100 - (renewsIn / 7) * 100 : renewsPct;
  const fillColor = imminent ? "var(--color-rv-warning)" : renewalProgressColor(renewsPct);

  return (
    <div className="flex items-center gap-2 font-rv-mono text-[12px]">
      <span className="block h-1 w-[80px] flex-1 overflow-hidden rounded-full bg-rv-c3">
        <span
          className="block h-full rounded-full"
          style={{ width: `${fillPct}%`, background: fillColor }}
        />
      </span>
      <span
        className={cn("min-w-[40px] text-right", imminent && "text-rv-warning")}
      >
        {t("subscriptions.countdown.daysShort", { days: renewsIn })}
      </span>
    </div>
  );
}
