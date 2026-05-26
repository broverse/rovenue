import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

const baseURL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const authClient = createAuthClient({
  baseURL,
  plugins: [
    // After an OAuth sign-in for a user with 2FA enabled Better
    // Auth replies with `twoFactorRedirect: true` instead of
    // setting a session cookie; this plugin watches for that
    // marker on every response and forwards the browser to the
    // verify page so the user can finish signing in.
    twoFactorClient({ twoFactorPage: "/2fa" }),
  ],
});

export const { useSession, signIn, signOut, getSession } = authClient;
