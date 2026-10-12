import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { Role } from "@/domain/constants";
import { env } from "@/env";

export const SESSION_COOKIE = "di_session";
const SESSION_HOURS = 12;

export type SessionUser = { id: string; email: string; name: string; role: Role };

const key = () => new TextEncoder().encode(env().SESSION_SECRET);

export async function createSession(userId: string): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key());
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Verifies the cookie and re-reads the user so deactivation and role changes apply immediately. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    const [user] = await db().select().from(users).where(eq(users.id, payload.sub)).limit(1);
    if (!user || !user.active) return null;
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  } catch {
    return null;
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

export function hasRole(user: SessionUser, min: Role): boolean {
  return RANK[user.role] >= RANK[min];
}

export class ForbiddenError extends Error {
  constructor(needed: Role) {
    super(`This action requires the ${needed} role.`);
  }
}

/** Authorisation gate for server actions and route handlers. */
export async function requireRole(min: Role): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasRole(user, min)) throw new ForbiddenError(min);
  return user;
}
