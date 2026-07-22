import { useTranslation } from "react-i18next";
import type { AudienceRow, ExperimentListItem } from "@rovenue/shared";
import { ChevronDown, ChevronUp, Trash2, Users } from "lucide-react";
import { NativeSelect } from "../../ui/native-select";
import type { Paywall } from "../paywalls/types";
import { TargetPicker } from "./target-picker";
import type { PlacementRow, PlacementTarget } from "./types";

const ALL_USERS_VALUE = "__all_users__";

type Props = {
  row: PlacementRow;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  canBeAllUsers: boolean;
  audiences: ReadonlyArray<AudienceRow>;
  audiencesLoading: boolean;
  paywalls: ReadonlyArray<Paywall>;
  paywallsLoading: boolean;
  experiments: ReadonlyArray<ExperimentListItem>;
  experimentsLoading: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onAudienceChange: (audienceId: string | null) => void;
  onTargetChange: (target: PlacementTarget) => void;
  disabled?: boolean;
};

/**
 * One ordered placement row: audience (or "All users", last row
 * only) → target. Reorder is buttons-only (move up/down) — no drag
 * library, per the YAGNI cut in the plan.
 */
export function RowCard({
  row,
  index,
  isFirst,
  isLast,
  canBeAllUsers,
  audiences,
  audiencesLoading,
  paywalls,
  paywallsLoading,
  experiments,
  experimentsLoading,
  onMoveUp,
  onMoveDown,
  onRemove,
  onAudienceChange,
  onTargetChange,
  disabled,
}: Props) {
  const { t } = useTranslation();
  const isAllUsers = row.audienceId === null;

  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3.5">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-rv-c4 px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-700">
          {t("placements.editor.row.label", { defaultValue: "Row {{n}}", n: index + 1 })}
        </span>
        {isAllUsers && (
          <span className="inline-flex items-center gap-1 rounded-full bg-rv-accent-500/10 px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-accent-500">
            <Users size={9} />
            {t("placements.editor.row.fallbackBadge", "Fallback")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label={t("placements.editor.row.moveUp", "Move up")}
            onClick={onMoveUp}
            disabled={disabled || isFirst}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-rv-mute-500"
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            aria-label={t("placements.editor.row.moveDown", "Move down")}
            onClick={onMoveDown}
            disabled={disabled || isLast}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-rv-mute-500"
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            aria-label={t("placements.editor.row.remove", "Remove row")}
            onClick={onRemove}
            disabled={disabled}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("placements.editor.row.audienceLabel", "Audience")}
          </span>
          <NativeSelect
            aria-label={t("placements.editor.row.audienceLabel", "Audience")}
            value={row.audienceId === null ? ALL_USERS_VALUE : row.audienceId}
            disabled={disabled || audiencesLoading}
            onChange={(e) =>
              onAudienceChange(e.target.value === ALL_USERS_VALUE ? null : e.target.value)
            }
          >
            <option value="" disabled>
              {t("placements.editor.row.audiencePick", "Select an audience…")}
            </option>
            {canBeAllUsers && (
              <option value={ALL_USERS_VALUE}>
                {t("placements.editor.row.allUsers", "All users (fallback)")}
              </option>
            )}
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.isDefault ? ` · ${t("placements.editor.row.defaultAudience", "default")}` : ""}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("placements.editor.row.targetLabel", "Target")}
          </span>
          <TargetPicker
            value={row.target}
            onChange={onTargetChange}
            paywalls={paywalls}
            paywallsLoading={paywallsLoading}
            experiments={experiments}
            experimentsLoading={experimentsLoading}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}
