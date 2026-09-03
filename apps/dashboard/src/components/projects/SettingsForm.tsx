import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import type { ProjectDetail, SubscriptionStoreCode, UpdateProjectRequest } from "@rovenue/shared";
import { COMMISSION_RATE_PRESET_OPTIONS, subscriptionStoreCodes } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Field } from "../project-setup/field";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";
import {
  useCommissionRates,
  useDeleteCommissionRate,
  useUpdateCommissionRate,
} from "../../lib/hooks/useCommissionRates";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 400;
const HOLDOUT_PERCENTAGE_MIN = 0;
const HOLDOUT_PERCENTAGE_MAX = 100;

// `project_store_commission_rates.rate` is numeric(5,4) — see
// apps/api/src/routes/dashboard/commission-rates.ts. The form works in
// whole/fractional PERCENT (what an operator types, e.g. "15" or
// "2.9") and converts to the [0, 1] fraction the API stores.
const COMMISSION_RATE_PERCENT_MIN = 0;
const COMMISSION_RATE_PERCENT_MAX = 100;
const COMMISSION_RATE_DECIMAL_PLACES = 4;

// Same store→label-key mapping ProceedsCard uses
// (components/charts/proceeds-card.tsx) so the two surfaces that talk
// about "what a store keeps" name stores identically.
const STORE_LABEL_KEY: Record<SubscriptionStoreCode, string> = {
  APP_STORE: "charts.channels.stores.apple",
  PLAY_STORE: "charts.channels.stores.google",
  STRIPE: "charts.channels.stores.stripe",
  MANUAL: "charts.channels.stores.manual",
};

interface Props {
  project: ProjectDetail;
}

