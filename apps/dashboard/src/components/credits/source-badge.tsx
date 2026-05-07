import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { CreditSource } from "./types";

const TONE: Record<CreditSource, string> = {
  purchase:
    "border-rv-success/30 bg-rv-success/10 text-rv-success [&>.dot]:bg-rv-success",
  bonus:
    "border-rv-accent-500/30 bg-rv-accent-500/10 text-rv-accent-400 [&>.dot]:bg-rv-accent-400",
  consume:
    "border-rv-violet/30 bg-rv-violet/10 text-rv-violet [&>.dot]:bg-rv-violet",
  refund:
    "border-rv-warning/30 bg-rv-warning/10 text-rv-warning [&>.dot]:bg-rv-warning",
  expire:
    "border-rv-divider bg-rv-c3 text-rv-mute-500 [&>.dot]:bg-rv-mute-500",
  adjust:
    "border-rv-divider bg-rv-c3 text-rv-mute-700 [&>.dot]:bg-rv-mute-700",
};

type Props = { source: CreditSource };

/**
 * Compact source pill — colored dot + label rendered in mono for the
 * ledger row's "Source" column. Tone derived from the credit movement
 * type so refunds / expires / consumes are scannable at a glance.
 */
export function SourceBadge({ source }: Props) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-px font-rv-mono text-[11px]",
        TONE[source],
      )}
    >
      <span className="dot inline-block size-1.5 rounded-full" />
      {t(`credits.source.${source}`)}
    </span>
  );
}
