import { Sparkles } from "lucide-react";
import { useRovi } from "../../lib/hooks/useRovi";

export function TopbarRoviButton() {
  const { open, toggle } = useRovi();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={open ? "Close Rovi" : "Open Rovi"}
      aria-pressed={open}
      title="Open Rovi (⌘.)"
      className={
        "hidden size-8 items-center justify-center rounded-md transition sm:inline-flex " +
        (open
          ? "bg-rv-c4 text-foreground"
          : "text-rv-mute-600 hover:bg-rv-c2 hover:text-foreground")
      }
    >
      <Sparkles size={16} />
    </button>
  );
}
