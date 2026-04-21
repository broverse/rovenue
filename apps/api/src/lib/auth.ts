import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "@rovenue/db";
// Schema table imports come from the Drizzle namespace, not the
// top-level @rovenue/db, so test mocks of "@rovenue/db" don't need
// to stub the entire schema surface. See `drizzle.schema.*`.
import { env } from "./env";

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

// Email + password is enabled only outside production so the dashboard's
// "Continue as Dev User" button can mint a session without an OAuth
// provider. Production deploys stay OAuth-only.
const emailPasswordEnabled = env.NODE_ENV !== "production";

export const auth = betterAuth({
  // Drizzle adapter reads/writes the same user / session / account /
  // verification tables Better Auth's CLI generated for the Prisma
  // schema — the Drizzle mirror mirrors those rows byte-for-byte,
  // so swapping adapters is transparent to existing sessions.
  //
  // `schema` is intentionally omitted here: we use the adapter's
  // default table resolution (it reads table names directly from
  // `drizzle.db`'s attached schema), which keeps the test mock
  // surface minimal — a stub db object is all the test surface
  // needs, no schema-namespace mirroring.
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
});
