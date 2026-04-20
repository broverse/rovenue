import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
export * from "@prisma/client";
export * from "./helpers/encrypted-field";

// =============================================================
// Drizzle (side-by-side with Prisma during migration)
// =============================================================
//
// Drizzle is exposed under a namespace so its type names (Project,
// Subscriber, AuditLogRow …) don't collide with Prisma's. Consumers
// opt in explicitly:
//   import { drizzle } from "@rovenue/db";
//   const rows = await drizzle.db.select().from(drizzle.projects);
// The top-level `@rovenue/db` keeps returning Prisma so no existing
// caller is forced to change.
//
// See docs/superpowers/specs/2026-04-20-tech-stack-upgrade/
// 01-drizzle-migration.md for the phased cutover plan.

export * as drizzle from "./drizzle";
