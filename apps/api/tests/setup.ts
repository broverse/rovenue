// Seed env vars so lib/auth.ts and lib/env.ts can be imported under test
// without real OAuth credentials or a live database.
process.env.NODE_ENV ??= "test";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-not-for-prod-xxxxx";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.DASHBOARD_URL ??= "http://localhost:5173";
process.env.GITHUB_CLIENT_ID ??= "test-github-id";
process.env.GITHUB_CLIENT_SECRET ??= "test-github-secret";
process.env.GOOGLE_CLIENT_ID ??= "test-google-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-google-secret";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/rovenue_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
