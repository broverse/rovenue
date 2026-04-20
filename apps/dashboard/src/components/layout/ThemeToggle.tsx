import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useTheme } from "next-themes";

type Mode = "light" | "dark" | "system";

const ORDER: Mode[] = ["light", "dark", "system"];
const LABEL: Record<Mode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

const ICON: Record<Mode, React.ReactNode> = {
  light: <SunIcon />,
  dark: <MoonIcon />,
  system: <MonitorIcon />,
};

/**
 * Three-state toggle: light → dark → system → light. Defaults to
 * "system" (follows the OS color-scheme). Avoids rendering mismatched
 * content during the pre-hydration flash by waiting until next-themes
 * tells us the current value.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const current: Mode = mounted && theme && ORDER.includes(theme as Mode)
    ? (theme as Mode)
    : "system";

  function cycle() {
    const nextIndex = (ORDER.indexOf(current) + 1) % ORDER.length;
    setTheme(ORDER[nextIndex]!);
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      onPress={cycle}
      aria-label={`Theme: ${LABEL[current]} (click to change)`}
      className="min-w-8 px-2"
    >
      {ICON[current]}
    </Button>
  );
}