export function SettingsForm({ project }: Props) {
  const { t } = useTranslation();
  const initialDescription = useMemo(() => project.description ?? "", [project.description]);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(initialDescription);
  const [holdoutPercentage, setHoldoutPercentage] = useState(
    String(project.holdoutPercentage),
  );
  const { mutate, isPending, error } = useUpdateProject(project.id);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  // Empty/garbage input is treated as "no change yet" rather than 0 — an
  // accidentally-cleared field must not silently submit as "lower the
  // holdout to zero".
  const parsedHoldoutPercentage = Number.parseInt(holdoutPercentage, 10);
  const holdoutPercentageValid =
    holdoutPercentage.trim() !== "" &&
    Number.isInteger(parsedHoldoutPercentage) &&
    parsedHoldoutPercentage >= HOLDOUT_PERCENTAGE_MIN &&
    parsedHoldoutPercentage <= HOLDOUT_PERCENTAGE_MAX;
  const holdoutPercentageChanged =
    holdoutPercentageValid && parsedHoldoutPercentage !== project.holdoutPercentage;
  // Threshold bucketing (assignBucket below a cutoff) makes raising the
  // holdout safe — it only ever adds members — and lowering it lossy: it
  // drops members whose exposure is already recorded, mixing them back
  // into the general population mid-comparison. Only the lossy direction
  // gets a warning; both directions are still audited server-side.
  const isLoweringHoldout =
    holdoutPercentageChanged && parsedHoldoutPercentage < project.holdoutPercentage;

  const patch: UpdateProjectRequest = {};
  if (trimmedName && trimmedName !== project.name) patch.name = trimmedName;
  if (trimmedDescription !== (project.description ?? "")) {
    patch.description = trimmedDescription ? trimmedDescription : null;
  }
  if (holdoutPercentageChanged) patch.holdoutPercentage = parsedHoldoutPercentage;

  const hasChanges = Object.keys(patch).length > 0;
  const canSubmit = hasChanges && trimmedName.length >= 2 && holdoutPercentageValid;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    mutate(patch);
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-1">
        <Field
          label={t("projectSetup.basics.name")}
          optional={t("projectSetup.basics.required")}
          hint={t("projectSetup.basics.nameHint", {
            count: name.length,
            max: NAME_MAX,
          })}
        >
          <Input
            placeholder={t("projectSetup.basics.namePlaceholder")}
            value={name}
            maxLength={NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>

        <Field
          label={t("projectSetup.basics.descLabel")}
          optional={t("projectSetup.basics.optional")}
          hint={t("projectSetup.basics.descriptionHint", {
            count: description.length,
            max: DESCRIPTION_MAX,
          })}
        >
          <Textarea
            placeholder={t("projectSetup.basics.descriptionPlaceholder")}
            value={description}
            maxLength={DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field
          label={t("experiments.holdout.label")}
          hint={t("experiments.holdout.hint")}
          error={holdoutPercentage.trim() !== "" && !holdoutPercentageValid}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={HOLDOUT_PERCENTAGE_MIN}
            max={HOLDOUT_PERCENTAGE_MAX}
            step={1}
            value={holdoutPercentage}
            onChange={(event) => setHoldoutPercentage(event.target.value)}
          />
        </Field>

        {isLoweringHoldout && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-rv-warning/30 bg-rv-warning/[0.08] px-3 py-2.5">
            <TriangleAlert size={14} className="mt-0.5 flex-shrink-0 text-rv-warning" />
            <p className="m-0 text-[12px] leading-relaxed text-rv-mute-700">
              {t("experiments.holdout.loweringWarning")}
            </p>
          </div>
        )}

        {error && (
          <div role="alert" className="mb-3 text-sm text-rv-danger">
            {error.message}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            variant="solid-primary"
            size="md"
            disabled={!canSubmit || isPending}
          >
            {t("common.saveChanges")}
          </Button>
          {!hasChanges && (
            <span className="text-xs text-rv-mute-500">{t("common.noChanges")}</span>
          )}
        </div>
      </form>

      <CommissionRatesSection projectId={project.id} />
    </>
  );
}

// =============================================================
// Commission rates — one row per store
// =============================================================
//
// Writes through the existing PUT/DELETE
// /dashboard/projects/:projectId/commission-rates/:store (no new API).
// That endpoint gates PUT/DELETE on capability "project:settings:write"
// and GET on "project:read" (apps/api/src/routes/dashboard/
// commission-rates.ts:79,104,152) — both enforced server-side only.
// This section adds no client-side role gate of its own (matching how
// the rest of this dashboard defers to the server: see
// routes/.../settings/notifications.tsx's "403 guard is server-side"
// comment) — it just surfaces whatever error the API returns, so it
// can never be a WIDER door than the endpoint it writes through.
//
// Rendering this section issues no PUT/DELETE by itself — the only
// network call on mount is the GET read. A store with no configured
// row keeps reporting "not configured" (charts.proceeds.
// rateNotConfigured, the same copy ProceedsCard uses) and selecting a
// preset only fills the input; it takes an explicit Save click to
// write anything. See SettingsForm.test.tsx's
// "issues no write on render" case.
function CommissionRatesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: rates, isLoading } = useCommissionRates(projectId);

  const configuredByStore = useMemo(() => {
    const map = new Map<SubscriptionStoreCode, number>();
    for (const row of rates ?? []) map.set(row.store, row.rate);
    return map;
  }, [rates]);

  return (
    <div className="mt-2 border-t border-rv-divider pt-5">
      <h3 className="mb-1 text-[13px] font-semibold text-foreground">
        {t("commissionRates.header")}
      </h3>
      <p className="mb-4 text-[12px] leading-relaxed text-rv-mute-500">
        {t("commissionRates.description")}
      </p>

      {isLoading ? (
        <div className="text-[12px] text-rv-mute-500">{t("commissionRates.loading")}</div>
      ) : (
        <div className="flex flex-col gap-3">
          {subscriptionStoreCodes.map((store) => (
            <CommissionRateRow
              // Keyed on the SERVER'S configured value (not local draft
              // state) so a successful save/clear for THIS store
              // remounts it with the new source of truth, while every
              // other row's in-progress, unsaved draft is left alone.
              key={`${store}-${configuredByStore.get(store) ?? "none"}`}
              projectId={projectId}
              store={store}
              configuredRate={configuredByStore.get(store) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CommissionRateRow({
  projectId,
  store,
  configuredRate,
}: {
  projectId: string;
  store: SubscriptionStoreCode;
  configuredRate: number | null;
}) {
  const { t } = useTranslation();
  const update = useUpdateCommissionRate(projectId);
  const del = useDeleteCommissionRate(projectId);

  const [percent, setPercent] = useState(
    configuredRate === null ? "" : String(configuredRate * 100),
  );

  const parsedPercent = Number.parseFloat(percent);
  const percentValid =
    percent.trim() !== "" &&
    Number.isFinite(parsedPercent) &&
    parsedPercent >= COMMISSION_RATE_PERCENT_MIN &&
    parsedPercent <= COMMISSION_RATE_PERCENT_MAX;
  const draftRate = percentValid
    ? Number((parsedPercent / 100).toFixed(COMMISSION_RATE_DECIMAL_PLACES))
    : null;
  const canSave = draftRate !== null && draftRate !== configuredRate;

  // Presets a citation exists for on THIS store — Stripe/Manual get a
  // plain custom-rate input and no preset (proceeds.ts carries no
  // sourced published rate for either).
  const presets = COMMISSION_RATE_PRESET_OPTIONS.filter((preset) => preset.store === store);

  function handleSave() {
    if (draftRate === null) return;
    update.mutate({ store, rate: draftRate });
  }

  function handleClear() {
    del.mutate(store);
  }

  // Offering a preset is not configuring one: this only fills the
  // input. The row still requires an explicit Save before anything is
  // written, so pre-selecting a preset can never be mistaken for a
  // configured rate.
  function applyPreset(rate: number) {
    setPercent(String(rate * 100));
  }

  const mutationError = update.error ?? del.error;

  return (
    <div
      data-testid={`commission-rate-row-${store}`}
      className="rounded-md border border-rv-divider bg-rv-c2 p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{t(STORE_LABEL_KEY[store])}</span>
        <span
          data-testid={`commission-rate-status-${store}`}
          className="text-[11px] text-rv-mute-500"
        >
          {configuredRate === null
            ? t("charts.proceeds.rateNotConfigured")
            : t("commissionRates.configuredAt", {
                rate: (configuredRate * 100).toFixed(2),
              })}
        </span>
      </div>

      {presets.length > 0 && (
        <div className="mb-2.5 flex flex-col gap-2">
          {presets.map((preset) => (
            <div
              key={preset.id}
              data-testid={`commission-rate-preset-${preset.id}`}
              className="rounded border border-rv-divider bg-rv-c1 p-2"
            >
              <div className="flex items-center justify-between gap-2">
                {/* Preset copy (label/description/citation) is the exact
                    sourced English text from @rovenue/shared's
                    commission-rates.ts — it is a quotation of Apple's
                    and Google's own published terms, so it is
                    deliberately NOT run through i18n (translating a
                    citation would misrepresent the source). */}
                <span className="text-[12px] font-medium text-foreground">{preset.label}</span>
                <Button
                  type="button"
                  variant="flat"
                  size="sm"
                  onClick={() => applyPreset(preset.rate)}
                >
                  {t("commissionRates.usePreset")}
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-rv-mute-500">{preset.description}</p>
              <ul className="mt-1 flex flex-col gap-0.5 pl-0">
                {preset.sources.map((source) => (
                  <li key={source.url} className="list-none text-[11px] text-rv-mute-500">
                    &ldquo;{source.quote}&rdquo;{" — "}
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {source.url}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10px] text-rv-mute-400">
                {t("commissionRates.fetchedOn", { date: preset.fetchedOn })}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="decimal"
          min={COMMISSION_RATE_PERCENT_MIN}
          max={COMMISSION_RATE_PERCENT_MAX}
          step={0.01}
          value={percent}
          placeholder={t("commissionRates.percentPlaceholder")}
          onChange={(event) => setPercent(event.target.value)}
          className="max-w-[120px]"
          aria-label={t("commissionRates.rateLabel")}
        />
        <span className="text-[12px] text-rv-mute-500">%</span>
        <Button
          type="button"
          variant="solid-primary"
          size="sm"
          disabled={!canSave || update.isPending}
          onClick={handleSave}
        >
          {t("commissionRates.save")}
        </Button>
        {configuredRate !== null && (
          <Button
            type="button"
            variant="light"
            size="sm"
            disabled={del.isPending}
            onClick={handleClear}
          >
            {t("commissionRates.clear")}
          </Button>
        )}
      </div>

      {percent.trim() !== "" && !percentValid && (
        <p className="mt-1 text-[11px] text-rv-danger">{t("commissionRates.invalidPercent")}</p>
      )}

      {mutationError && (
        <p role="alert" className="mt-1 text-[11px] text-rv-danger">
          {mutationError.message}
        </p>
      )}
    </div>
  );
}
