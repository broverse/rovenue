import { cn } from "../../lib/cn";
import type { StatusFilter } from "./types";

type Section = {
  /** Uppercase section heading. */
  label: string;
  /** Optional helper sub-label. */
  helper?: string;
};

const STATUS_OPTIONS: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: "active", label: "Active" },
  { key: "draft", label: "Draft" },
  { key: "archived", label: "Archived" },
  { key: "all", label: "All" },
];

type Props = {
  sectionLabels: { groups: string; status: string };
  groups: ReadonlyArray<string>;
  groupCounts: Readonly<Record<string, number>>;
  selectedGroup: string;
  onSelectGroup: (next: string) => void;
  selectedStatus: StatusFilter;
  onSelectStatus: (next: StatusFilter) => void;
};

/**
 * Vertical filter rail rendered to the left of the products table. Holds two
 * independent groupings — product groups and lifecycle status. Collapses to
 * a horizontal row of pills below the lg breakpoint.
 */
export function GroupSidebar({
  sectionLabels,
  groups,
  groupCounts,
  selectedGroup,
  onSelectGroup,
  selectedStatus,
  onSelectStatus,
}: Props) {
  return (
    <aside className="sticky top-[76px] flex flex-col gap-1 max-lg:static max-lg:flex-row max-lg:flex-wrap max-lg:gap-1">
      <SectionHeading label={sectionLabels.groups} />
      {groups.map((g) => (
        <GroupRow
          key={g}
          label={g}
          count={groupCounts[g] ?? 0}
          active={selectedGroup === g}
          onClick={() => onSelectGroup(g)}
        />
      ))}

      <div className="my-2.5 mx-1.5 h-px bg-rv-divider max-lg:hidden" />

      <SectionHeading label={sectionLabels.status} />
      {STATUS_OPTIONS.map((opt) => (
        <GroupRow
          key={opt.key}
          label={opt.label}
          active={selectedStatus === opt.key}
          onClick={() => onSelectStatus(opt.key)}
        />
      ))}
    </aside>
  );
}

function SectionHeading({ label }: Section) {
  return (
    <div className="px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500 max-lg:basis-full">
      {label}
    </div>
  );
}

type RowProps = {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
};

function GroupRow({ label, count, active, onClick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 text-[13px] text-rv-mute-600 transition hover:bg-rv-c2 hover:text-rv-mute-800",
        active && "bg-rv-c2 text-foreground",
        "max-lg:h-6 max-lg:px-2.5",
      )}
    >
      <span>{label}</span>
      {typeof count === "number" && (
        <span className="font-rv-mono text-[11px] text-rv-mute-500">{count}</span>
      )}
    </button>
  );
}
