import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowLeft,
  FileText,
  Tag,
  Target,
  Users,
} from "lucide-react";
import type { AudienceRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api";
import {
  useCreateAudience,
  useUpdateAudience,
} from "../../lib/hooks/useProjectAdmin";
import { ConditionList } from "../targeting/condition-builder";
import {
  conditionsToSift,
  siftToConditions,
  type DraftCondition,
} from "../targeting/sift-codec";

export interface AudienceFormProps {
  projectId: string;
  initialAudience?: AudienceRow;
}

export function AudienceForm({ projectId, initialAudience }: AudienceFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isEdit = Boolean(initialAudience);
  const isDefault = initialAudience?.isDefault ?? false;
  const create = useCreateAudience();
  const update = useUpdateAudience();

  const [name, setName] = useState(initialAudience?.name ?? "");
  const [description, setDescription] = useState(
    initialAudience?.description ?? "",
  );
  const [conditions, setConditions] = useState<DraftCondition[]>(() =>
    initialAudience ? siftToConditions(initialAudience.rules) : [],
  );
  const [formError, setFormError] = useState<string | null>(null);

  const previewDoc = useMemo(
    () => conditionsToSift(conditions) ?? {},
    [conditions],
  );

  const pending = create.isPending || update.isPending;
  const submitDisabled = pending || name.trim().length === 0;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);

    if (name.trim().length === 0) {
      setFormError(t("audiences.form.errors.nameRequired"));
      return;
    }

    try {
      if (initialAudience) {
        await update.mutateAsync({
          id: initialAudience.id,
          projectId,
          name: name.trim(),
          description:
            description.trim().length > 0 ? description.trim() : null,
          rules: conditionsToSift(conditions) ?? {},
        });
      } else {
        await create.mutateAsync({
          projectId,
          name: name.trim(),
          ...(description.trim().length > 0
            ? { description: description.trim() }
            : {}),
          rules: conditionsToSift(conditions) ?? {},
        });
      }
      void navigate({
        to: "/projects/$projectId/audiences",
        params: { projectId },
      });
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("audiences.form.errors.unknown"),
      );
    }
  };

  return (
    <>
      <header className="pb-5">
        <Link
          to="/projects/$projectId/audiences"
          params={{ projectId }}
          className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
        >
          <ArrowLeft size={12} />
          {t("audiences.form.back")}
        </Link>
        <h1 className="mt-2 text-[24px] font-semibold leading-8 tracking-tight">
          {isEdit
            ? isDefault
              ? t("audiences.form.titleDefault")
              : t("audiences.form.titleEdit")
            : t("audiences.form.titleNew")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
          {isEdit
            ? t("audiences.form.subtitleEdit")
            : t("audiences.form.subtitleNew")}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="grid max-w-3xl grid-cols-1 gap-5">
        {isDefault && (
          <div className="flex items-start gap-2 rounded-md border border-rv-divider bg-rv-c2/60 px-3 py-2 text-[12px] text-rv-mute-700">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            <span>{t("audiences.form.defaultBanner")}</span>
          </div>
        )}

        <fieldset
          disabled={isDefault}
          className="contents disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Section
            icon={<FileText size={13} />}
            title={t("audiences.form.sections.basics")}
            subtitle={t("audiences.form.sections.basicsSub")}
          >
            <Field
              icon={<Tag size={11} />}
              label={t("audiences.form.fields.name")}
              description={t("audiences.form.descriptions.name")}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("audiences.form.placeholders.name")}
                required
              />
            </Field>
            <Field
              icon={<FileText size={11} />}
              label={t("audiences.form.fields.description")}
              description={t("audiences.form.descriptions.description")}
              optional
            >
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder={t("audiences.form.placeholders.description")}
              />
            </Field>
          </Section>

          <Section
            icon={<Target size={13} />}
            title={t("audiences.form.sections.rules")}
            subtitle={t("audiences.form.sections.rulesSub")}
            right={
              <span className="inline-flex items-center gap-1 rounded-full border border-rv-divider bg-rv-c4 px-2 py-0.5 font-rv-mono text-[10px] text-rv-mute-700">
                <Users size={9} />
                {conditions.length === 0
                  ? t("audiences.form.allUsers")
                  : t("audiences.form.conditionCount", {
                      count: conditions.length,
                    })}
              </span>
            }
          >
            <ConditionList
              conditions={conditions}
              onChange={setConditions}
              disabled={isDefault}
            />

            <Field
              label={t("audiences.form.preview")}
              description={t("audiences.form.previewSub")}
              dense
              className="mt-2"
            >
              <pre className="overflow-x-auto rounded-md border border-rv-divider bg-rv-c1 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
                {JSON.stringify(previewDoc, null, 2)}
              </pre>
            </Field>
          </Section>
        </fieldset>

        {formError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {formError}
          </div>
        )}

        {!isDefault && (
          <div className="flex items-center gap-2 pt-2">
            <Button
              type="submit"
              variant="solid-primary"
              disabled={submitDisabled}
            >
              {isEdit
                ? pending
                  ? t("audiences.form.submittingEdit")
                  : t("audiences.form.submitEdit")
                : pending
                  ? t("audiences.form.submittingNew")
                  : t("audiences.form.submitNew")}
            </Button>
            <Link
              to="/projects/$projectId/audiences"
              params={{ projectId }}
              className="text-[12px] text-rv-mute-500 hover:text-foreground"
            >
              {t("audiences.form.cancel")}
            </Link>
          </div>
        )}
      </form>
    </>
  );
}

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
    <label
      className={cn(
        "flex flex-col",
        dense ? "gap-1" : "gap-1.5",
        className,
      )}
    >
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
