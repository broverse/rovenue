import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "@rovenue/db";
import { env } from "./env";
import { logger } from "./logger";
import { maybeEmitNewDevice } from "../services/notifications/new-device-emit";
import { maybeEmitOAuthLink } from "../services/notifications/oauth-link-emit";
import { registrationOpen } from "./host-mode";
import { isRegistrationAllowed } from "./registration-gate";

const log = logger.child("auth");

interface OAuthCreds {
  clientId: string;
  clientSecret: string;
}

interface SocialProviders {
  github?: OAuthCreds;
  google?: OAuthCreds;
}

function buildSocialProviders(): SocialProviders {
  const providers: SocialProviders = {};

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }

  return providers;
}

// Email + password is enabled only outside production so integration tests
// can mint real Better Auth sessions without standing up an OAuth provider.
// Production deploys stay OAuth-only — there is no UI surface for it.
const emailPasswordEnabled = env.NODE_ENV !== "production";

/**
 * OAuth → 2FA browser redirect bridge.
 *
 * Better Auth's `twoFactor` plugin gates every session-creating
 * endpoint with an after-hook: when the user has
 * `twoFactorEnabled`, it deletes the just-issued session, sets a
 * short-lived `two_factor` pending cookie, and overrides the
 * response with `{ twoFactorRedirect: true }` JSON.
 *
 * For client-initiated `authClient.signIn.*` calls the matching
 * `twoFactorClient` plugin watches for that marker and forwards
 * the browser to the verify page. But the OAuth callback is a
 * top-level browser navigation — Google posts to
 * `/api/auth/callback/google`, the response carries the JSON
 * body, and the browser is stranded on the raw payload.
 *
 * This companion plugin runs *after* `twoFactor` in the plugins
 * chain (plugin hooks execute in registration order) and turns
 * the JSON response into a 302 to the dashboard's `/2fa` page.
 * The Set-Cookie headers the `twoFactor` plugin already attached
 * — including the pending 2FA cookie — propagate because they
 * live in better-call's shared `responseHeaders`, which is
 * merged with the redirect on the way out.
 *
 * Documented in https://better-auth.com/docs/plugins/2fa under
 * "If your app needs to require 2FA for those sign-in methods,
 * add custom hook handling…".
 */
const oauthTwoFactorRedirect: BetterAuthPlugin = {
  id: "oauth-2fa-redirect",
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path?.startsWith("/callback/") ?? false,
        handler: createAuthMiddleware(async (ctx) => {
          const data = ctx.context.newSession;
          if (!data?.user.twoFactorEnabled) return;
          if (ctx.context.session) return;
          throw ctx.redirect(`${env.DASHBOARD_URL}/2fa`);
        }),
      },
    ],
  },
};

/**
 * security.signin.new_device producer. After any session-issuing
 * request, fingerprints the UA+IP, upserts user_known_devices,
 * and emits the notification if the device is new. Fire-and-forget
 * — runs in the background so it can't slow the sign-in response.
 */
const newDeviceNotifier: BetterAuthPlugin = {
  id: "new-device-notifier",
  hooks: {
    after: [
      {
        matcher: (ctx) => {
          const p = ctx.path ?? "";
          // Any path that issues a session: email/password sign-in,
          // OAuth callback, magic link callback, 2FA verify.
          return (
            p.startsWith("/callback/") ||
            p.startsWith("/sign-in/") ||
            p.startsWith("/two-factor/verify")
          );
        },
        handler: createAuthMiddleware(async (ctx) => {
          const data = ctx.context.newSession;
          if (!data?.user?.id) return;
          const userAgent =
            ctx.request?.headers.get("user-agent") ?? "unknown";
          const ipAddress =
            ctx.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            ctx.request?.headers.get("x-real-ip") ??
            "0.0.0.0";

          // Don't await — keep the auth response on the fast path.
          // The emit helper has its own try/catch + sentry hook.
          void maybeEmitNewDevice(drizzle.db, {
            userId: data.user.id,
            userAgent,
            ipAddress,
          }).catch((err) => {
            log.warn("new_device_emit_failed", {
              userId: data.user.id,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      },
    ],
  },
};

/**
 * security.oauth.account_linked producer. After any OAuth
 * callback (which is where Better Auth inserts new account
 * rows), check if the user just gained a NEW provider link.
 * Fire-and-forget like the new-device emitter — same fast-path
 * discipline.
 */
const oauthLinkNotifier: BetterAuthPlugin = {
  id: "oauth-link-notifier",
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path?.startsWith("/callback/") ?? false,
        handler: createAuthMiddleware(async (ctx) => {
          const data = ctx.context.newSession;
          if (!data?.user?.id) return;
          void maybeEmitOAuthLink(drizzle.db, {
            userId: data.user.id,
          }).catch((err) => {
            log.warn("oauth_link_emit_failed", {
              userId: data.user.id,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      },
    ],
  },
};

export const auth = betterAuth({
  // `schema` is intentionally omitted: the adapter's default table
  // resolution reads tables directly from `drizzle.db`'s attached
  // schema, which keeps the test mock surface minimal (a stub db
  // object is all the test surface needs).
  database: drizzleAdapter(drizzle.db, { provider: "pg" }),
  emailAndPassword: {
    enabled: emailPasswordEnabled,
    autoSignIn: true,
    minPasswordLength: 8,
  },
  socialProviders: buildSocialProviders(),
  trustedOrigins: [env.DASHBOARD_URL],
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  databaseHooks: {
    user: {
      create: {
        // Gate account creation. Runs for every new user (OAuth callback and
        // dev email/password). Existing users sign in without hitting this.
        before: async (newUser: { email?: string }) => {
          const email = (newUser.email ?? "").toLowerCase();
          const userCount = await drizzle.userRepo.countUsers(drizzle.db);
          const hasPendingInvite = email
            ? Boolean(
                await drizzle.invitationRepo.findAnyPendingInvitationByEmail(
                  drizzle.db,
                  email,
                ),
              )
            : false;

          if (
            !isRegistrationAllowed({
              userCount,
              registrationOpen: registrationOpen(),
              hasPendingInvite,
            })
          ) {
            log.warn("registration_blocked", { email });
            throw new APIError("FORBIDDEN", {
              code: "REGISTRATION_CLOSED",
              message: "registration_closed",
            });
          }
        },
      },
    },
  },
  plugins: [
    // OAuth-only deployment: no credential password exists for
    // most users, so `allowPasswordless: true` skips the password
    // gate on enable/disable/generate-backup-codes when the caller
    // has no credentials account. Dev users that *do* have a
    // password still get gated (the plugin checks per-user).
    twoFactor({
      allowPasswordless: true,
      issuer: "Rovenue",
    }),
    // Must come *after* `twoFactor` so its after-hook runs last
    // — it converts the plugin's JSON response into a 302 for
    // browser-initiated OAuth callbacks.
    oauthTwoFactorRedirect,
    // Same after-hook chain — runs after 2FA / OAuth-redirect so
    // `newSession` is populated for the device-fingerprint check.
    newDeviceNotifier,
    // Detects "an OAuth provider was just linked to an existing
    // user" specifically (first-time signup is excluded — that's
    // already covered by the new-device emitter above).
    oauthLinkNotifier,
  ],
});
