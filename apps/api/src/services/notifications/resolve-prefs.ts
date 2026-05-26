import { getEvent, type NotificationChannel } from "@rovenue/shared/notifications";

// =============================================================
// resolvePrefs — cascade evaluator (pure function)
// =============================================================
//
// Resolves whether a (user, project, event) tuple should fan out
// and on which channels. Cascade:
//
//   enabled = userOverride ?? projectDefault ?? event.defaultEnabled
//
// then channels = event.defaultChannels filtered by:
//   - forced channels always included (overrides enabled=false and
//     userChannels=false),
//   - inapp tracks `enabled`,
//   - email tracks `enabled` && userChannels.email,
//   - push tracks `enabled` && userChannels.push && event.pushAllowed.
//
// Caller pre-fetches userChannels/projectDefaults/userOverrides
// from Postgres (Phase 1 schema). This module stays pure to keep
// the 9+ scenarios in resolve-prefs.test.ts cheap and deterministic.

export interface ResolvePrefsInput {
  userChannels: { email: boolean; push: boolean };
  projectDefaults: Record<string, boolean>;
  userOverrides: Record<string, boolean>;
  eventKey: string;
}

export interface ResolvePrefsResult {
  enabled: boolean;
  enabledChannels: NotificationChannel[];
}

export async function resolvePrefs(
  input: ResolvePrefsInput,
): Promise<ResolvePrefsResult> {
  const event = getEvent(input.eventKey);

  const userOverride = input.userOverrides[event.key];
  const projectDefault = input.projectDefaults[event.key];
  const enabled =
    userOverride ?? projectDefault ?? event.defaultEnabled;

  const forced = new Set<NotificationChannel>(event.forcedChannels);

  const channels: NotificationChannel[] = [];
  for (const ch of event.defaultChannels) {
    if (forced.has(ch)) {
      channels.push(ch);
      continue;
    }
    if (!enabled) continue;
    if (ch === "inapp") {
      channels.push(ch);
      continue;
    }
    if (ch === "email" && input.userChannels.email) channels.push(ch);
    if (ch === "push" && input.userChannels.push && event.pushAllowed) {
      channels.push(ch);
    }
  }

  return {
    enabled: enabled || forced.size > 0,
    enabledChannels: channels,
  };
}
