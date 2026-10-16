import type { FastifyInstance, FastifyReply } from "fastify";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { households, invites, users } from "../db/schema.js";
import { DUMMY_HASH, hashPassword, normalizeInviteCode, sha256, verifyPassword } from "../auth/crypto.js";
import { createSession, destroySession, requireAuth } from "../auth/session.js";
import { ensureDefaultCategories } from "../finance/defaults.js";

const email = z.string().trim().toLowerCase().pipe(z.email("Email tidak valid")).pipe(z.string().max(200));
const password = z.string().min(8, "Password minimal 8 karakter").max(200);
const name = z.string().trim().min(1, "Nama wajib diisi").max(80);

const SetupBody = z.object({ householdName: z.string().trim().min(1).max(80), name, email, password });
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });
const JoinBody = z.object({ code: z.string().min(4).max(20), name, email, password });

// Batas percobaan untuk endpoint sensitif (per IP).
const authLimit = { rateLimit: { max: 10, timeWindow: "15 minutes" } };

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "Input tidak valid", fields: z.flattenError(error).fieldErrors });
}

const userCount = () => db.select({ n: count() }).from(users).get()!.n;

export async function authRoutes(app: FastifyInstance) {
  // Dipakai UI untuk memilih: tampilkan form "buat rumah tangga" atau form login.
  app.get("/api/auth/status", async () => ({ needsSetup: userCount() === 0 }));

  // Setup awal: hanya boleh selama belum ada user sama sekali.
  // Anggota berikutnya masuk lewat kode undangan, bukan pendaftaran bebas.
  app.post("/api/auth/setup", { config: authLimit }, async (req, reply) => {
    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const b = parsed.data;
    const passwordHash = await hashPassword(b.password);

    const created = db.transaction((tx) => {
      if (tx.select({ n: count() }).from(users).get()!.n > 0) return null;
      const hh = tx.insert(households).values({ name: b.householdName }).returning({ id: households.id }).get();
      const u = tx
        .insert(users)
        .values({ householdId: hh.id, email: b.email, name: b.name, passwordHash, role: "owner" })
        .returning({ id: users.id })
        .get();
      return { userId: u.id, householdId: hh.id };
    });
    if (!created) return reply.code(403).send({ error: "Setup sudah dilakukan. Gunakan kode undangan." });
    ensureDefaultCategories(created.householdId);
    const userId = created.userId;

    await createSession(reply, userId);
    return reply.code(201).send({ ok: true });
  });

  app.post("/api/auth/login", { config: authLimit }, async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const user = db.select().from(users).where(eq(users.email, parsed.data.email)).get();
    // Selalu jalankan verifikasi (pakai hash dummy bila user tidak ada) agar waktu respons seragam.
    const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) return reply.code(401).send({ error: "Email atau password salah" });
    await createSession(reply, user.id);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    destroySession(req, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    const u = req.user!;
    const hh = db.select().from(households).where(eq(households.id, u.householdId)).get()!;
    return {
      user: { id: u.id, name: u.name, email: u.email, role: u.role },
      household: { id: hh.id, name: hh.name, currency: hh.currency, timezone: hh.timezone },
    };
  });

  // Gabung ke household memakai kode undangan dari owner.
  app.post("/api/auth/join", { config: authLimit }, async (req, reply) => {
    const parsed = JoinBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const b = parsed.data;
    const passwordHash = await hashPassword(b.password);
    const codeHash = sha256(normalizeInviteCode(b.code));

    const result = db.transaction((tx) => {
      const inv = tx
        .select()
        .from(invites)
        .where(and(eq(invites.codeHash, codeHash), isNull(invites.usedAt), gt(invites.expiresAt, new Date())))
        .get();
      if (!inv) return { error: "invalid" as const };
      if (tx.select({ id: users.id }).from(users).where(eq(users.email, b.email)).get()) {
        return { error: "email" as const };
      }
      const u = tx
        .insert(users)
        .values({ householdId: inv.householdId, email: b.email, name: b.name, passwordHash, role: inv.role })
        .returning({ id: users.id })
        .get();
      tx.update(invites).set({ usedAt: new Date(), usedBy: u.id }).where(eq(invites.id, inv.id)).run();
      return { userId: u.id };
    });

    if ("error" in result) {
      return result.error === "email"
        ? reply.code(409).send({ error: "Email sudah terdaftar" })
        : reply.code(400).send({ error: "Kode undangan tidak valid atau sudah kedaluwarsa" });
    }
    await createSession(reply, result.userId);
    return reply.code(201).send({ ok: true });
  });
}
