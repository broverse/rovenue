import { useTranslation } from "react-i18next";
import { ReviewRow, ReviewSection } from "./review-section";
import { StepHead } from "./step-head";
import type { SetupForm, SetupMode } from "./types";

type StepReviewProps = {
  form: SetupForm;
  mode: SetupMode;
  onJump: (id: number) => void;
};

export function StepReview({ form, mode, onJump }: StepReviewProps) {
  const { t } = useTranslation();
  const isUpdate = mode === "update";

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.review.eyebrow")}
        title={t(
          isUpdate ? "projectSetup.review.titleUpdate" : "projectSetup.review.titleCreate",
        )}
        description={t(
          isUpdate
            ? "projectSetup.review.descriptionUpdate"
            : "projectSetup.review.descriptionCreate",
        )}
      />

      <ReviewSection
        index={1}
        title={t("projectSetup.steps.basics.label")}
        onEdit={() => onJump(1)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.name")}
          value={form.name || t("projectSetup.review.notSet")}
          empty={!form.name}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.url")}
          value={`app.rovenue.io/${form.slug || "—"}`}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.environment")}
          value={form.env}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.description")}
          value={form.desc || t("projectSetup.review.notSet")}
          empty={!form.desc}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.tags")}
          value={
            form.tags.length
              ? form.tags.join(", ")
              : t("projectSetup.review.none")
          }
          empty={form.tags.length === 0}
        />
      </ReviewSection>

      <ReviewSection
        index={2}
        title={t("projectSetup.steps.platforms.label")}
        onEdit={() => onJump(2)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.activePlatforms")}
          value={
            form.platforms.length
              ? form.platforms.join(", ")
              : t("projectSetup.review.platformsEmpty")
          }
          empty={form.platforms.length === 0}
        />
        {form.platforms.includes("ios") ? (
          <ReviewRow
            label={t("projectSetup.review.fields.iosBundle")}
            value={form.bundleId || t("projectSetup.review.notSet")}
            empty={!form.bundleId}
          />
        ) : null}
        {form.platforms.includes("android") ? (
          <ReviewRow
            label={t("projectSetup.review.fields.androidPackage")}
            value={form.androidPackage || t("projectSetup.review.notSet")}
            empty={!form.androidPackage}
          />
        ) : null}
        {form.platforms.includes("web") ? (
          <ReviewRow
            label={t("projectSetup.review.fields.stripeAccount")}
            value={form.stripeAcct || t("projectSetup.review.notSet")}
            empty={!form.stripeAcct}
          />
        ) : null}
        <ReviewRow
          label={t("projectSetup.review.fields.sandboxMirror")}
          value={t(
            form.sandbox
              ? "projectSetup.review.toggle.enabled"
              : "projectSetup.review.toggle.disabled",
          )}
        />
      </ReviewSection>

      <ReviewSection
        index={3}
        title={t("projectSetup.steps.currency.label")}
        onEdit={() => onJump(3)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.reportingCurrency")}
          value={`${form.currency} · ${t("projectSetup.review.fxFrom", {
            source: form.fxSource.toUpperCase(),
          })}`}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.timezone")}
          value={form.timezone}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.weekStart")}
          value={t(`projectSetup.currency.weekOptions.${form.weekStart}`)}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.fiscalYear")}
          value={t(`projectSetup.currency.months.${form.fiscalMonth}`)}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.refundPolicy")}
          value={t(`projectSetup.currency.refundOptions.${form.refundPolicy}.name`)}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.autoImport")}
          value={t(
            form.autoImport
              ? "projectSetup.review.autoImport.hourly"
              : "projectSetup.review.autoImport.manual",
          )}
        />
      </ReviewSection>

      <ReviewSection
        index={4}
        title={t("projectSetup.steps.connectors.label")}
        onEdit={() => onJump(4)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.selected")}
          value={
            form.connectors.length
              ? form.connectors.join(", ")
              : t("projectSetup.review.none")
          }
          empty={form.connectors.length === 0}
        />
      </ReviewSection>

      <ReviewSection
        index={5}
        title={t("projectSetup.steps.team.label")}
        onEdit={() => onJump(5)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.membersInvited")}
          value={
            form.members.length
              ? t("projectSetup.review.memberCount", {
                  count: form.members.length,
                })
              : t("projectSetup.review.justYou")
          }
          empty={form.members.length === 0}
        />
        {form.members.map((member) => (
          <ReviewRow
            key={member.email}
            label={`· ${member.email}`}
            value={t(`projectSetup.roles.${member.role}.name`)}
          />
        ))}
      </ReviewSection>

      {!isUpdate ? (
        <div className="mt-5 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-4 py-3.5 text-[12px] text-rv-mute-700">
          <strong className="text-rv-warning">
            {t("projectSetup.review.headsUpLabel")}
          </strong>{" "}
          {t("projectSetup.review.headsUpBefore")}{" "}
          <code className="font-rv-mono text-rv-warning">
            {form.slug || "—"}
          </code>{" "}
          {t("projectSetup.review.headsUpAfter")}
        </div>
      ) : null}
    </>
  );
}
