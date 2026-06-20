/**
 * Outbound links used across the landing page.
 *
 * Login/CTA buttons delegate to the dashboard's existing Better Auth login
 * page (apps/dashboard `/login`), which handles Google + GitHub OAuth. Set the
 * dashboard origin via the PUBLIC_DASHBOARD_URL env var at build time; the
 * fallback is the local dev dashboard port.
 */
const DASHBOARD_URL = import.meta.env.PUBLIC_DASHBOARD_URL ?? 'http://localhost:5173';

export const siteLinks = {
  github: 'https://github.com/rovenue/rovenue',
  signIn: `${DASHBOARD_URL}/login`,
  getStarted: `${DASHBOARD_URL}/login`,
  docs: 'https://docs.rovenue.app',
} as const;

export const githubStars = '8.4k';
