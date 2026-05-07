import { cn } from "../../lib/cn";

type PlatformIconProps = {
  bg: string;
  label: string;
  size?: "sm" | "md";
  className?: string;
};

export function PlatformIcon({
  bg,
  label,
  size = "md",
  className,
}: PlatformIconProps) {
  return (
    <div
      style={{ background: bg }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-rv-mono font-semibold text-white",
        size === "sm" ? "size-[22px] text-[9px]" : "size-7 text-[11px]",
        className,
      )}
      aria-hidden="true"
    >
      {label}
    </div>
  );
}
