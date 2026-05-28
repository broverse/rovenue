import { cva, type VariantProps } from "class-variance-authority";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { AppLogo as AppLogoTokens } from "./types";

const appLogoVariants = cva(
  "flex shrink-0 items-center justify-center font-rv-mono font-semibold leading-none text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]",
  {
    variants: {
      size: {
        sm: "h-9 w-9 rounded-md text-[13px]",
        md: "h-10 w-10 rounded-lg text-[14px]",
        lg: "h-[52px] w-[52px] rounded-xl text-[16px]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type AppLogoProps = VariantProps<typeof appLogoVariants> & {
  logo: AppLogoTokens;
  className?: string;
};

const AppleMark = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={Math.round(size * 1.1)}
    viewBox="0 0 22 22"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M17.05 11.97c-.03-3.13 2.56-4.63 2.68-4.7-1.46-2.13-3.74-2.42-4.55-2.45-1.94-.2-3.78 1.14-4.76 1.14-.99 0-2.51-1.12-4.13-1.09-2.13.03-4.09 1.24-5.18 3.13C-.97 11.71.66 17.4 2.86 20.55c1.07 1.55 2.34 3.27 4.02 3.21 1.61-.07 2.22-1.04 4.17-1.04 1.94 0 2.5 1.04 4.21 1.01 1.74-.03 2.84-1.56 3.91-3.11 1.23-1.79 1.74-3.51 1.78-3.6-.04-.02-3.41-1.31-3.45-5.18zm-3.18-9.5c.87-1.06 1.46-2.53 1.3-4-1.25.05-2.78.83-3.68 1.89-.81.94-1.51 2.45-1.32 3.88 1.4.11 2.83-.71 3.7-1.77z" />
  </svg>
);

// Meta brand mark (Simple Icons, CC0). Official "infinity" mark used on Meta
// Platforms property surfaces (formerly the Facebook "f" — superseded 2023).
const MetaMark = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
  </svg>
);

// TikTok brand mark (Simple Icons, CC0). Official monogram (musical-note "d").
const TikTokMark = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.66 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.7-.1z" />
  </svg>
);

const CUSTOM_PX: Record<NonNullable<AppLogoProps["size"]>, number> = {
  sm: 18,
  md: 20,
  lg: 22,
};

export function AppLogo({ logo, size, className }: AppLogoProps) {
  const style: CSSProperties = {
    background: logo.background,
    color: logo.textColor ?? "#fff",
  };
  const px = CUSTOM_PX[size ?? "md"];
  let mark: ReactNode;
  switch (logo.custom) {
    case "apple":
      mark = <AppleMark size={px} />;
      break;
    case "meta":
      mark = <MetaMark size={px} />;
      break;
    case "tiktok":
      mark = <TikTokMark size={px} />;
      break;
    default:
      mark = logo.glyph;
  }
  return (
    <div className={cn(appLogoVariants({ size }), className)} style={style} aria-hidden="true">
      {mark}
    </div>
  );
}
