import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { invites, users } from "../db/schema.js";
import { newInviteCode, normalizeInviteCode, sha256 } from "../auth/crypto.js";
import { requireAuth, requireOwner } from "../auth/session.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const InviteBody = z.object({ role: z.enum(["owner", "member"]).default("member") }).default({ role: "member" });

export async function householdRoutes(app: FastifyInstance) {
  app.get("/api/household/members", { preHandler: requireAuth }, async (req) => {
    const rows = db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.householdId, req.user!.householdId))
      .orderBy(asc(users.createdAt))
      .all();
    return { members: rows };
  });

  // Owner membuat kode undangan. Kode mentah hanya dikembalikan SEKALI di respons ini.
  app.post("/api/household/invites", { preHandler: requireOwner }, async (req, reply) => {
    const parsed = InviteBody.safeParse(req.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid" });
    const code = newInviteCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    db.insert(invites)
      .values({
        householdId: req.user!.householdId,
        codeHash: sha256(normalizeInviteCode(code)),
        role: parsed.data.role,
        createdBy: req.user!.id,
        expiresAt,
      })
      .run();
    return reply.code(201).send({ code, role: parsed.data.role, expiresAt });
  });
}
