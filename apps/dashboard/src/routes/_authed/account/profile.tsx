import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
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
import { useMe, useUpdateMe } from "../../../lib/hooks/useMe";
import {
  useMyPreferences,
  useUpdatePreferences,
} from "../../../lib/hooks/useMyPreferences";

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
const DEFAULT_DATE_FORMAT: DateFormat = "ISO (2026-05-08)";
const DEFAULT_AVATAR_COLOR = "#8B5CF6";

function isDateFormat(value: unknown): value is DateFormat {
  return (
    typeof value === "string" &&
    (DATE_FORMATS as readonly string[]).includes(value)
  );
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function ProfilePage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const { data: preferences } = useMyPreferences();
  const updateMe = useUpdateMe();
  const updatePrefs = useUpdatePreferences();

  // The Better Auth `user` row carries name / email / image /
  // locale / timezone; everything else (displayName, phone, role,
  // company, bio, avatarColor) lives on `user_preferences.profile`
  // and dateFormat lives on `user_preferences.appearance` —
  // hydrated below from the /me/preferences response.
  const [profile, setProfile] = useState({
    firstName: "",
    lastName: "",
    displayName: "",
    email: "",
    role: "",
    company: "",
    timezone: "UTC",
    locale: "en-US",
    bio: "",
    avatarColor: DEFAULT_AVATAR_COLOR,
  });
  const [dateFormat, setDateFormat] = useState<DateFormat>(DEFAULT_DATE_FORMAT);
  const update = <K extends keyof typeof profile>(k: K, v: (typeof profile)[K]) =>
    setProfile((p) => ({ ...p, [k]: v }));

  // Hydrate identity fields once the /me response lands. Email
  // stays read-only since it also drives Better Auth + invite-by-
  // email lookups.
  useEffect(() => {
    if (!me) return;
    const split = splitName(me.name);
    setProfile((prev) => ({
      ...prev,
      firstName: split.firstName,
      lastName: split.lastName,
      displayName: prev.displayName || me.name,
      email: me.email,
      locale: me.locale,
      timezone: me.timezone,
    }));
  }, [me]);

  // Hydrate the preference-backed fields. Each value is defensive
  // (string fallback) so a malformed blob can't soft-brick the
  // page.
  useEffect(() => {
    if (!preferences) return;
    const p = preferences.profile as Record<string, unknown>;
    setProfile((prev) => ({
      ...prev,
      displayName: pickString(p.displayName, prev.displayName),
      role: pickString(p.role, prev.role),
      company: pickString(p.company, prev.company),
      bio: pickString(p.bio, prev.bio),
      avatarColor: pickString(p.avatarColor, prev.avatarColor),
    }));
    const a = preferences.appearance as Record<string, unknown>;
    if (isDateFormat(a.dateFormat)) setDateFormat(a.dateFormat);
  }, [preferences]);

  const initials = useMemo(
    () =>
      ((profile.firstName[0] ?? "") + (profile.lastName[0] ?? "")).toUpperCase(),
    [profile.firstName, profile.lastName],
  );
  const emailVerified = me?.emailVerified ?? false;
  const saving = updateMe.isPending || updatePrefs.isPending;

  const handleSave = () => {
    // Better Auth's `name` is rebuilt from the two name inputs,
    // collapsing blanks. Identity fields ride /me; the rest go
    // through /me/preferences (profile + appearance blobs).
    const name = [profile.firstName, profile.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    updateMe.mutate({
      ...(name && { name }),
      locale: profile.locale,
      timezone: profile.timezone,
    });
    updatePrefs.mutate({
      profile: {
        displayName: profile.displayName,
        role: profile.role,
        company: profile.company,
        bio: profile.bio,
        avatarColor: profile.avatarColor,
      },
      appearance: { dateFormat },
    });
  };

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
          initials={initials}
          color={profile.avatarColor}
          onColorChange={(c) => update("avatarColor", c)}
        />
      </SectionCard>

      <SectionCard
        title={t("account.profile.info.title")}
        description={t("account.profile.info.subtitle")}
        footer={
          <>
            <Button variant="light" disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="solid-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving
                ? t("common.saving", "Saving…")
                : t("account.profile.info.save")}
            </Button>
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
    </AccountShell>
  );
}
