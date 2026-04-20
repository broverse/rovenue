import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "@rovenue/db";
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
  database: prismaAdapter(prisma, { provider: "postgresql" }),
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
