import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// drizzle-kit ignores Node's --env-file flag, so the config loads the
// repo-root `.env` itself when present. Production / CI inject env vars
// directly, and the call is a no-op in that case.
const here = dirname(fileURLToPath(import.meta.url));
const repoRootEnv = resolve(here, "../../.env");
if (existsSync(repoRootEnv)) {
  process.loadEnvFile(repoRootEnv);
}

// =============================================================
// drizzle-kit configuration
// =============================================================
//
// drizzle-kit is the canonical migration driver. The authoritative
// schema is `./src/drizzle/schema.ts`; generated SQL lands under
// `./drizzle/migrations/`. Typical workflow:
//
//   pnpm --filter @rovenue/db drizzle-kit generate   # plan diff → .sql
//   pnpm --filter @rovenue/db db:migrate             # apply to DB
//
// Operators upgrading from a pre-drizzle-kit provision run
// `pnpm db:migrate:baseline` once to mark 0000 as applied without
// re-running its DDL; see src/migrate-baseline.ts.

export default defineConfig({
  schema: "./src/drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  verbose: true,
  strict: true,
});
