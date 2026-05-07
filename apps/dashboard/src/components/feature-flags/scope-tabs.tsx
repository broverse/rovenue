import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { FlagScope } from "./types";

const SCOPES: ReadonlyArray<FlagScope> = [
  "all",
  "on",
  "off",
  "killed",
  "experiment",
];

type Props = {
  value: FlagScope;
  onChange: (next: FlagScope) => void;
  counts: Readonly<Record<FlagScope, number>>;
};

/**
 * All / On / Off / Killed / Tied-to-experiment tabs that scope the flag
 * list. Each pill shows its matching count in monospace.
 */
export function ScopeTabs({ value, onChange, counts }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t("featureFlags.scope.ariaLabel")}
      className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-[3px]"
    >
      {SCOPES.map((scope) => {
        const active = scope === value;
        return (
          <button
            key={scope}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(scope)}
            className={cn(
              "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded px-3 text-[11px] transition",
              active
                ? "bg-rv-c4 text-foreground"
                : "text-rv-mute-600 hover:text-foreground",
            )}
          >
            {t(`featureFlags.scope.${scope}`)}
            <span
              className={cn(
                "rounded-[3px] px-1 py-px font-rv-mono text-[9px] tabular-nums",
                active ? "bg-rv-c2 text-rv-mute-700" : "bg-rv-c3 text-rv-mute-500",
              )}
            >
              {counts[scope]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
