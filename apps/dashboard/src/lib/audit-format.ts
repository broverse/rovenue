import type { AuditLogEntry } from "@rovenue/shared";

// Maps raw (action, resource) pairs emitted by the API audit
// pipeline (apps/api/src/.../audit(...)) into one human sentence
// for the dashboard. Unknown actions fall through to a generic
// humanizer so newly added events still render readably.

type AuditPayload = Record<string, unknown> | null | undefined;

interface FormatInput {
  action: string;
  resource: string;
  before?: unknown;
  after?: unknown;
}

const RESOURCE_LABEL: Record<string, string> = {
  audience: "audience",
  feature_flag: "flag",
  experiment: "experiment",
  credential: "credentials",
  project: "project",
  member: "member",
  subscriber: "subscriber",
  purchase: "subscription",
};

const STORE_LABEL: Record<string, string> = {
  app_store: "App Store",
  play_store: "Play Store",
  stripe: "Stripe",
  webhookSecret: "webhook secret",
};

function asRecord(v: unknown): AuditPayload {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(rec: AuditPayload, key: string): string | null {
  const v = rec?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function bool(rec: AuditPayload, key: string): boolean | null {
  const v = rec?.[key];
  return typeof v === "boolean" ? v : null;
}

function resourceLabel(resource: string): string {
  return RESOURCE_LABEL[resource] ?? resource.replace(/_/g, " ");
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fallback(action: string, resource: string): string {
  // "credential.updated" → "Credential updated"
  // "create" + resource → "Create feature flag"
  const fromDot = action.includes(".")
    ? action.split(".").join(" ").replace(/_/g, " ")
    : `${action} ${resourceLabel(resource)}`.replace(/_/g, " ");
  return titleCase(fromDot);
}

export function formatAuditEvent({
  action,
  resource,
  before,
  after,
}: FormatInput): string {
  const a = asRecord(after);
  const b = asRecord(before);
  const key = `${resource}:${action}`;

  switch (key) {
    // -- audience --
    case "audience:create": {
      const name = str(a, "name");
      return name ? `Created audience "${name}"` : "Created audience";
    }
    case "audience:update": {
      const name = str(a, "name") ?? str(b, "name");
      return name ? `Updated audience "${name}"` : "Updated audience";
    }
    case "audience:delete": {
      const name = str(b, "name");
      return name ? `Deleted audience "${name}"` : "Deleted audience";
    }

    // -- feature_flag --
    case "feature_flag:create": {
      const flagKey = str(a, "key");
      return flagKey ? `Created flag "${flagKey}"` : "Created flag";
    }
    case "feature_flag:update": {
      const flagKey = str(a, "key") ?? str(b, "key");
      return flagKey ? `Updated flag "${flagKey}"` : "Updated flag";
    }
    case "feature_flag:toggle": {
      const beforeOn = bool(b, "isEnabled");
      const afterOn = bool(a, "isEnabled");
      const transition =
        beforeOn !== null && afterOn !== null
          ? ` (${beforeOn ? "on" : "off"} → ${afterOn ? "on" : "off"})`
          : "";
      return `Toggled flag${transition}`;
    }
    case "feature_flag:delete": {
      const flagKey = str(b, "key");
      return flagKey ? `Deleted flag "${flagKey}"` : "Deleted flag";
    }

    // -- experiment --
    case "experiment:create": {
      const expKey = str(a, "key");
      return expKey ? `Created experiment "${expKey}"` : "Created experiment";
    }
    case "experiment:update":
      return "Updated experiment";
    case "experiment:delete": {
      const expKey = str(b, "key") ?? str(b, "name");
      return expKey ? `Deleted experiment "${expKey}"` : "Deleted experiment";
    }
    case "experiment:pause":
      return "Paused experiment";
    case "experiment:resume":
      return "Resumed experiment";
    case "experiment:duplicate": {
      const nextKey = str(a, "key");
      return nextKey
        ? `Duplicated experiment to "${nextKey}"`
        : "Duplicated experiment";
    }
    case "experiment:experiment.started":
      return "Started experiment";
    case "experiment:experiment.stopped":
      return "Stopped experiment";

    // -- credential --
    case "credential:credential.updated": {
      const payload = a ?? b;
      const first = payload ? Object.keys(payload)[0] : null;
      const store = first ? STORE_LABEL[first] ?? first : null;
      return store ? `Updated ${store} credentials` : "Updated credentials";
    }
    case "credential:credential.cleared": {
      const first = b ? Object.keys(b)[0] : null;
      const store = first ? STORE_LABEL[first] ?? first : null;
      return store ? `Cleared ${store} credentials` : "Cleared credentials";
    }

    // -- project --
    case "project:project.updated":
      return "Updated project settings";
    case "project:project.deleted":
      return "Deleted project";
    case "project:subscriptions.exported":
      return "Exported subscriptions (GDPR)";

    // -- member --
    case "member:member.invited": {
      const email = str(a, "email");
      const role = str(a, "role");
      if (email && role) return `Invited ${email} as ${role}`;
      if (email) return `Invited ${email}`;
      return "Invited member";
    }
    case "member:member.role_changed": {
      const beforeRole = str(b, "role");
      const afterRole = str(a, "role");
      if (beforeRole && afterRole)
        return `Changed member role from ${beforeRole} to ${afterRole}`;
      return "Changed member role";
    }
    case "member:member.removed": {
      const self = bool(a, "self");
      return self ? "Left project" : "Removed member";
    }

    // -- subscriber --
    case "subscriber:update":
      return "Updated subscriber";
    case "subscriber:subscriber.credits_added":
      return "Granted credits to subscriber";
    case "subscriber:subscriber.anonymized":
      return "Anonymized subscriber (GDPR)";
    case "subscriber:subscriber.exported":
      return "Exported subscriber data (GDPR)";

    // -- purchase (subscription lifecycle) --
    case "purchase:subscription.granted":
      return "Granted subscription";
    case "purchase:subscription.cancel_scheduled":
      return "Scheduled subscription cancellation";
    case "purchase:subscription.schedule_canceled":
      return "Canceled scheduled cancellation";
    case "purchase:subscription.cancel_executed":
      return "Executed scheduled cancellation";

    default:
      return fallback(action, resource);
  }
}

export function formatAuditEntry(entry: AuditLogEntry): string {
  return formatAuditEvent({
    action: entry.action,
    resource: entry.resource,
    before: entry.before,
    after: entry.after,
  });
}
