import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  AccountToggleRow,
  AvatarEditor,
  Field,
  FieldRow,
  SectionCard,
} from "../../../components/account";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Select } from "../../../ui/select";
import { Textarea } from "../../../ui/textarea";
import { Segmented } from "../../../ui/segmented";
import { useMe } from "../../../lib/hooks/useMe";

/**
 * Splits a Better Auth display name into ("first", "rest") so the
 * existing two-input UI keeps working. Email-style or single-token
 * names fall back to "" for the last name.
 */
function splitName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const space = trimmed.indexOf(" ");
  if (space === -1) return { firstName: trimmed, lastName: "" };
  return {
    firstName: trimmed.slice(0, space),
    lastName: trimmed.slice(space + 1),
  };
}

export const Route = createFileRoute("/_authed/account/profile")({
  component: ProfilePage,
});

const TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Asia/Tokyo",
  "Asia/Singapore",
] as const;

const LOCALES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "tr-TR", label: "Türkçe" },
  { value: "de-DE", label: "Deutsch" },
  { value: "fr-FR", label: "Français" },
  { value: "ja-JP", label: "日本語" },
] as const;

const DATE_FORMATS = ["ISO (2026-05-08)", "US (5/8/26)", "EU (08/05/26)"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

function ProfilePage() {
  const { t } = useTranslation();
  const { data: me } = useMe();

  // The Better Auth `user` row only carries name / email / image
  // today; the rest of the form (phone, role, company, bio, …)
  // stays on local mock state until the schema grows those columns
  // (tracked in the Phase 2 roadmap).
  const [profile, setProfile] = useState({
    firstName: "",
    lastName: "",
    displayName: "",
    email: "",
    phone: "+1 (415) 555-0188",
    role: "Founder & Head of Growth",
    company: "Lumen Labs, Inc.",
    timezone: "Europe/Istanbul",
    locale: "en-US",
    bio: "Building Lumen — a photo & video app for everyday creators. Previously product at two consumer subscription startups.",
    avatarColor: "#8B5CF6",
  });
  const [dateFormat, setDateFormat] = useState<DateFormat>("ISO (2026-05-08)");
  const update = <K extends keyof typeof profile>(k: K, v: (typeof profile)[K]) =>
    setProfile((p) => ({ ...p, [k]: v }));

  // Hydrate identity fields once the /me response lands. The form
  // remains editable but `email` is treated read-only since it
  // also drives Better Auth + invite-by-email lookups.
  useEffect(() => {
    if (!me) return;
    const split = splitName(me.name);
    setProfile((prev) => ({
      ...prev,
      firstName: split.firstName,
      lastName: split.lastName,
      displayName: prev.displayName || me.name,
      email: me.email,
    }));
  }, [me]);

  const initials = (profile.firstName[0] ?? "") + (profile.lastName[0] ?? "");
  const emailVerified = me?.emailVerified ?? false;

  return (
    <AccountShell active="profile">
      <AccountPageHeader
        title={t("account.profile.title")}
        description={t("account.profile.subtitle")}
      />

      <SectionCard
        title={t("account.profile.photo.title")}
        description={t("account.profile.photo.subtitle")}
      >
        <AvatarEditor
          initials={initials.toUpperCase()}
          color={profile.avatarColor}
          onColorChange={(c) => update("avatarColor", c)}
        />
      </SectionCard>

      <SectionCard
        title={t("account.profile.info.title")}
        description={t("account.profile.info.subtitle")}
        meta={t("account.profile.info.lastEdited", { when: t("account.profile.info.lastEditedRel") })}
        footer={
          <>
            <Button variant="light">{t("common.cancel")}</Button>
            <Button variant="solid-primary">{t("account.profile.info.save")}</Button>
          </>
        }
      >
        <FieldRow>
          <Field label={t("account.profile.info.firstName")}>
            <Input value={profile.firstName} onChange={(e) => update("firstName", e.target.value)} />
          </Field>
          <Field label={t("account.profile.info.lastName")}>
            <Input value={profile.lastName} onChange={(e) => update("lastName", e.target.value)} />
          </Field>
        </FieldRow>
        <Field
          label={t("account.profile.info.displayName")}
          optional={t("account.profile.info.displayNameHint")}
        >
          <Input
            value={profile.displayName}
            onChange={(e) => update("displayName", e.target.value)}
          />
        </Field>
        <Field label={t("account.profile.info.role")}>
          <Input value={profile.role} onChange={(e) => update("role", e.target.value)} />
        </Field>
        <Field label={t("account.profile.info.company")}>
          <Input value={profile.company} onChange={(e) => update("company", e.target.value)} />
        </Field>
        <Field
          label={t("account.profile.info.bio")}
          optional={t("account.profile.info.bioOptional")}
          hint={t("account.profile.info.bioCount", { count: profile.bio.length })}
        >
          <Textarea
            maxLength={280}
            value={profile.bio}
            onChange={(e) => update("bio", e.target.value)}
          />
        </Field>
      </SectionCard>

      <SectionCard
        title={t("account.profile.contact.title")}
        description={t("account.profile.contact.subtitle")}
      >
        <Field
          label={t("account.profile.contact.email")}
          optional={t("account.profile.contact.primary")}
          hint={t("account.profile.contact.emailHint")}
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* Email is owned by Better Auth — read-only here. A
                change-email flow lands separately. */}
            <Input
              mono
              value={profile.email}
              readOnly
              className="min-w-0 flex-1"
            />
            {emailVerified ? (
              <span className="rounded bg-rv-success/15 px-2.5 py-1 font-rv-mono text-[11px] text-rv-success">
                {t("account.profile.contact.verified")}
              </span>
            ) : (
              <span className="rounded bg-rv-warning/15 px-2.5 py-1 font-rv-mono text-[11px] text-rv-warning">
                {t("account.profile.contact.unverified", "Unverified")}
              </span>
            )}
          </div>
        </Field>
        <Field
          label={t("account.profile.contact.phone")}
          optional={t("account.profile.contact.phoneHint")}
        >
          <Input
            mono
            value={profile.phone}
            onChange={(e) => update("phone", e.target.value)}
          />
        </Field>
      </SectionCard>

      <SectionCard
        title={t("account.profile.locale.title")}
        description={t("account.profile.locale.subtitle")}
      >
        <FieldRow>
          <Field label={t("account.profile.locale.language")}>
            <Select
              value={profile.locale}
              onChange={(e) => update("locale", e.target.value)}
            >
              {LOCALES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("account.profile.locale.timezone")}>
            <Select
              value={profile.timezone}
              onChange={(e) => update("timezone", e.target.value)}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
        </FieldRow>
        <Field label={t("account.profile.locale.dateFormat")}>
          <Segmented
            options={DATE_FORMATS}
            value={dateFormat}
            onChange={setDateFormat}
            ariaLabel={t("account.profile.locale.dateFormat")}
          />
        </Field>
      </SectionCard>

      <SectionCard title={t("account.profile.activity.title")}>
        <AccountToggleRow
          title={t("account.profile.activity.profileVisible")}
          description={t("account.profile.activity.profileVisibleDesc")}
          checked
          onChange={() => undefined}
        />
        <AccountToggleRow
          title={t("account.profile.activity.statusVisible")}
          description={t("account.profile.activity.statusVisibleDesc")}
          checked={false}
          onChange={() => undefined}
        />
      </SectionCard>
    </AccountShell>
  );
}
