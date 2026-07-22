import { useTranslation } from "react-i18next";
import type { DashboardExperimentType, ExperimentListItem } from "@rovenue/shared";
import { NativeSelect } from "../../ui/native-select";
import { Segmented } from "../../ui/segmented";
import type { Paywall } from "../paywalls/types";
import type { PlacementTarget, PlacementTargetType } from "./types";

const TYPE_OPTIONS: ReadonlyArray<PlacementTargetType> = ["paywall", "experiment", "none"];

type Props = {
  value: PlacementTarget;
  onChange: (next: PlacementTarget) => void;
  paywalls: ReadonlyArray<Paywall>;
  paywallsLoading: boolean;
  /** Pre-filtered to `type === "PAYWALL" && status in (DRAFT, RUNNING)`. */
  experiments: ReadonlyArray<ExperimentListItem>;
  experimentsLoading: boolean;
  disabled?: boolean;
};

/**
 * Segmented paywall/experiment/none control + the matching picker
 * for whichever type is selected. Switching type resets `value` to
 * that type's empty shape — never carries stale ids across types.
 */
export function TargetPicker({
  value,
  onChange,
  paywalls,
  paywallsLoading,
  experiments,
  experimentsLoading,
  disabled,
}: Props) {
  const { t } = useTranslation();

  const setType = (type: PlacementTargetType) => {
    if (type === value.type) return;
    if (type === "paywall") onChange({ type: "paywall", paywallId: "" });
    else if (type === "experiment") onChange({ type: "experiment", experimentId: "" });
    else onChange({ type: "none" });
  };

  return (
    <div className="flex flex-col gap-2">
      <Segmented
        options={TYPE_OPTIONS}
        value={value.type}
        onChange={setType}
        ariaLabel={t("placements.editor.target.typeLabel", "Target type")}
        renderLabel={(opt) => t(`placements.editor.target.types.${opt}`, opt)}
        className={disabled ? "pointer-events-none opacity-60" : undefined}
      />

      {value.type === "paywall" && (
        <NativeSelect
          aria-label={t("placements.editor.target.paywallLabel", "Paywall")}
          value={value.paywallId}
          disabled={disabled || paywallsLoading || paywalls.length === 0}
          onChange={(e) => onChange({ type: "paywall", paywallId: e.target.value })}
        >
          <option value="">
            {paywalls.length === 0
              ? t("placements.editor.target.paywallEmpty", "No paywalls yet")
              : t("placements.editor.target.paywallPick", "Select a paywall…")}
          </option>
          {paywalls.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.identifier})
            </option>
          ))}
        </NativeSelect>
      )}

      {value.type === "experiment" && (
        <NativeSelect
          aria-label={t("placements.editor.target.experimentLabel", "Experiment")}
          value={value.experimentId}
          disabled={disabled || experimentsLoading || experiments.length === 0}
          onChange={(e) => onChange({ type: "experiment", experimentId: e.target.value })}
        >
          <option value="">
            {experiments.length === 0
              ? t(
                  "placements.editor.target.experimentEmpty",
                  "No draft/running PAYWALL experiments",
                )
              : t("placements.editor.target.experimentPick", "Select an experiment…")}
          </option>
          {experiments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {statusLabel(e.status, t)}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}

function statusLabel(
  status: ExperimentListItem["status"],
  t: (key: string, fallback: string) => string,
): string {
  return t(`placements.editor.target.experimentStatus.${status}`, status);
}

export function filterPaywallExperiments(
  experiments: ReadonlyArray<ExperimentListItem>,
): ExperimentListItem[] {
  const paywallType: DashboardExperimentType = "PAYWALL";
  return experiments.filter(
    (e) => e.type === paywallType && (e.status === "DRAFT" || e.status === "RUNNING"),
  );
}
