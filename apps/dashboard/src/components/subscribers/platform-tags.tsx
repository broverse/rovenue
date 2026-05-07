import type { SubscriberPlatform } from "./types";

const LABEL: Record<SubscriberPlatform, string> = {
  ios: "I",
  android: "A",
  web: "W",
};

type Props = { platforms: ReadonlyArray<SubscriberPlatform> };

/** Renders a stack of small monogram tiles, one per platform the user is on. */
export function PlatformTags({ platforms }: Props) {
  return (
    <div className="inline-flex gap-0.5">
      {platforms.map((p) => (
        <span
          key={p}
          aria-label={p}
          className="inline-flex size-[18px] items-center justify-center rounded-[3px] border border-rv-divider bg-rv-c3 font-rv-mono text-[9px] font-semibold text-rv-mute-600"
        >
          {LABEL[p]}
        </span>
      ))}
    </div>
  );
}
