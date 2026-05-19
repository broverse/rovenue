import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { user } from "../schema";

// =============================================================
// User reads — Drizzle repository
// =============================================================
//
// Better Auth owns the write side of `user`; this module only
// provides the lookups our own dashboard needs (invites by email).

export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{
  id: string;
  email: string;
  name: string;
  image: string | null;
} | null> {
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
    })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  return rows[0] ?? null;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  locale: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

const USER_PROFILE_COLUMNS = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  image: user.image,
  locale: user.locale,
  timezone: user.timezone,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
} as const;

export async function findUserById(
  db: Db,
  id: string,
): Promise<UserProfile | null> {
  const rows = await db
    .select(USER_PROFILE_COLUMNS)
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpdateUserProfileInput {
  name?: string;
  image?: string | null;
  locale?: string;
  timezone?: string;
}

export async function updateUserProfile(
  db: Db,
  id: string,
  input: UpdateUserProfileInput,
): Promise<UserProfile | null> {
  // No-op the call if nothing meaningful was supplied — avoids
  // bumping `updatedAt` for empty PATCH bodies.
  const hasUpdate =
    input.name !== undefined ||
    input.image !== undefined ||
    input.locale !== undefined ||
    input.timezone !== undefined;
  if (!hasUpdate) {
    return findUserById(db, id);
  }

  const rows = await db
    .update(user)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.image !== undefined && { image: input.image }),
      ...(input.locale !== undefined && { locale: input.locale }),
      ...(input.timezone !== undefined && { timezone: input.timezone }),
      updatedAt: new Date(),
    })
    .where(eq(user.id, id))
    .returning(USER_PROFILE_COLUMNS);
  return rows[0] ?? null;
}
