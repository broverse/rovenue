import { Link } from "@tanstack/react-router";
import { Circle } from "lucide-react";
import { cn } from "../../lib/cn";
import type { NotificationRow as NotificationRowData } from "../../lib/hooks/useNotifications";

interface NotificationRowProps {
  row: NotificationRowData;
  onMarkRead?: (id: string) => void;
  /** Truncate body to this many chars (default 140). */
  bodyClamp?: number;
}

// ----- helpers -----

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function extractUrl(data: Record<string, unknown>): string | undefined {
  const v = data?.url;
  return typeof v === "string" ? v : undefined;
}

export function NotificationRow({
  row,
  onMarkRead,
  bodyClamp = 140,
}: NotificationRowProps) {
  const unread = row.readAt === null;
  const url = extractUrl(row.data);

  const inner = (
    <div className="flex w-full items-start gap-2">
      <div className="mt-1.5 flex w-2 shrink-0 items-center justify-center">
        {unread ? (
          <Circle
            size={8}
            className="fill-rv-accent text-rv-accent"
            aria-hidden
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p
            className={cn(
              "truncate text-[13px]",
              unread ? "font-medium text-foreground" : "text-rv-mute-700",
            )}
          >
            {row.title}
          </p>
          <span className="shrink-0 text-[11px] text-rv-mute-500">
            {relativeTime(row.createdAt)}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12px] text-rv-mute-600">
          {clamp(row.body, bodyClamp)}
        </p>
      </div>
    </div>
  );

  const onClick = () => {
    if (unread && onMarkRead) onMarkRead(row.id);
  };

  return url ? (
    <Link
      to={url}
      onClick={onClick}
      className="block rounded px-2 py-2 transition hover:bg-rv-c2"
    >
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded px-2 py-2 text-left transition hover:bg-rv-c2"
    >
      {inner}
    </button>
  );
}
