import { defineConfig } from "drizzle-kit";

// =============================================================
// drizzle-kit configuration
// =============================================================
//
// Drives introspection (`drizzle-kit pull`) and future migration
// generation (`drizzle-kit generate`). During the Prisma coexistence
// period the authoritative schema lives in prisma/schema.prisma and
// migrations are authored with prisma-migrate — drizzle-kit output
// is DRIFT-DETECTION only (compare schema.ts against the DB and
// surface mismatches in CI).
//
// Once Prisma is removed, flip the `out` path to a real migrations
// directory and adopt drizzle-kit as the migration driver.

export default defineConfig({
  schema: "./src/drizzle/schema.ts",
  out: "./drizzle/out",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  verbose: true,
  strict: true,
});
