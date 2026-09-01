import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowUpRight, FlaskConical, X } from "lucide-react";
import type {
  AudienceRow,
  DashboardExperimentStatus,
  ExperimentListItem,
} from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { rpc, unwrap } from "../../lib/api";
import { Checkbox } from "../../ui/checkbox";
import { Chip, type ChipProps } from "../../ui/chip";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { useExperiments, useStartExperiment } from "../../lib/hooks/useExperiments";
import { useProjectPaywalls } from "../../lib/hooks/useProjectPaywalls";
import { useProjectPlacements } from "../../lib/hooks/useProjectPlacements";
import { useAudiences } from "../../lib/hooks/useProjectAdmin";
import { useCreateExperiment } from "../../lib/hooks/useExperiments";
import { usePublishedPaywallConfig } from "../../lib/hooks/usePublishedPaywallConfig";
import { findNode, OVERRIDABLE_PROP_KEYS } from "@rovenue/shared/paywall";

type Props = { onClose: () => void };

/** Server-assigned variant ids for a builder-launched A/B (paywalls.ts §6.19) — never client-chosen. */
const VARIANT_A_ID = "a";
const VARIANT_B_ID = "b";

/** An element test is a straight 50/50 between the published value and the
 *  candidate — there is no third thing to weight. */
const ELEMENT_VARIANT_WEIGHT = 0.5;

/** `<select>` sentinel meaning "no match-all audience exists yet — one will be created". */
const EVERYONE_WILL_BE_CREATED_VALUE = "";

type VariantBKind = "duplicate" | "existing";
type ExperimentKind = "PAYWALL" | "ELEMENT";

const STATUS_CHIP_TONE: Record<DashboardExperimentStatus, ChipProps["tone"]> = {
  DRAFT: "default",
  RUNNING: "success",
  PAUSED: "warning",
  COMPLETED: "default",
};

interface LaunchExperimentVars {
  name: string;
  variantB:
    | { kind: "duplicate"; name: string }
    | { kind: "existing"; paywallId: string };
  audienceId?: string;
  placement?: { placementId: string; rowIndex: number };
}

interface LaunchExperimentResult {
  experiment: ExperimentListItem;
  createdPaywallId: string | null;
}

interface PlacementCandidate {
  placementId: string;
  placementIdentifier: string;
  rowIndex: number;
}

// =============================================================
// File-local data hook — no `usePlacements` hook exists yet project-wide
// (grepped `src/lib/hooks` first per the brief) and `useAudiences` already
// does (useProjectAdmin.ts, imported above — a file-local duplicate would
// have fragmented the query-cache key audience mutations invalidate).
// This launch mutation has no home in useExperiments.ts either: that
// file's `useCreateExperiment` posts to the generic `/dashboard/experiments`
// endpoint, not this paywall-scoped atomic-launch one. Mirrors the bare
// useQuery-wrapping-rpc idiom of useOfferingResolvedPrices.ts.
// =============================================================

function useLaunchExperiment(projectId: string, paywallId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: LaunchExperimentVars) =>
      unwrap<LaunchExperimentResult>(
        rpc.dashboard.projects[":projectId"].paywalls[":id"].experiments.$post({
          param: { projectId, id: paywallId },
          json: vars,
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["experiments"] });
      qc.invalidateQueries({ queryKey: ["paywalls"] });
      qc.invalidateQueries({ queryKey: ["placements"] });
    },
  });
}

function isEmptyRules(rules: Record<string, unknown>): boolean {
  return Object.keys(rules).length === 0;
}

function matchAllAudienceOf(audiences: readonly AudienceRow[]): AudienceRow | null {
  return (
    audiences.find((a) => a.isDefault) ??
    audiences.find((a) => isEmptyRules(a.rules)) ??
    null
  );
}

function variantPaywallId(experiment: ExperimentListItem, variantId: string): string | null {
  const variant = experiment.variants.find((v) => v.id === variantId);
  const value = variant?.value as { paywallId?: string } | null | undefined;
  return value?.paywallId ?? null;
}

