import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";

type Mode = "light" | "dark" | "system";

const ORDER: Mode[] = ["light", "dark", "system"];

const ICON: Record<Mode, React.ReactNode> = {
  light: <Sun size={16} />,
  dark: <Moon size={16} />,
  system: <Monitor size={16} />,
};

/**
 * Three-state toggle: light → dark → system → light. Defaults to
 * "system" (follows the OS color-scheme). Avoids rendering mismatched
 * content during the pre-hydration flash by waiting until next-themes
 * tells us the current value.
 */
export function ThemeToggle() {
  const { t } = useTranslation();
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
      aria-label={t("common.themeAria", { label: t(`themes.${current}`) })}
      className="min-w-8 px-2"
    >
      {ICON[current]}
    </Button>
  );
}
