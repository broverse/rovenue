import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";
import { avatarFor, initialsFor } from "./format";

export const userAvatarVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center rounded-full font-rv-mono font-semibold text-white",
  {
    variants: {
      size: {
        sm: "size-7 text-[10px]",
        md: "size-9 text-[12px]",
        lg: "size-11 text-[13px]",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export type UserAvatarProps = VariantProps<typeof userAvatarVariants> & {
  fullId: string;
  /** Renders an amber dot in the bottom-right corner. */
  vip?: boolean;
  className?: string;
};

/**
 * Stable, deterministic avatar — picks a gradient from the user id slice
 * and shows the next two characters as initials. The VIP dot is rendered
 * as a pseudo-style absolute element ringed in the surface color so it
 * floats cleanly over the avatar edge.
 */
export function UserAvatar({ fullId, vip, size, className }: UserAvatarProps) {
  return (
    <div
      className={cn(userAvatarVariants({ size }), className)}
      style={{ background: avatarFor(fullId) }}
    >
      {initialsFor(fullId)}
      {vip && (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-rv-warning ring-2 ring-rv-c1"
        />
      )}
    </div>
  );
}