function matchesPaywall(experiment: ExperimentListItem, paywallId: string): boolean {
  return experiment.variants.some((v) => {
    const value = v.value as { paywallId?: string } | null | undefined;
    return value?.paywallId === paywallId;
  });
}

/** Static per-status t() calls — never build the key with the status value
 * itself, so Task 5's grep audit for `t("paywalls.builder.experiment.…"`
 * literals finds every one of these. */
function statusLabel(
  status: DashboardExperimentStatus,
  t: (key: string, fallback: string) => string,
): string {
  switch (status) {
    case "DRAFT":
      return t("paywalls.builder.experiment.status.draft", "Draft");
    case "RUNNING":
      return t("paywalls.builder.experiment.status.running", "Running");
    case "PAUSED":
      return t("paywalls.builder.experiment.status.paused", "Paused");
    case "COMPLETED":
      return t("paywalls.builder.experiment.status.completed", "Completed");
  }
}

/**
 * A/B-test the paywall being edited — the whole launch (duplicate/pick
 * variant B, create the DRAFT experiment, optionally repoint a placement
 * row) happens in one atomic call (§3.1). Renders one of two branches:
 * a create form when this paywall has no experiment yet, or a status panel
 * once one does. Overlay wrapper is byte-consistent with diff-modal.tsx
 * (no Escape handling / role="dialog" there either — stay idiom-consistent).
 */
