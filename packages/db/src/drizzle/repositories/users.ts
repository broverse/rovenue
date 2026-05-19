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
  createdAt: Date;
  updatedAt: Date;
}

export async function findUserById(
  db: Db,
  id: string,
): Promise<UserProfile | null> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  return rows[0] ?? null;
}
