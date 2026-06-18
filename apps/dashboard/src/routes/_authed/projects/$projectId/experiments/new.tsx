import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Link,
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CircleStop,
  FileText,
  FlaskConical,
  Hash,
  KeyRound,
  Layers,
  Package,
  Palette,
  Pause,
  Play,
  Plus,
  Scale,
  Sparkles,
  Tag,
  Target,
  Trash2,
  Type as TypeIcon,
  Users,
  Wand2,
} from "lucide-react";
import type {
  DashboardExperimentType,
  ExperimentListItem,
  PaywallConfig,
} from "@rovenue/shared";
import { Button } from "../../../../../ui/button";
import { Input } from "../../../../../ui/input";
import { NativeSelect } from "../../../../../ui/native-select";
import { Switch } from "../../../../../ui/switch";
import { Textarea } from "../../../../../ui/textarea";
import { cn } from "../../../../../lib/cn";
import { ApiError } from "../../../../../lib/api";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useAudiences } from "../../../../../lib/hooks/useProjectAdmin";
import { useProjectOfferings } from "../../../../../lib/hooks/useProjectOfferings";
import {
  useCreateExperiment,
  usePauseExperiment,
  useResumeExperiment,
  useStartExperiment,
  useStopExperiment,
  useUpdateExperiment,
  type CreateExperimentVars,
} from "../../../../../lib/hooks/useExperiments";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/experiments/new",
)({
  component: NewExperimentRouteComponent,
});

function NewExperimentRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/experiments/new",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <NewExperimentPage projectId={projectId} />;
}

// =============================================================
// Type catalogue
// =============================================================

type FlagSubtype = "boolean" | "string" | "number";

const TYPE_OPTIONS: ReadonlyArray<{
  value: DashboardExperimentType;
  labelKey: string;
}> = [
  { value: "FLAG", labelKey: "experiments.new.types.flag" },
  { value: "OFFERING", labelKey: "experiments.new.types.offering" },
  { value: "PAYWALL", labelKey: "experiments.new.types.paywall" },
  { value: "ELEMENT", labelKey: "experiments.new.types.element" },
];

const FLAG_SUBTYPES: ReadonlyArray<{ value: FlagSubtype; labelKey: string }> = [
  { value: "boolean", labelKey: "experiments.new.flag.subtypes.boolean" },
  { value: "string", labelKey: "experiments.new.flag.subtypes.string" },
  { value: "number", labelKey: "experiments.new.flag.subtypes.number" },
];

const DEFAULT_PAYWALL: PaywallConfig = {
  title: "Unlock Pro",
  subtitle: "Get every feature, ad-free",
  ctaText: "Start free trial",
  ctaColor: "#0066ff",
  layout: "vertical",
  showBadge: false,
  backgroundImage: null,
  showTestimonial: false,
};

interface DraftVariant {
  id: string;
  name: string;
  weight: number;
  // Per-type value cells — kept in parallel so switching type back
  // restores the user's previous choice instead of wiping them.
  flag: { boolValue: boolean; strValue: string; numValue: number };
  offeringId: string;
  paywall: PaywallConfig;
  element: string;
}

function makeVariant(idx: number): DraftVariant {
  const isControl = idx === 0;
  return {
    id: isControl ? "control" : `variant_${variantLetter(idx)}`,
    name: isControl ? "Control" : `Variant ${variantLetter(idx).toUpperCase()}`,
    weight: 0,
    flag: {
      boolValue: !isControl,
      strValue: isControl ? "control" : `variant_${variantLetter(idx)}`,
      numValue: isControl ? 0 : 1,
    },
    offeringId: "",
    paywall: { ...DEFAULT_PAYWALL, title: isControl ? "Unlock Pro" : "Unlock Pro" },
    element: JSON.stringify({ label: isControl ? "control" : "variant" }, null, 2),
  };
}

function variantLetter(idx: number): string {
  if (idx <= 0) return "a";
  return String.fromCharCode("a".charCodeAt(0) + (idx - 1));
}

// =============================================================
// Weight helpers
// =============================================================

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const roundTo = (n: number, decimals: number) => {
  const m = 10 ** decimals;
  return Math.round(n * m) / m;
};

/**
 * Move variant[idx] to `rawNew`; redistribute the remaining
 * (1 - newWeight) across the other variants proportionally to
 * their current weights. Drift from rounding is absorbed by the
 * last-touched other variant so the total stays exactly 1.
 */
