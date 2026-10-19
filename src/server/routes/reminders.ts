import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { households, reminders } from "../db/schema.js";
import { requireAuth } from "../auth/session.js";
import { isValidDate, todayIn } from "../finance/dates.js";
import { toView, type ReminderView } from "../reminders/logic.js";

const idParam = z.object({ id: z.string().min(1).max(64) });
const optText = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

// Batas 5 tahun ke depan agar typo tahun (mis. 2262) langsung tertolak.
const maxDate = (today: string) => {
  const [y] = today.split("-").map(Number);
  return `${y + 5}-12-31`;
};

const ReminderBody = (today: string) =>
  z.object({
    title: z.string().trim().min(1, "Judul wajib diisi").max(80),
    amount: z
      .number()
      .int("Nominal harus bilangan bulat")
      .positive("Nominal harus > 0")
      .max(1_000_000_000_000)
      .nullish()
      .transform((v) => v ?? null),
    dueDate: z
      .string()
      .refine(isValidDate, "Tanggal harus YYYY-MM-DD")
      .refine((d) => d <= maxDate(today), "Tanggal terlalu jauh di masa depan (maks 5 tahun)"),
    // Tanpa default di sini: PATCH partial tidak boleh menyuntik "none"
    // ketika field repeat tidak dikirim. Default diterapkan saat insert.
    repeat: z.enum(["none", "monthly", "yearly"]).optional(),
    note: optText(500),
  });

const ReminderPatch = (today: string) =>
  ReminderBody(today).partial().extend({ status: z.enum(["active", "done"]).optional() });

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "Input tidak valid", fields: z.flattenError(error).fieldErrors });
}

export async function reminderRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Tanggal "hari ini" mengikuti zona waktu rumah tangga (default Asia/Jakarta).
  const tzToday = (householdId: string) => {
    const hh = db.select({ tz: households.timezone }).from(households).where(eq(households.id, householdId)).get();
    return todayIn(hh?.tz ?? "Asia/Jakarta");
  };

  // Daftar pengingat rumah tangga (aktif + selesai), terurut jatuh tempo.
  app.get("/api/reminders", async (req) => {
    const hid = req.user!.householdId;
    const today = tzToday(hid);
    const rows = db
      .select()
      .from(reminders)
      .where(eq(reminders.householdId, hid))
      .all();
    // Urutkan berdasarkan jatuh tempo siklus berjalan (view), bukan kolom
    // mentah — pengingat berulang yang selesai menunjukkan siklus berikutnya.
    const items: ReminderView[] = rows
      .map((r) => toView(r, today))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
    return { items, today };
  });

  app.post("/api/reminders", async (req, reply) => {
    const hid = req.user!.householdId;
    const today = tzToday(hid);
    const parsed = ReminderBody(today).safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const row = db
      .insert(reminders)
      .values({ householdId: hid, createdBy: req.user!.id, ...parsed.data, repeat: parsed.data.repeat ?? "none" })
      .returning()
      .get();
    return reply.code(201).send({ reminder: toView(row, today) });
  });

  app.patch("/api/reminders/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const hid = req.user!.householdId;
    const today = tzToday(hid);
    const parsed = ReminderPatch(today).safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);

    const existing = db
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, id), eq(reminders.householdId, hid)))
      .get();
    if (!existing) return reply.code(404).send({ error: "Pengingat tidak ditemukan" });

    const patch: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.status === "done" && existing.status !== "done") {
      // Siklus yang diselesaikan = jatuh tempo berjalan saat ini; pengingat
      // berulang lanjut ke siklus berikutnya, sekali jadi selesai permanen.
      patch.status = "done";
      patch.completedAt = new Date();
      patch.completedDueDate = toView(existing, today).dueDate;
    } else if (parsed.data.status === "active" && existing.status === "done") {
      patch.status = "active";
      patch.completedAt = null;
      // completedDueDate sengaja dipertahankan sebagai basis siklus berulang:
      // buka kembali berarti aktif pada siklus berikutnya, bukan mengulang
      // siklus yang sudah diselesaikan. Kolom ini juga jadi penanda "pernah
      // selesai siklus X" untuk pengingat sekali.
    } else if (parsed.data.status !== undefined) {
      delete patch.status;
    }

    const row = db
      .update(reminders)
      .set(patch)
      .where(and(eq(reminders.id, id), eq(reminders.householdId, hid)))
      .returning()
      .get();
    return { reminder: toView(row, today) };
  });

  app.delete("/api/reminders/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = db
      .delete(reminders)
      .where(and(eq(reminders.id, id), eq(reminders.householdId, req.user!.householdId)))
      .returning()
      .get();
    if (!row) return reply.code(404).send({ error: "Pengingat tidak ditemukan" });
    return reply.code(204).send();
  });
}
