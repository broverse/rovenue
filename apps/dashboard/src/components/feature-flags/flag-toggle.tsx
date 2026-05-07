import { cn } from "../../lib/cn";

type Props = {
  enabled: boolean;
  killed?: boolean;
  onToggle: () => void;
  /** Larger render — used in the detail panel header. */
  size?: "sm" | "md";
  title?: string;
  className?: string;
};

/**
 * Pill-shaped on/off switch for a feature flag. When `killed` is true the
 * track turns red and the knob slides to the on-position to flag that
 * traffic is being suppressed.
 */
export function FlagToggle({
  enabled,
  killed = false,
  onToggle,
  size = "sm",
  title,
  className,
}: Props) {
  const slid = killed || enabled;
  const dims =
    size === "md"
      ? "h-[22px] w-[38px] after:size-[18px]"
      : "h-5 w-[34px] after:size-4";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled && !killed}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={title}
      className={cn(
        "relative shrink-0 cursor-pointer rounded-full border transition-colors after:absolute after:left-px after:top-px after:rounded-full after:bg-rv-mute-500 after:transition-transform",
        dims,
        slid && "after:translate-x-[14px]",
        killed
          ? "border-rv-danger bg-rv-danger/30 after:!bg-white"
          : enabled
            ? "border-rv-accent-500 bg-rv-accent-500/30 after:!bg-rv-accent-400"
            : "border-rv-divider bg-rv-c3",
        className,
      )}
    />
  );
}