function rebalanceWeights(
  variants: DraftVariant[],
  idx: number,
  rawNew: number,
): DraftVariant[] {
  const newWeight = roundTo(clamp01(rawNew), 2);
  if (variants.length <= 1) {
    return variants.map((v, i) => (i === idx ? { ...v, weight: 1 } : v));
  }
  const others = variants
    .map((v, i) => ({ v, i }))
    .filter(({ i }) => i !== idx);
  const otherSum = others.reduce((s, { v }) => s + v.weight, 0);
  const remaining = 1 - newWeight;

  const recomputed = others.map(({ v, i }) => {
    const next =
      otherSum <= 1e-9
        ? remaining / others.length
        : (v.weight / otherSum) * remaining;
    return { i, weight: roundTo(next, 2) };
  });

  const sum = recomputed.reduce((s, x) => s + x.weight, 0);
  const drift = roundTo(remaining - sum, 2);
  if (recomputed.length > 0 && Math.abs(drift) >= 0.01) {
    const last = recomputed[recomputed.length - 1]!;
    last.weight = clamp01(roundTo(last.weight + drift, 2));
  }

  return variants.map((v, i) => {
    if (i === idx) return { ...v, weight: newWeight };
    const updated = recomputed.find((x) => x.i === i)!;
    return { ...v, weight: updated.weight };
  });
}

function rebalanceEqually(variants: DraftVariant[]): DraftVariant[] {
  if (variants.length === 0) return variants;
  const per = roundTo(1 / variants.length, 2);
  const adjusted = variants.map((v) => ({ ...v, weight: per }));
  const drift = roundTo(1 - per * variants.length, 2);
  if (Math.abs(drift) >= 0.01) {
    adjusted[adjusted.length - 1]!.weight = clamp01(
      roundTo(adjusted[adjusted.length - 1]!.weight + drift, 2),
    );
  }
  return adjusted;
}

// =============================================================
// JSON helpers (ELEMENT editor + general validation)
// =============================================================

type JsonState =
  | { ok: true; value: unknown; pretty: string }
  | { ok: false; error: string };

function validateJson(raw: string): JsonState {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "value cannot be empty" };
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    return { ok: true, value, pretty: JSON.stringify(value, null, 2) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "invalid JSON",
    };
  }
}

// =============================================================
// Page
// =============================================================

// =============================================================
// Edit-mode seeding helpers
// =============================================================
//
// When the form mounts in edit mode we need to project the stored
// variant shape (`{ id, name, value, weight }`) back into the form's
// per-type DraftVariant state so the user sees their saved values.

