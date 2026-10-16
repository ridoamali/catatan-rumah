import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, users, type User } from "../db/schema.js";
import { env, isProd } from "../env.js";
import { newToken, sha256 } from "./crypto.js";

export const SESSION_COOKIE = "cr_session";
const TTL_MS = env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export type SessionUser = Pick<User, "id" | "householdId" | "email" | "name" | "role">;

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

function setCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    expires,
  });
}

export async function createSession(reply: FastifyReply, userId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + TTL_MS);
  db.insert(sessions).values({ id: sha256(token), userId, expiresAt }).run();
  setCookie(reply, token, expiresAt);
}

export function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) db.delete(sessions).where(eq(sessions.id, sha256(token))).run();
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

// Dipanggil di setiap request: mengisi req.user jika cookie sesi valid.
// Sesi diperpanjang otomatis (sliding) kalau sisa umurnya < 50%.
export async function loadSession(req: FastifyRequest, reply: FastifyReply) {
  req.user = null;
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const sid = sha256(token);
  const row = db
    .select({
      expiresAt: sessions.expiresAt,
      id: users.id, householdId: users.householdId, email: users.email, name: users.name, role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date())))
    .get();
  if (!row) {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return;
  }
  const { expiresAt, ...user } = row;
  req.user = user;
  if (expiresAt.getTime() - Date.now() < TTL_MS / 2) {
    const next = new Date(Date.now() + TTL_MS);
    db.update(sessions).set({ expiresAt: next }).where(eq(sessions.id, sid)).run();
    setCookie(reply, token, next);
  }
}

export function purgeExpiredSessions() {
  db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run();
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "Belum login" });
}

export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "Belum login" });
  if (req.user.role !== "owner") return reply.code(403).send({ error: "Hanya owner" });
}
