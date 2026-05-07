import { cn } from "../../lib/cn";
import type { EventPlatform } from "./types";

type Props = {
  platform: EventPlatform;
  className?: string;
};

const baseClass =
  "inline-flex h-[18px] items-center rounded px-1.5 font-rv-mono text-[10px] tracking-wide";

const variants: Record<EventPlatform, string> = {
  ios: "bg-rv-c4 text-rv-mute-700",
  android: "bg-rv-success/10 text-rv-success/90",
};

export function PlatformBadge({ platform, className }: Props) {
  return <span className={cn(baseClass, variants[platform], className)}>{platform}</span>;
}