function inferFlagSubtype(value: unknown): FlagSubtype {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function seedDraftVariant(
  idx: number,
  stored: { id: string; name: string; value: unknown; weight: number },
  type: DashboardExperimentType,
  flagSubtype: FlagSubtype,
): DraftVariant {
  const base = makeVariant(idx);
  const draft: DraftVariant = {
    ...base,
    id: stored.id,
    name: stored.name,
    weight: stored.weight,
  };
  if (type === "FLAG") {
    if (flagSubtype === "boolean")
      draft.flag.boolValue = Boolean(stored.value);
    else if (flagSubtype === "number")
      draft.flag.numValue = Number(stored.value) || 0;
    else draft.flag.strValue = String(stored.value ?? "");
  } else if (type === "OFFERING") {
    draft.offeringId = String(stored.value ?? "");
  } else if (type === "PAYWALL") {
    draft.paywall = {
      ...DEFAULT_PAYWALL,
      ...((stored.value as Partial<PaywallConfig>) ?? {}),
    };
  } else if (type === "ELEMENT") {
    draft.element = JSON.stringify(stored.value, null, 2);
  }
  return draft;
}

interface ExperimentFormPageProps {
  projectId: string;
  initialExperiment?: ExperimentListItem;
}

export function NewExperimentPage({
  projectId,
  initialExperiment,
}: ExperimentFormPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isEdit = Boolean(initialExperiment);
  const { data: audiences = [], isLoading: audiencesLoading } =
    useAudiences(projectId);
  const offeringsQuery = useProjectOfferings(projectId);
  const offerings = offeringsQuery.data?.offerings ?? [];
  const create = useCreateExperiment();
  const update = useUpdateExperiment();
  const start = useStartExperiment();
  const pause = usePauseExperiment();
  const resume = useResumeExperiment();
  const stop = useStopExperiment();

  const status = initialExperiment?.status ?? "DRAFT";
  const isReadOnly = isEdit && status !== "DRAFT";
  const lifecycleBusy =
    start.isPending || pause.isPending || resume.isPending || stop.isPending;

  const seededType = initialExperiment?.type ?? "FLAG";
  const seededFlagSubtype: FlagSubtype =
    initialExperiment && seededType === "FLAG"
      ? inferFlagSubtype(initialExperiment.variants[0]?.value)
      : "boolean";

  const [name, setName] = useState(initialExperiment?.name ?? "");
  const [key, setKey] = useState(initialExperiment?.key ?? "");
  const [description, setDescription] = useState(
    initialExperiment?.description ?? "",
  );
  const [type, setType] = useState<DashboardExperimentType>(seededType);
  const [flagSubtype, setFlagSubtype] = useState<FlagSubtype>(seededFlagSubtype);
  const [audienceId, setAudienceId] = useState<string>(
    initialExperiment?.audienceId ?? "",
  );
  const [variants, setVariants] = useState<DraftVariant[]>(() => {
    if (initialExperiment) {
      return initialExperiment.variants.map((v, idx) =>
        seedDraftVariant(idx, v, seededType, seededFlagSubtype),
      );
    }
    return rebalanceEqually([makeVariant(0), makeVariant(1)]);
  });
  const [formError, setFormError] = useState<string | null>(null);

  const resolvedAudienceId = audienceId || audiences[0]?.id || "";

  const weightSum = useMemo(
    () => variants.reduce((acc, v) => acc + (Number(v.weight) || 0), 0),
    [variants],
  );
  const weightOk = Math.abs(weightSum - 1) <= 1e-6;

  const elementErrors = useMemo(() => {
    if (type !== "ELEMENT") return [] as Array<string | null>;
    return variants.map((v) => {
      const r = validateJson(v.element);
      return r.ok ? null : r.error;
    });
  }, [type, variants]);
  const elementValid =
    type !== "ELEMENT" || elementErrors.every((e) => e === null);

  const updateVariant = (idx: number, patch: Partial<DraftVariant>) => {
    setVariants((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
    );
  };

  const updateVariantFlag = (
    idx: number,
    patch: Partial<DraftVariant["flag"]>,
  ) => {
    setVariants((prev) =>
      prev.map((v, i) =>
        i === idx ? { ...v, flag: { ...v.flag, ...patch } } : v,
      ),
    );
  };

  const updateVariantPaywall = (
    idx: number,
    patch: Partial<PaywallConfig>,
  ) => {
    setVariants((prev) =>
      prev.map((v, i) =>
        i === idx ? { ...v, paywall: { ...v.paywall, ...patch } } : v,
      ),
    );
  };

  const setVariantWeight = (idx: number, next: number) =>
    setVariants((prev) => rebalanceWeights(prev, idx, next));

  const addVariant = () => {
    setVariants((prev) => {
      const fresh = makeVariant(prev.length);
      // Pull weight from existing variants proportionally so the
      // newcomer starts at an equal share.
      const target = 1 / (prev.length + 1);
      const scaled = prev.map((v) => ({
        ...v,
        weight: roundTo(v.weight * (1 - target), 2),
      }));
      const next = [...scaled, { ...fresh, weight: roundTo(target, 2) }];
      // Fix rounding drift on the last entry before the newcomer.
      const sum = next.reduce((s, v) => s + v.weight, 0);
      const drift = roundTo(1 - sum, 2);
      if (Math.abs(drift) >= 0.01 && next.length >= 2) {
        const lastIdx = next.length - 2;
        next[lastIdx] = {
          ...next[lastIdx]!,
          weight: clamp01(roundTo(next[lastIdx]!.weight + drift, 2)),
        };
      }
      return next;
    });
  };

  const removeVariant = (idx: number) => {
    setVariants((prev) => {
      if (prev.length <= 2) return prev;
      const removedWeight = prev[idx]?.weight ?? 0;
      const remaining = prev.filter((_, i) => i !== idx);
      const otherSum = remaining.reduce((s, v) => s + v.weight, 0);
      // Spread the removed variant's share across survivors
      // proportionally so weights remain meaningful.
      const next = remaining.map((v) => {
        const share =
          otherSum <= 1e-9
            ? 1 / remaining.length
            : v.weight + (v.weight / otherSum) * removedWeight;
        return { ...v, weight: roundTo(share, 2) };
      });
      const sum = next.reduce((s, v) => s + v.weight, 0);
      const drift = roundTo(1 - sum, 2);
      if (Math.abs(drift) >= 0.01) {
        next[next.length - 1] = {
          ...next[next.length - 1]!,
          weight: clamp01(roundTo(next[next.length - 1]!.weight + drift, 2)),
        };
      }
      return next;
    });
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);

    if (!name.trim() || !key.trim()) {
      setFormError(t("experiments.new.errors.required"));
      return;
    }
    if (!/^[a-z0-9-_]+$/i.test(key.trim())) {
      setFormError(t("experiments.new.errors.invalidKey"));
      return;
    }
    if (!resolvedAudienceId) {
      setFormError(t("experiments.new.errors.noAudience"));
      return;
    }
    if (!weightOk) {
      setFormError(
        t("experiments.new.errors.weightSum", {
          sum: weightSum.toFixed(3),
        }),
      );
      return;
    }

    // Per-type validation + value extraction
    let parsedVariants: CreateExperimentVars["variants"];
    try {
      parsedVariants = variants.map((v, idx) => {
        const value = extractVariantValue(v, type, flagSubtype, idx);
        return {
          id: v.id.trim(),
          name: v.name.trim() || v.id.trim(),
          value,
          weight: Number(v.weight),
        };
      });
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t("experiments.new.errors.unknown"),
      );
      return;
    }

    if (type === "OFFERING") {
      const missing = parsedVariants.find(
        (v) => typeof v.value !== "string" || v.value.length === 0,
      );
      if (missing) {
        setFormError(t("experiments.new.errors.offeringMissing"));
        return;
      }
    }

    try {
      if (initialExperiment) {
        await update.mutateAsync({
          id: initialExperiment.id,
          name: name.trim(),
          description: description.trim() ? description.trim() : null,
          type,
          key: key.trim(),
          audienceId: resolvedAudienceId,
          variants: parsedVariants,
        });
      } else {
        await create.mutateAsync({
          projectId,
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          type,
          key: key.trim(),
          audienceId: resolvedAudienceId,
          variants: parsedVariants,
        });
      }
      void navigate({
        to: "/projects/$projectId/experiments",
        params: { projectId },
        search: { selected: key.trim() },
      });
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("experiments.new.errors.unknown"),
      );
    }
  };

  const submitDisabled =
    create.isPending || update.isPending || !weightOk || !elementValid;

  return (
    <>
      <header className="flex flex-col gap-4 pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Link
            to="/projects/$projectId/experiments"
            params={{ projectId }}
            className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
          >
            <ArrowLeft size={12} />
            {t("experiments.new.back")}
          </Link>
          <h1 className="mt-2 text-[24px] font-semibold leading-8 tracking-tight">
            {isEdit ? t("experiments.edit.title") : t("experiments.new.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
            {isEdit
              ? t("experiments.edit.subtitle")
              : t("experiments.new.subtitle")}
          </p>
        </div>
        {isEdit && initialExperiment ? (
          <LifecycleBar
            status={status}
            busy={lifecycleBusy}
            onStart={async () => {
              try {
                await start.mutateAsync(initialExperiment.id);
              } catch (err) {
                window.alert(
                  err instanceof Error
                    ? err.message
                    : t("experiments.lifecycle.startFailed"),
                );
              }
            }}
            onPause={async () => {
              try {
                await pause.mutateAsync(initialExperiment.id);
              } catch (err) {
                window.alert(
                  err instanceof Error
                    ? err.message
                    : t("experiments.lifecycle.pauseFailed"),
                );
              }
            }}
            onResume={async () => {
              try {
                await resume.mutateAsync(initialExperiment.id);
              } catch (err) {
                window.alert(
                  err instanceof Error
                    ? err.message
                    : t("experiments.lifecycle.resumeFailed"),
                );
              }
            }}
            onStop={async () => {
              const confirmed = window.confirm(
                t("experiments.lifecycle.stopConfirm", {
                  name: initialExperiment.key,
                }),
              );
              if (!confirmed) return;
              try {
                await stop.mutateAsync({ id: initialExperiment.id });
              } catch (err) {
                window.alert(
                  err instanceof Error
                    ? err.message
                    : t("experiments.lifecycle.stopFailed"),
                );
              }
            }}
          />
        ) : null}
      </header>

      <form
        onSubmit={handleSubmit}
        className="grid max-w-3xl grid-cols-1 gap-5"
      >
        {isReadOnly ? (
          <div className="flex items-start gap-2 rounded-md border border-rv-divider bg-rv-c2/60 px-3 py-2 text-[12px] text-rv-mute-700">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            <span>
              {t(`experiments.edit.readOnlyBanner.${status.toLowerCase()}`)}
            </span>
          </div>
        ) : null}
        <fieldset
          disabled={isReadOnly}
          className="contents disabled:cursor-not-allowed disabled:opacity-60"
        >
        <Section
          icon={<FileText size={13} />}
          title={t("experiments.new.sections.basics")}
          subtitle={t("experiments.new.sections.basicsSub")}
        >
          <Field
            icon={<Tag size={11} />}
            label={t("experiments.new.fields.name")}
            description={t("experiments.new.descriptions.name")}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("experiments.new.placeholders.name")}
              required
            />
          </Field>
          <Field
            icon={<KeyRound size={11} />}
            label={t("experiments.new.fields.key")}
            description={t("experiments.new.descriptions.key")}
          >
            <Input
              value={key}
              mono
              onChange={(e) => setKey(e.target.value)}
              placeholder="paywall_v2_pricing"
              required
            />
          </Field>
          <Field
            icon={<FileText size={11} />}
            label={t("experiments.new.fields.description")}
            description={t("experiments.new.descriptions.description")}
            optional
          >
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("experiments.new.placeholders.description")}
            />
          </Field>
        </Section>

        <Section
          icon={<Target size={13} />}
          title={t("experiments.new.sections.targeting")}
          subtitle={t("experiments.new.sections.targetingSub")}
        >
          <Field
            icon={<Layers size={11} />}
            label={t("experiments.new.fields.type")}
            description={t(
              `experiments.new.typeDescriptions.${type.toLowerCase()}`,
            )}
          >
            <NativeSelect
              value={type}
              onChange={(e) =>
                setType(e.target.value as DashboardExperimentType)
              }
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </NativeSelect>
          </Field>

          {type === "FLAG" && (
            <Field
              icon={<TypeIcon size={11} />}
              label={t("experiments.new.flag.subtypeLabel")}
              description={t(
                `experiments.new.flag.subtypeDescriptions.${flagSubtype}`,
              )}
            >
              <NativeSelect
                value={flagSubtype}
                onChange={(e) =>
                  setFlagSubtype(e.target.value as FlagSubtype)
                }
              >
                {FLAG_SUBTYPES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}

          {type === "OFFERING" && offerings.length === 0 && (
            <div className="flex items-start gap-2 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2 text-[12px] text-rv-warning">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="leading-snug">
                  {t("experiments.new.offering.noneTitle")}
                </p>
                <Link
                  to="/projects/$projectId/access"
                  params={{ projectId }}
                  className="mt-1 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                >
                  {t("experiments.new.offering.createCta")} →
                </Link>
              </div>
            </div>
          )}

          <Field
            icon={<Users size={11} />}
            label={t("experiments.new.fields.audience")}
            description={t("experiments.new.descriptions.audience")}
          >
            <NativeSelect
              value={resolvedAudienceId}
              onChange={(e) => setAudienceId(e.target.value)}
              disabled={audiencesLoading || audiences.length === 0}
            >
              {audiences.length === 0 ? (
                <option value="">
                  {t("experiments.new.audienceEmpty")}
                </option>
              ) : (
                audiences.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.isDefault ? " · default" : ""}
                  </option>
                ))
              )}
            </NativeSelect>
          </Field>
        </Section>

        <Section
          icon={<FlaskConical size={13} />}
          title={t("experiments.new.sections.variants")}
          subtitle={t("experiments.new.sections.variantsSub")}
          right={
            <div
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-rv-mono text-[10px]",
                weightOk
                  ? "border-rv-success/30 bg-rv-success/10 text-rv-success"
                  : "border-rv-danger/30 bg-rv-danger/10 text-rv-danger",
              )}
            >
              <Scale size={10} />
              Σ = {weightSum.toFixed(3)}
            </div>
          }
        >
          <div className="flex flex-col gap-3">
            {variants.map((v, idx) => {
              const pct = Math.round((Number(v.weight) || 0) * 100);
              return (
                <div
                  key={idx}
                  className="rounded-md border border-rv-divider bg-rv-c2 p-3.5"
                >
                  <div className="mb-3 flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider",
                        idx === 0
                          ? "bg-rv-c4 text-rv-mute-700"
                          : "bg-rv-accent-500/10 text-rv-accent-500",
                      )}
                    >
                      {idx === 0 ? <Hash size={9} /> : <Sparkles size={9} />}
                      {idx === 0
                        ? t("experiments.new.controlBadge")
                        : t("experiments.new.variantBadge", { index: idx })}
                    </span>
                    <span className="font-rv-mono text-[10px] text-rv-mute-500">
                      {pct}% {t("experiments.new.trafficLabel")}
                    </span>
                    {variants.length > 2 && (
                      <button
                        type="button"
                        aria-label={t("experiments.new.removeVariant")}
                        onClick={() => removeVariant(idx)}
                        className="ml-auto inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <Field
                      label={t("experiments.new.fields.variantId")}
                      description={t(
                        "experiments.new.descriptions.variantId",
                      )}
                      dense
                    >
                      <Input
                        aria-label={t("experiments.new.fields.variantId")}
                        mono
                        value={v.id}
                        onChange={(e) =>
                          updateVariant(idx, { id: e.target.value })
                        }
                        placeholder={t(
                          "experiments.new.placeholders.variantId",
                        )}
                      />
                    </Field>
                    <Field
                      label={t("experiments.new.fields.variantName")}
                      description={t(
                        "experiments.new.descriptions.variantName",
                      )}
                      dense
                    >
                      <Input
                        aria-label={t("experiments.new.fields.variantName")}
                        value={v.name}
                        onChange={(e) =>
                          updateVariant(idx, { name: e.target.value })
                        }
                        placeholder={t(
                          "experiments.new.placeholders.variantName",
                        )}
                      />
                    </Field>
                  </div>

                  <Field
                    label={t("experiments.new.fields.variantWeight")}
                    description={t(
                      "experiments.new.descriptions.variantWeight",
                    )}
                    dense
                    className="mt-3"
                  >
                    <WeightSlider
                      value={v.weight}
                      onChange={(next) => setVariantWeight(idx, next)}
                    />
                  </Field>

                  <div className="mt-3">
                    <VariantValueEditor
                      type={type}
                      flagSubtype={flagSubtype}
                      variant={v}
                      offerings={offerings}
                      offeringsLoading={offeringsQuery.isLoading}
                      jsonError={elementErrors[idx] ?? null}
                      onFlagChange={(patch) => updateVariantFlag(idx, patch)}
                      onOfferingChange={(id) =>
                        updateVariant(idx, { offeringId: id })
                      }
                      onPaywallChange={(patch) =>
                        updateVariantPaywall(idx, patch)
                      }
                      onElementChange={(next) =>
                        updateVariant(idx, { element: next })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={addVariant}
            className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-rv-divider-strong bg-transparent px-4 py-3 text-[12px] font-medium text-rv-mute-600 transition hover:border-rv-accent-500 hover:bg-rv-accent-500/5 hover:text-rv-accent-500"
          >
            <Plus size={13} />
            {t("experiments.new.addVariant")}
          </button>
        </Section>
        </fieldset>

        {formError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {formError}
          </div>
        )}

        {!isReadOnly ? (
          <div className="flex items-center gap-2 pt-2">
            <Button
              type="submit"
              variant="solid-primary"
              disabled={submitDisabled}
            >
              {isEdit
                ? update.isPending
                  ? t("experiments.edit.submitting")
                  : t("experiments.edit.submit")
                : create.isPending
                  ? t("experiments.new.submitting")
                  : t("experiments.new.submit")}
            </Button>
            <Link
              to="/projects/$projectId/experiments"
              params={{ projectId }}
              className="text-[12px] text-rv-mute-500 hover:text-foreground"
            >
              {t("experiments.new.cancel")}
            </Link>
          </div>
        ) : null}
      </form>
    </>
  );
}

// =============================================================
// Lifecycle bar — status indicator + state-machine actions
// =============================================================
//
// Sits in the edit-page header. The pulsing dot reads "live" for
// RUNNING (green), solid for PAUSED (yellow). Buttons are gated by
// the current state: DRAFT → Activate, RUNNING → Pause + Complete,
// PAUSED → Resume + Complete, COMPLETED → no actions.

type ApiStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";

function LifecycleBar({
  status,
  busy,
  onStart,
  onPause,
  onResume,
  onStop,
}: {
  status: ApiStatus;
  busy: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-shrink-0 items-center gap-2 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2">
      <LiveIndicator status={status} />
      {status === "DRAFT" && (
        <Button
          variant="solid-primary"
          onClick={onStart}
          disabled={busy}
        >
          <Play size={13} />
          {t("experiments.lifecycle.activate")}
        </Button>
      )}
      {status === "RUNNING" && (
        <>
          <Button variant="flat" onClick={onPause} disabled={busy}>
            <Pause size={13} />
            {t("experiments.lifecycle.pause")}
          </Button>
          <Button variant="flat" onClick={onStop} disabled={busy}>
            <CircleStop size={13} />
            {t("experiments.lifecycle.complete")}
          </Button>
        </>
      )}
      {status === "PAUSED" && (
        <>
          <Button variant="solid-primary" onClick={onResume} disabled={busy}>
            <Play size={13} />
            {t("experiments.lifecycle.resume")}
          </Button>
          <Button variant="flat" onClick={onStop} disabled={busy}>
            <CircleStop size={13} />
            {t("experiments.lifecycle.complete")}
          </Button>
        </>
      )}
    </div>
  );
}

function LiveIndicator({ status }: { status: ApiStatus }) {
  const { t } = useTranslation();
  const isLive = status === "RUNNING";
  const isPaused = status === "PAUSED";
  const isCompleted = status === "COMPLETED";
  const isDraft = status === "DRAFT";

  return (
    <div className="inline-flex items-center gap-2 rounded-md bg-rv-c2 px-2.5 py-1.5">
      <span className="relative inline-flex size-2.5 flex-shrink-0">
        <span
          className={cn(
            "size-2.5 rounded-full",
            isLive && "bg-rv-success",
            isPaused && "bg-rv-warning",
            isCompleted && "bg-rv-mute-500",
            isDraft && "bg-rv-mute-500",
          )}
        />
        {isLive && (
          <span
            aria-hidden
            className="absolute inset-0 -m-1 rounded-full bg-rv-success/30"
            style={{ animation: "var(--animate-rv-pulse)" }}
          />
        )}
      </span>
      <span className="font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-700">
        {t(`experiments.lifecycle.indicator.${status.toLowerCase()}`)}
      </span>
    </div>
  );
}

// =============================================================
// Variant value extraction
// =============================================================

function extractVariantValue(
  v: DraftVariant,
  type: DashboardExperimentType,
  flagSubtype: FlagSubtype,
  idx: number,
): unknown {
  if (type === "FLAG") {
    if (flagSubtype === "boolean") return v.flag.boolValue;
    if (flagSubtype === "string") return v.flag.strValue;
    return Number.isFinite(v.flag.numValue) ? v.flag.numValue : 0;
  }
  if (type === "OFFERING") return v.offeringId;
  if (type === "PAYWALL") return { ...v.paywall };
  // ELEMENT
  const parsed = validateJson(v.element);
  if (!parsed.ok) {
    throw new Error(`variant ${idx}: ${parsed.error}`);
  }
  return parsed.value;
}

// =============================================================
// Variant value editors (one per experiment type)
// =============================================================

function VariantValueEditor({
  type,
  flagSubtype,
  variant,
  offerings,
  offeringsLoading,
  jsonError,
  onFlagChange,
  onOfferingChange,
  onPaywallChange,
  onElementChange,
}: {
  type: DashboardExperimentType;
  flagSubtype: FlagSubtype;
  variant: DraftVariant;
  offerings: ReadonlyArray<{ id: string; identifier: string }>;
  offeringsLoading: boolean;
  jsonError: string | null;
  onFlagChange: (patch: Partial<DraftVariant["flag"]>) => void;
  onOfferingChange: (identifier: string) => void;
  onPaywallChange: (patch: Partial<PaywallConfig>) => void;
  onElementChange: (next: string) => void;
}) {
  if (type === "FLAG") {
    return (
      <FlagValueEditor
        subtype={flagSubtype}
        value={variant.flag}
        onChange={onFlagChange}
      />
    );
  }
  if (type === "OFFERING") {
    return (
      <OfferingValueEditor
        value={variant.offeringId}
        offerings={offerings}
        loading={offeringsLoading}
        onChange={onOfferingChange}
      />
    );
  }
  if (type === "PAYWALL") {
    return (
      <PaywallValueEditor value={variant.paywall} onChange={onPaywallChange} />
    );
  }
  return (
    <ElementValueEditor
      value={variant.element}
      error={jsonError}
      onChange={onElementChange}
    />
  );
}

// ---------- FLAG ----------

function FlagValueEditor({
  subtype,
  value,
  onChange,
}: {
  subtype: FlagSubtype;
  value: DraftVariant["flag"];
  onChange: (patch: Partial<DraftVariant["flag"]>) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t("experiments.new.fields.flagValue")}
      description={t(`experiments.new.flag.valueDescriptions.${subtype}`)}
      dense
    >
      {subtype === "boolean" && (
        <div className="inline-flex items-center gap-3 rounded-md border border-rv-divider bg-rv-c1 px-3 py-2">
          <Switch
            checked={value.boolValue}
            onChange={(next) => onChange({ boolValue: next })}
            ariaLabel={t("experiments.new.fields.flagValue")}
          />
          <span className="font-rv-mono text-[12px] tabular-nums">
            {value.boolValue ? "true" : "false"}
          </span>
        </div>
      )}
      {subtype === "string" && (
        <Input
          mono
          value={value.strValue}
          onChange={(e) => onChange({ strValue: e.target.value })}
          placeholder='"variant-a"'
        />
      )}
      {subtype === "number" && (
        <Input
          mono
          type="number"
          step="any"
          value={value.numValue}
          onChange={(e) => onChange({ numValue: Number(e.target.value) })}
        />
      )}
    </Field>
  );
}

// ---------- OFFERING ----------

function OfferingValueEditor({
  value,
  offerings,
  loading,
  onChange,
}: {
  value: string;
  offerings: ReadonlyArray<{ id: string; identifier: string }>;
  loading: boolean;
  onChange: (identifier: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field
      icon={<Package size={11} />}
      label={t("experiments.new.fields.offering")}
      description={t("experiments.new.descriptions.offering")}
      dense
    >
      <NativeSelect
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading || offerings.length === 0}
      >
        <option value="">
          {offerings.length === 0
            ? t("experiments.new.offering.empty")
            : t("experiments.new.offering.pick")}
        </option>
        {offerings.map((g) => (
          <option key={g.id} value={g.identifier}>
            {g.identifier}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

// ---------- PAYWALL ----------

function PaywallValueEditor({
  value,
  onChange,
}: {
  value: PaywallConfig;
  onChange: (patch: Partial<PaywallConfig>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-rv-divider bg-rv-c1 p-3">
      <div className="mb-2 inline-flex items-center gap-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
        <Palette size={10} />
        {t("experiments.new.paywall.heading")}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Field
          label={t("experiments.new.paywall.title")}
          dense
        >
          <Input
            value={value.title}
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </Field>
        <Field
          label={t("experiments.new.paywall.subtitle")}
          dense
        >
          <Input
            value={value.subtitle}
            onChange={(e) => onChange({ subtitle: e.target.value })}
          />
        </Field>
        <Field label={t("experiments.new.paywall.ctaText")} dense>
          <Input
            value={value.ctaText}
            onChange={(e) => onChange({ ctaText: e.target.value })}
          />
        </Field>
        <Field label={t("experiments.new.paywall.ctaColor")} dense>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={value.ctaColor}
              onChange={(e) => onChange({ ctaColor: e.target.value })}
              className="size-9 cursor-pointer rounded border border-rv-divider bg-rv-c2"
              aria-label={t("experiments.new.paywall.ctaColor")}
            />
            <Input
              mono
              value={value.ctaColor}
              onChange={(e) => onChange({ ctaColor: e.target.value })}
              placeholder="#0066ff"
            />
          </div>
        </Field>
        <Field label={t("experiments.new.paywall.layout")} dense>
          <NativeSelect
            value={value.layout}
            onChange={(e) =>
              onChange({
                layout: e.target.value as PaywallConfig["layout"],
              })
            }
          >
            <option value="vertical">
              {t("experiments.new.paywall.layoutOptions.vertical")}
            </option>
            <option value="horizontal">
              {t("experiments.new.paywall.layoutOptions.horizontal")}
            </option>
          </NativeSelect>
        </Field>
        <Field label={t("experiments.new.paywall.backgroundImage")} dense optional>
          <Input
            mono
            value={value.backgroundImage ?? ""}
            onChange={(e) =>
              onChange({
                backgroundImage:
                  e.target.value.trim().length > 0
                    ? e.target.value
                    : null,
              })
            }
            placeholder="https://…"
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rv-divider pt-3">
        <ToggleRow
          label={t("experiments.new.paywall.showBadge")}
          checked={value.showBadge}
          onChange={(next) => onChange({ showBadge: next })}
        />
        {value.showBadge && (
          <Input
            value={value.badgeText ?? ""}
            onChange={(e) => onChange({ badgeText: e.target.value })}
            placeholder={t("experiments.new.paywall.badgePlaceholder")}
            className="max-w-[200px]"
          />
        )}
        <ToggleRow
          label={t("experiments.new.paywall.showTestimonial")}
          checked={value.showTestimonial}
          onChange={(next) => onChange({ showTestimonial: next })}
        />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-rv-mute-700">
      <Switch checked={checked} onChange={onChange} ariaLabel={label} />
      <span>{label}</span>
    </label>
  );
}

// ---------- ELEMENT (arbitrary JSON) ----------

function ElementValueEditor({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | null;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const valid = error === null;

  const handleFormat = () => {
    const r = validateJson(value);
    if (r.ok) onChange(r.pretty);
  };

  return (
    <Field
      label={t("experiments.new.fields.variantValue")}
      description={t("experiments.new.descriptions.variantValue")}
      dense
    >
      <div
        className={cn(
          "overflow-hidden rounded-md border bg-rv-c1",
          valid
            ? "border-rv-divider"
            : "border-rv-danger/40 ring-1 ring-rv-danger/20",
        )}
      >
        <div className="flex items-center justify-between border-b border-rv-divider bg-rv-c2/40 px-2.5 py-1.5">
          <div
            className={cn(
              "inline-flex items-center gap-1 font-rv-mono text-[10px]",
              valid ? "text-rv-success" : "text-rv-danger",
            )}
          >
            {valid ? <Check size={10} /> : <AlertCircle size={10} />}
            {valid
              ? t("experiments.new.json.valid")
              : t("experiments.new.json.invalid")}
          </div>
          <button
            type="button"
            onClick={handleFormat}
            disabled={!valid}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 font-rv-mono text-[10px] text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-rv-mute-600"
          >
            <Wand2 size={10} />
            {t("experiments.new.json.format")}
          </button>
        </div>
        <Textarea
          aria-label={t("experiments.new.fields.variantValue")}
          className="rounded-none border-0 bg-transparent font-rv-mono text-[12px] focus:ring-0"
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("experiments.new.placeholders.variantValue")}
        />
      </div>
      {!valid && (
        <span className="mt-1 inline-flex items-start gap-1 font-rv-mono text-[10px] text-rv-danger">
          <AlertCircle size={10} className="mt-px flex-shrink-0" />
          {error}
        </span>
      )}
    </Field>
  );
}

// =============================================================
// Layout helpers
// =============================================================

function Section({
  icon,
  title,
  subtitle,
  right,
  children,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-start justify-between gap-3 border-b border-rv-divider bg-rv-c2/40 px-4 py-3">
        <div className="flex items-start gap-2.5">
          {icon && (
            <span className="mt-0.5 inline-flex size-6 items-center justify-center rounded-md bg-rv-accent-500/10 text-rv-accent-500">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium leading-5">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {right}
      </div>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

function Field({
  icon,
  label,
  description,
  optional,
  dense,
  className,
  children,
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  optional?: boolean;
  dense?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col", dense ? "gap-1" : "gap-1.5", className)}>
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {icon && <span className="text-rv-mute-400">{icon}</span>}
        {label}
        {optional && (
          <span className="ml-0.5 text-rv-mute-400 normal-case tracking-normal">
            (optional)
          </span>
        )}
      </span>
      {description && (
        <span className="text-[11px] leading-snug text-rv-mute-500">
          {description}
        </span>
      )}
      {children}
    </label>
  );
}

function WeightSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-rv-c3 accent-rv-accent-500"
        style={{
          background: `linear-gradient(to right, var(--color-rv-accent-500) 0%, var(--color-rv-accent-500) ${pct * 100}%, var(--color-rv-c3) ${pct * 100}%, var(--color-rv-c3) 100%)`,
        }}
      />
      <div className="flex w-20 items-center gap-1.5 rounded border border-rv-divider bg-rv-c1 px-2 py-1 font-rv-mono text-[11px] tabular-nums">
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full appearance-none border-0 bg-transparent p-0 text-[11px] focus:outline-none focus:ring-0"
        />
        <span className="text-rv-mute-500">·</span>
        <span className="text-rv-mute-500">{Math.round(pct * 100)}%</span>
      </div>
    </div>
  );
}
