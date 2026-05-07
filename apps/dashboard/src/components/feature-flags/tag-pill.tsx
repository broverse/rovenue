import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type TagPillTone =
  | "default"
  | "env-prod"
  | "env-staging"
  | "env-development"
  | "linked-experiment";

type Props = {
  tone?: TagPillTone;
  children: ReactNode;
  className?: string;
};

const TONES: Record<TagPillTone, string> = {
  default: "bg-rv-c3 border-rv-divider text-rv-mute-600",
  "env-prod":
    "bg-rv-accent-500/10 border-rv-accent-500/30 text-rv-accent-400",
  "env-staging":
    "bg-rv-warning/10 border-rv-warning/30 text-rv-warning",
  "env-development":
    "bg-rv-cyan/10 border-rv-cyan/30 text-rv-cyan",
  "linked-experiment":
    "bg-rv-violet/10 border-rv-violet/30 text-rv-violet",
};

/**
 * Compact mono-text pill for env, linked experiment, or generic tags. Used in
 * the flag list rows and detail header.
 */
export function TagPill({ tone = "default", children, className }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-px font-rv-mono text-[10px]",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