export const ExperimentPopover = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const createElementExperiment = useCreateExperiment();
  const { t } = useTranslation();

  const projectId = vm.projectId;
  const paywall = vm.paywall;
  const paywallId = paywall?.id ?? "";

  const experimentsQuery = useExperiments({ projectId, type: "PAYWALL" });
  const paywallsQuery = useProjectPaywalls(projectId);
  const placementsQuery = useProjectPlacements(projectId);
  const audiencesQuery = useAudiences(projectId);
  const startExperiment = useStartExperiment();
  const launchExperiment = useLaunchExperiment(projectId, paywallId);

  const [kind, setKind] = useState<ExperimentKind>("PAYWALL");
  // Element mode varies ONE prop of the node the designer already selected
  // on the canvas — the natural builder gesture, and the only node we can
  // be sure they mean.
  const [elementProp, setElementProp] = useState<string | null>(null);
  const [elementVariantB, setElementVariantB] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [variantBKind, setVariantBKind] = useState<VariantBKind>("duplicate");
  const [duplicateName, setDuplicateName] = useState<string | null>(null);
  const [existingPaywallId, setExistingPaywallId] = useState("");
  const [audienceId, setAudienceId] = useState<string | null>(null);
  const [placementSel, setPlacementSel] = useState<PlacementCandidate | null>(null);
  const [justCreated, setJustCreated] = useState<LaunchExperimentResult | null>(null);
  const [placementProvidedOnCreate, setPlacementProvidedOnCreate] = useState(false);

  const experiments = experimentsQuery.data ?? [];
  const paywalls = paywallsQuery.data?.paywalls ?? [];
  const placements = placementsQuery.data?.placements ?? [];
  const audiences = audiencesQuery.data ?? [];

  const placementCandidates: PlacementCandidate[] = useMemo(() => {
    if (!paywall) return [];
    const candidates: PlacementCandidate[] = [];
    for (const placement of placements) {
      placement.rows.forEach((row, rowIndex) => {
        if (row.target.type === "paywall" && row.target.paywallId === paywall.id) {
          candidates.push({
            placementId: placement.id,
            placementIdentifier: placement.identifier,
            rowIndex,
          });
        }
      });
    }
    return candidates;
  }, [placements, paywall]);

  const selectedPlacement =
    placementSel ?? (placementCandidates.length === 1 ? placementCandidates[0] : null);

  const matchAllAudience = matchAllAudienceOf(audiences);
  const selectedAudienceId = audienceId ?? matchAllAudience?.id ?? EVERYONE_WILL_BE_CREATED_VALUE;

  const placementTargetsExperiment = (experimentId: string): boolean =>
    placements.some((p) =>
      p.rows.some((r) => r.target.type === "experiment" && r.target.experimentId === experimentId),
    );

  const liveActiveExperiment = paywall
    ? experiments.find((e) => e.status !== "COMPLETED" && matchesPaywall(e, paywall.id)) ?? null
    : null;

  const completedDarkExperiment =
    paywall && !liveActiveExperiment
      ? experiments.find(
          (e) =>
            e.status === "COMPLETED" &&
            matchesPaywall(e, paywall.id) &&
            placementTargetsExperiment(e.id),
        ) ?? null
      : null;

  // A COMPLETED experiment that's still targeted by a placement row is
  // usually winnerless (stop-with-winner normally repoints rows away from
  // it), but two real winner-carrying paths exist: experiments stopped
  // before this repoint feature shipped, and a stop whose winner variant
  // had no resolvable paywallId. Distinguish explicitly rather than assume.
  const completedDarkExperimentWinnerless = completedDarkExperiment?.winnerVariantId == null;

  const activeExperiment = justCreated?.experiment ?? liveActiveExperiment;
  const showStatusPanel = Boolean(activeExperiment) || Boolean(completedDarkExperiment);

  const defaultName = paywall ? `${paywall.name} A/B` : "";
  const defaultDuplicateName = paywall ? `${paywall.name} (B)` : "";
  // ----- Element mode -----
  // The builder canvas edits the DRAFT, but an element experiment is
  // validated server-side against the PUBLISHED version, because a patch
  // can only apply to what `/v1/placements` actually serves. Building the
  // picker from the draft would offer nodes the API rejects at submit, so
  // everything below reads the published tree.
  const published = usePublishedPaywallConfig(
    projectId,
    paywall?.id,
    kind === "ELEMENT",
  );
  const selectedNodeId = vm.selectedNodeId;
  const publishedNode =
    published.config && selectedNodeId
      ? findNode(published.config.root, selectedNodeId)
      : null;
  const overridableProps: readonly string[] = publishedNode
    ? OVERRIDABLE_PROP_KEYS[publishedNode.type]
    : [];
  const elementPropValue =
    elementProp ?? (overridableProps.length > 0 ? overridableProps[0]! : null);
  const variantAValue =
    publishedNode && elementPropValue
      ? String(
          (publishedNode as unknown as Record<string, unknown>)[
            elementPropValue
          ] ?? "",
        )
      : "";
  /** Why the element form cannot be submitted yet, or null when it can. */
  const elementBlocker: string | null = (() => {
    if (published.isLoading) return null;
    if (!published.hasPublishedVersion) {
      return t(
        "paywalls.builder.experiment.element.neverPublished",
        "This paywall has never been published, so there is nothing for an element test to change. Publish it first.",
      );
    }
    if (!selectedNodeId) {
      return t(
        "paywalls.builder.experiment.element.noSelection",
        "Select an element on the canvas to test it.",
      );
    }
    if (!publishedNode) {
      return t(
        "paywalls.builder.experiment.element.notPublished",
        "This element is not in the published version yet, so a test on it could never reach devices. Publish the paywall first.",
      );
    }
    if (overridableProps.length === 0) {
      return t(
        "paywalls.builder.experiment.element.noOverridableProps",
        "This element has no properties that can be varied per variant.",
      );
    }
    return null;
  })();

  const nameValue = name ?? defaultName;
  const duplicateNameValue = duplicateName ?? defaultDuplicateName;

  const otherPaywalls = paywall ? paywalls.filter((p) => p.id !== paywall.id) : paywalls;

  const canCreateElement =
    Boolean(paywall) &&
    nameValue.trim().length > 0 &&
    elementBlocker === null &&
    !published.isLoading &&
    elementPropValue !== null &&
    elementVariantB.trim().length > 0 &&
    elementVariantB.trim() !== variantAValue;

  const canCreate =
    kind === "ELEMENT"
      ? canCreateElement
      : Boolean(paywall) &&
        nameValue.trim().length > 0 &&
        (variantBKind === "duplicate"
          ? duplicateNameValue.trim().length > 0
          : existingPaywallId.length > 0);

  const handleCreate = () => {
    if (!paywall || !canCreate) return;
    if (kind === "ELEMENT") {
      if (!selectedNodeId || !elementPropValue) return;
      // Launching an element experiment must NOT write to the paywall: the
      // builder autosaves, and a server-side write to the body would be
      // clobbered by the next autosave (the client-side-apply invariant).
      // This creates an experiment that REFERENCES the paywall.
      createElementExperiment.mutate(
        {
          projectId,
          name: nameValue.trim(),
          type: "ELEMENT",
          audienceId: selectedAudienceId,
          variants: [
            {
              id: VARIANT_A_ID,
              name: "A",
              value: {
                paywallId: paywall.id,
                nodeId: selectedNodeId,
                props: { [elementPropValue]: variantAValue },
              },
              weight: ELEMENT_VARIANT_WEIGHT,
            },
            {
              id: VARIANT_B_ID,
              name: "B",
              value: {
                paywallId: paywall.id,
                nodeId: selectedNodeId,
                props: { [elementPropValue]: elementVariantB.trim() },
              },
              weight: ELEMENT_VARIANT_WEIGHT,
            },
          ],
        },
        {
          // `useCreateExperiment` already returns `{ experiment }`, the same
          // shape the PAYWALL launch returns, so the success panel is shared.
          // An element test creates no paywall — it patches nodes of the one
          // already open, which is the point of the mode.
          onSuccess: (created) =>
            setJustCreated({ ...created, createdPaywallId: null }),
        },
      );
      return;
    }
    const vars: LaunchExperimentVars = {
      name: nameValue.trim(),
      variantB:
        variantBKind === "duplicate"
          ? { kind: "duplicate", name: duplicateNameValue.trim() }
          : { kind: "existing", paywallId: existingPaywallId },
      ...(selectedAudienceId ? { audienceId: selectedAudienceId } : {}),
      ...(selectedPlacement
        ? {
            placement: {
              placementId: selectedPlacement.placementId,
              rowIndex: selectedPlacement.rowIndex,
            },
          }
        : {}),
    };
    setPlacementProvidedOnCreate(Boolean(selectedPlacement));
    launchExperiment.mutate(vars, {
      onSuccess: (result) => setJustCreated(result),
    });
  };

  const variantAPaywallId = activeExperiment ? variantPaywallId(activeExperiment, VARIANT_A_ID) : null;
  const variantBPaywallId = activeExperiment ? variantPaywallId(activeExperiment, VARIANT_B_ID) : null;

  const statusOf = (id: string | null): "draft" | "published" | "archived" | null => {
    if (!id) return null;
    if (paywall && id === paywall.id) return paywall.status;
    return paywalls.find((p) => p.id === id)?.status ?? null;
  };

  const variantAPublished = statusOf(variantAPaywallId) === "published";
  const variantBPublished = statusOf(variantBPaywallId) === "published";
  const placementAttached = activeExperiment
    ? placementTargetsExperiment(activeExperiment.id) ||
      (Boolean(justCreated) && placementProvidedOnCreate)
    : false;
  const allChecksPass = variantAPublished && variantBPublished && placementAttached;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[min(560px,94vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
              <FlaskConical size={15} className="text-rv-accent-500" />
              {t("paywalls.builder.experiment.title", "A/B test this paywall")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("paywalls.builder.experiment.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!paywall ? null : showStatusPanel ? (
            <div className="flex flex-col gap-4">
              {activeExperiment && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground">
                      {activeExperiment.name}
                    </span>
                    <Chip tone={STATUS_CHIP_TONE[activeExperiment.status]}>
                      {statusLabel(activeExperiment.status, t)}
                    </Chip>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <ChecklistRow
                      pass={variantAPublished}
                      label={t(
                        "paywalls.builder.experiment.status.checklistAPublished",
                        "Variant A is published",
                      )}
                    />
                    <ChecklistRow
                      pass={variantBPublished}
                      label={t(
                        "paywalls.builder.experiment.status.checklistBPublished",
                        "Variant B is published",
                      )}
                    />
                    <ChecklistRow
                      pass={placementAttached}
                      label={t(
                        "paywalls.builder.experiment.status.checklistPlacement",
                        "Attached to a placement",
                      )}
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!allChecksPass || startExperiment.isPending}
                      onClick={() => startExperiment.mutate(activeExperiment.id)}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition",
                        allChecksPass && !startExperiment.isPending
                          ? "cursor-pointer bg-rv-accent-500 text-white hover:bg-rv-accent-600"
                          : "cursor-not-allowed bg-rv-c2 text-rv-mute-600 opacity-60",
                      )}
                    >
                      {t("paywalls.builder.experiment.status.start", "Start experiment")}
                    </button>
                    <Link
                      to="/projects/$projectId/experiments/$experimentId"
                      params={{ projectId, experimentId: activeExperiment.id }}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
                    >
                      {t("paywalls.builder.experiment.status.viewLink", "View experiment")}
                      <ArrowUpRight size={12} />
                    </Link>
                    {/* Results render inline on the same experiment detail
                        route (no dedicated results tab/hash in the router
                        tree — see experiment-detail-panel.tsx), so this
                        points at the same destination as "View experiment". */}
                    <Link
                      to="/projects/$projectId/experiments/$experimentId"
                      params={{ projectId, experimentId: activeExperiment.id }}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
                    >
                      {t("paywalls.builder.experiment.status.viewResultsLink", "View results")}
                      <ArrowUpRight size={12} />
                    </Link>
                  </div>

                  {startExperiment.isError && (
                    <p className="text-[12px] text-rv-danger">
                      {t(
                        "paywalls.builder.experiment.status.startError",
                        "Couldn't start the experiment. Try again.",
                      )}
                    </p>
                  )}

                  {justCreated?.createdPaywallId && (
                    <Link
                      to="/projects/$projectId/paywalls/$paywallId/builder"
                      params={{ projectId, paywallId: justCreated.createdPaywallId }}
                      className="inline-flex w-fit items-center gap-1 text-[12px] text-rv-accent-500 hover:underline"
                    >
                      {t(
                        "paywalls.builder.experiment.create.openBuilder",
                        "Open variant B in the builder",
                      )}
                      <ArrowUpRight size={12} />
                    </Link>
                  )}
                </>
              )}

              {!activeExperiment && completedDarkExperiment && (
                <div className="flex items-start gap-2 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2 text-[12px] text-rv-warning">
                  <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      {completedDarkExperiment.name}
                      <Chip tone="default">
                        {statusLabel(completedDarkExperiment.status, t)}
                      </Chip>
                    </div>
                    <p className="mt-0.5">
                      {completedDarkExperimentWinnerless
                        ? t(
                            "paywalls.builder.experiment.status.darkPlacementWarning",
                            "This experiment completed without a winner and a placement row still targets it — that row won't serve until you repoint it.",
                          )
                        : t(
                            "paywalls.builder.experiment.status.darkPlacementWarningWithWinner",
                            "This placement still targets a completed experiment — point it at a paywall to resume serving.",
                          )}
                    </p>
                    <Link
                      to="/projects/$projectId/experiments/$experimentId"
                      params={{ projectId, experimentId: completedDarkExperiment.id }}
                      className="mt-1 inline-flex items-center gap-1 text-rv-accent-500 hover:underline"
                    >
                      {t("paywalls.builder.experiment.status.viewLink", "View experiment")}
                      <ArrowUpRight size={12} />
                    </Link>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-rv-mute-500">
                  {t("paywalls.builder.experiment.kind.label", "Test type")}
                </div>
                <div className="flex gap-2">
                  <label
                    className={cn(
                      "flex-1 cursor-pointer rounded-md border px-3 py-2 text-[12px] transition",
                      kind === "PAYWALL"
                        ? "border-rv-accent-500 bg-rv-accent-500/10 text-foreground"
                        : "border-rv-divider bg-rv-c2 text-rv-mute-600",
                    )}
                  >
                    <input
                      type="radio"
                      name="experiment-kind"
                      className="mr-1.5"
                      checked={kind === "PAYWALL"}
                      onChange={() => setKind("PAYWALL")}
                    />
                    {t("paywalls.builder.experiment.kind.paywall", "Paywall")}
                  </label>
                  <label
                    className={cn(
                      "flex-1 cursor-pointer rounded-md border px-3 py-2 text-[12px] transition",
                      kind === "ELEMENT"
                        ? "border-rv-accent-500 bg-rv-accent-500/10 text-foreground"
                        : "border-rv-divider bg-rv-c2 text-rv-mute-600",
                    )}
                  >
                    <input
                      type="radio"
                      name="experiment-kind"
                      className="mr-1.5"
                      checked={kind === "ELEMENT"}
                      onChange={() => setKind("ELEMENT")}
                    />
                    {t("paywalls.builder.experiment.kind.element", "Element")}
                  </label>
                </div>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-rv-mute-500">
                  {t("paywalls.builder.experiment.name.label", "Name")}
                </span>
                <Input value={nameValue} onChange={(e) => setName(e.target.value)} />
              </label>

              {kind === "ELEMENT" ? (
                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-rv-mute-500">
                    {t("paywalls.builder.experiment.element.label", "Element")}
                  </span>
                  {published.isLoading ? (
                    <p className="m-0 text-[12px] text-rv-mute-500">
                      {t(
                        "paywalls.builder.experiment.element.loading",
                        "Reading the published version…",
                      )}
                    </p>
                  ) : elementBlocker ? (
                    <p
                      role="status"
                      className="m-0 rounded-md border border-rv-warning/40 bg-rv-warning/10 px-3 py-2 text-[12px] text-foreground"
                    >
                      {elementBlocker}
                    </p>
                  ) : (
                    <>
                      <p className="m-0 text-[12px] text-rv-mute-600">
                        {t(
                          "paywalls.builder.experiment.element.selected",
                          "Testing {{type}} “{{id}}” from the published version.",
                          { type: publishedNode!.type, id: selectedNodeId },
                        )}
                      </p>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] text-rv-mute-500">
                          {t("paywalls.builder.experiment.element.prop", "Property")}
                        </span>
                        <NativeSelect
                          value={elementPropValue ?? ""}
                          onChange={(e) => {
                            setElementProp(e.target.value);
                            setElementVariantB("");
                          }}
                        >
                          {overridableProps.map((prop) => (
                            <option key={prop} value={prop}>
                              {prop}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] text-rv-mute-500">
                          {t("paywalls.builder.experiment.element.variantA", "A (published)")}
                        </span>
                        <Input value={variantAValue} readOnly disabled />
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] text-rv-mute-500">
                          {t("paywalls.builder.experiment.element.variantB", "B (candidate)")}
                        </span>
                        <Input
                          value={elementVariantB}
                          onChange={(e) => setElementVariantB(e.target.value)}
                        />
                      </label>
                    </>
                  )}
                </div>
              ) : (
              <div className="flex flex-col gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-rv-mute-500">
                  {t("paywalls.builder.experiment.variantB.label", "Variant B")}
                </span>

                <label className="flex items-center gap-2 text-[12px] text-foreground">
                  <input
                    type="radio"
                    name="variant-b-kind"
                    checked={variantBKind === "duplicate"}
                    onChange={() => setVariantBKind("duplicate")}
                  />
                  {t("paywalls.builder.experiment.variantB.duplicate", "Duplicate this paywall")}
                </label>
                {variantBKind === "duplicate" && (
                  <Input
                    className="ml-5 w-[calc(100%-1.25rem)]"
                    value={duplicateNameValue}
                    onChange={(e) => setDuplicateName(e.target.value)}
                  />
                )}

                <label className="flex items-center gap-2 text-[12px] text-foreground">
                  <input
                    type="radio"
                    name="variant-b-kind"
                    checked={variantBKind === "existing"}
                    onChange={() => setVariantBKind("existing")}
                  />
                  {t("paywalls.builder.experiment.variantB.existing", "Use an existing paywall")}
                </label>
                {variantBKind === "existing" && (
                  <NativeSelect
                    className="ml-5 w-[calc(100%-1.25rem)]"
                    value={existingPaywallId}
                    onChange={(e) => setExistingPaywallId(e.target.value)}
                  >
                    <option value="">
                      {t(
                        "paywalls.builder.experiment.variantB.existingPaywallPlaceholder",
                        "Select a paywall…",
                      )}
                    </option>
                    {otherPaywalls.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.status === "published"
                          ? p.name
                          : `${p.name} ${t(
                              "paywalls.builder.experiment.variantB.unpublishedSuffix",
                              "(unpublished)",
                            )}`}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </div>
              )}

              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-rv-mute-500">
                  {t("paywalls.builder.experiment.audience.label", "Audience")}
                </span>
                <NativeSelect
                  value={selectedAudienceId}
                  onChange={(e) => setAudienceId(e.target.value)}
                >
                  {!matchAllAudience && (
                    <option value={EVERYONE_WILL_BE_CREATED_VALUE}>
                      {t(
                        "paywalls.builder.experiment.audience.everyoneWillBeCreated",
                        "Everyone (will be created)",
                      )}
                    </option>
                  )}
                  {matchAllAudience && (
                    <option value={matchAllAudience.id}>
                      {t("paywalls.builder.experiment.audience.everyoneDefault", "Everyone (default)")}
                    </option>
                  )}
                  {audiences
                    .filter((a) => a.id !== matchAllAudience?.id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </NativeSelect>
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-rv-mute-500">
                  {t("paywalls.builder.experiment.placement.label", "Placement")}
                </span>
                {placementCandidates.length === 0 ? (
                  <div className="flex items-start gap-2 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2 text-[12px] text-rv-warning">
                    <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <p>
                        {t(
                          "paywalls.builder.experiment.placement.none",
                          "Not attached to any placement — the experiment won't serve until a placement targets it.",
                        )}
                      </p>
                      <Link
                        to="/projects/$projectId/placements"
                        params={{ projectId }}
                        className="mt-1 inline-flex items-center gap-1 text-rv-accent-500 hover:underline"
                      >
                        {t("paywalls.builder.experiment.placement.noneLink", "Go to placements")}
                        <ArrowUpRight size={12} />
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {placementCandidates.map((c) => (
                      <label
                        key={`${c.placementId}-${c.rowIndex}`}
                        className="flex items-center gap-2 text-[12px] text-foreground"
                      >
                        <Checkbox
                          checked={
                            selectedPlacement?.placementId === c.placementId &&
                            selectedPlacement?.rowIndex === c.rowIndex
                          }
                          onChange={() => setPlacementSel(c)}
                          ariaLabel={`${c.placementIdentifier} · row ${c.rowIndex + 1}`}
                        />
                        {t("paywalls.builder.experiment.placement.rowLabel", {
                          identifier: c.placementIdentifier,
                          // Display is 1-based ordinal ("row 1" for index 0);
                          // the posted { placementId, rowIndex } stays 0-based.
                          row: c.rowIndex + 1,
                          defaultValue: "{{identifier}} · row {{row}}",
                        })}
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-rv-mute-500">
                  {t(
                    "paywalls.builder.experiment.placement.splitCaption",
                    "50/50 split — adjust weights later on the experiment page",
                  )}
                </p>
              </div>

              {launchExperiment.isError && (
                <p className="text-[12px] text-rv-danger">
                  {t("paywalls.builder.experiment.create.error", "Couldn't create the experiment. Try again.")}
                </p>
              )}
            </div>
          )}
        </div>

        {paywall && !showStatusPanel && (
          <div className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 cursor-pointer items-center rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
            >
              {t("paywalls.builder.experiment.close", "Close")}
            </button>
            <button
              type="button"
              disabled={!canCreate || launchExperiment.isPending}
              onClick={handleCreate}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition",
                canCreate && !launchExperiment.isPending
                  ? "cursor-pointer bg-rv-accent-500 text-white hover:bg-rv-accent-600"
                  : "cursor-not-allowed bg-rv-c2 text-rv-mute-600 opacity-60",
              )}
            >
              {t("paywalls.builder.experiment.create.button", "Create experiment")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

function ChecklistRow({ pass, label }: { pass: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full text-[9px]",
          pass ? "bg-rv-success/15 text-rv-success" : "bg-rv-c4 text-rv-mute-600",
        )}
      >
        {pass ? "✓" : "✗"}
      </span>
      <span className={pass ? "text-foreground" : "text-rv-mute-600"}>{label}</span>
    </div>
  );
}
