import { cva, type VariantProps } from "class-variance-authority";
import type { CSSProperties } from "react";
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

const APPLE_PX: Record<NonNullable<AppLogoProps["size"]>, number> = {
  sm: 18,
  md: 20,
  lg: 22,
};

export function AppLogo({ logo, size, className }: AppLogoProps) {
  const style: CSSProperties = {
    background: logo.background,
    color: logo.textColor ?? "#fff",
  };
  return (
    <div className={cn(appLogoVariants({ size }), className)} style={style} aria-hidden="true">
      {logo.custom === "apple" ? <AppleMark size={APPLE_PX[size ?? "md"]} /> : logo.glyph}
    </div>
  );
}
