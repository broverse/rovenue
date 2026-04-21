import { defineConfig } from "drizzle-kit";

// =============================================================
// drizzle-kit configuration
// =============================================================
//
// Phase 7e3: drizzle-kit is now the canonical migration driver
// for forward schema changes. The existing prisma/migrations/
// folder stays as the historical record that provisions a fresh
// database up to the pre-Drizzle baseline — running `prisma
// migrate deploy` on a brand-new DB brings schema parity with
// schema.ts. Every subsequent migration is authored here:
//
//   pnpm --filter @rovenue/db drizzle-kit generate   # plans diff → .sql
//   pnpm --filter @rovenue/db db:migrate             # applies to DB
//
// `schema.prisma` is frozen. Changes there without a matching
// Drizzle-kit migration will drift; CI should fail that case.

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
