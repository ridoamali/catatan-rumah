import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, desc, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { budgets, categories, KINDS, transactionItems, transactions, users } from "../db/schema.js";
import { requireAuth, requireOwner } from "../auth/session.js";
import { ensureDefaultCategories, findCategory } from "../finance/defaults.js";
import { isValidDate, isValidMonth, monthRange, prevMonth } from "../finance/dates.js";

const idParam = z.object({ id: z.string().min(1).max(64) });
const optText = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const CategoryBody = z.object({ name: z.string().trim().min(1).max(40), kind: z.enum(KINDS) });
const CategoryPatch = z.object({ name: z.string().trim().min(1).max(40).optional(), archived: z.boolean().optional() });

const TxBody = z.object({
  kind: z.enum(KINDS),
  amount: z.number().int("Nominal harus bilangan bulat").positive("Nominal harus > 0").max(1_000_000_000_000),
  occurredOn: z.string().refine(isValidDate, "Tanggal harus YYYY-MM-DD"),
  categoryId: z.string().min(1).max(64).nullish().transform((v) => v ?? null),
  merchant: optText(120),
  note: optText(500),
});
const TxPatch = TxBody.partial();

const TxQuery = z.object({
  month: z.string().refine(isValidMonth, "Format bulan YYYY-MM").optional(),
  from: z.string().refine(isValidDate).optional(),
  to: z.string().refine(isValidDate).optional(),
  categoryId: z.string().max(64).optional(),
  kind: z.enum(KINDS).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const MonthQuery = z.object({ month: z.string().refine(isValidMonth, "Format bulan YYYY-MM") });
const BudgetBody = z.object({ monthlyAmount: z.number().int().min(0).max(1_000_000_000_000) });

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "Input tidak valid", fields: z.flattenError(error).fieldErrors });
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Error && "code" in e && String((e as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT_UNIQUE");

// Kategori harus milik household yang sama, belum diarsipkan, dan jenisnya cocok.
function checkCategory(householdId: string, categoryId: string | null, kind: (typeof KINDS)[number]) {
  if (!categoryId) return null;
  const cat = findCategory(householdId, categoryId);
  if (!cat) return "Kategori tidak ditemukan";
  if (cat.archived) return "Kategori sudah diarsipkan";
  if (cat.kind !== kind) return "Jenis kategori tidak cocok dengan jenis transaksi";
  return null;
}

const sumAmount = sql<number>`coalesce(sum(${transactions.amount}), 0)`.mapWith(Number);

export async function financeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ---------------- Kategori ----------------
  app.get("/api/categories", async (req) => {
    const hid = req.user!.householdId;
    ensureDefaultCategories(hid);
    const rows = db
      .select({ id: categories.id, name: categories.name, kind: categories.kind, archived: categories.archived })
      .from(categories)
      .where(eq(categories.householdId, hid))
      .orderBy(asc(categories.kind), asc(categories.name))
      .all();
    return { categories: rows };
  });

  app.post("/api/categories", async (req, reply) => {
    const parsed = CategoryBody.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const row = db
        .insert(categories)
        .values({ householdId: req.user!.householdId, ...parsed.data })
        .returning()
        .get();
      return reply.code(201).send({ category: row });
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: "Nama kategori sudah ada" });
      throw e;
    }
  });

  app.patch("/api/categories/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = CategoryPatch.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    if (!findCategory(req.user!.householdId, id)) return reply.code(404).send({ error: "Kategori tidak ditemukan" });
    try {
      const row = db
        .update(categories)
        .set(parsed.data)
        .where(and(eq(categories.id, id), eq(categories.householdId, req.user!.householdId)))
        .returning()
        .get();
      return { category: row };
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: "Nama kategori sudah ada" });
      throw e;
    }
  });

  // ---------------- Transaksi ----------------
  app.get("/api/transactions", async (req, reply) => {
    const parsed = TxQuery.safeParse(req.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    const f = parsed.data;
    const hid = req.user!.householdId;

    const where: SQL[] = [eq(transactions.householdId, hid), isNull(transactions.deletedAt)];
    if (f.month) {
      const r = monthRange(f.month);
      where.push(gte(transactions.occurredOn, r.from), lt(transactions.occurredOn, r.to));
    }
    if (f.from) where.push(gte(transactions.occurredOn, f.from));
    if (f.to) where.push(lt(transactions.occurredOn, f.to));
    if (f.kind) where.push(eq(transactions.kind, f.kind));
    if (f.categoryId === "none") where.push(isNull(transactions.categoryId));
    else if (f.categoryId) where.push(eq(transactions.categoryId, f.categoryId));
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        sql`(${transactions.merchant} LIKE ${like} ESCAPE '\\' OR ${transactions.note} LIKE ${like} ESCAPE '\\')`,
      );
    }
    const cond = and(...where);

    const items = db
      .select({
        id: transactions.id,
        kind: transactions.kind,
        amount: transactions.amount,
        occurredOn: transactions.occurredOn,
        merchant: transactions.merchant,
        note: transactions.note,
        source: transactions.source,
        receiptStatus: transactions.receiptStatus,
        categoryId: transactions.categoryId,
        categoryName: categories.name,
        userId: transactions.userId,
        userName: users.name,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(users, eq(users.id, transactions.userId))
      .where(cond)
      .orderBy(desc(transactions.occurredOn), desc(transactions.createdAt))
      .limit(f.limit)
      .all();

    const totals = db
      .select({ kind: transactions.kind, total: sumAmount, n: sql<number>`count(*)`.mapWith(Number) })
      .from(transactions)
      .where(cond)
      .groupBy(transactions.kind)
      .all();
    const t = Object.fromEntries(totals.map((r) => [r.kind, r]));

    return {
      items,
      totals: {
        income: t.income?.total ?? 0,
        expense: t.expense?.total ?? 0,
        count: (t.income?.n ?? 0) + (t.expense?.n ?? 0),
      },
    };
  });

  // Detail satu transaksi + rincian item + info foto nota.
  app.get("/api/transactions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const t = db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.householdId, req.user!.householdId), isNull(transactions.deletedAt)))
      .get();
    if (!t) return reply.code(404).send({ error: "Transaksi tidak ditemukan" });
    const items = db
      .select({ name: transactionItems.name, qty: transactionItems.qty, unitPrice: transactionItems.unitPrice, total: transactionItems.total })
      .from(transactionItems)
      .where(eq(transactionItems.transactionId, id))
      .orderBy(asc(transactionItems.position))
      .all();
    const receipt = t.receiptStatus
      ? {
          status: t.receiptStatus,
          // Drive link bila sudah diarsip; selain itu disajikan app sendiri.
          url: t.receiptStatus === "archived" ? t.receiptUrl : `/api/transactions/${t.id}/receipt`,
        }
      : null;
    return { transaction: { id: t.id, source: t.source }, items, receipt };
  });

  app.post("/api/transactions", async (req, reply) => {
    const parsed = TxBody.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const b = parsed.data;
    const hid = req.user!.householdId;
    const catErr = checkCategory(hid, b.categoryId, b.kind);
    if (catErr) return reply.code(400).send({ error: catErr });
    const row = db
      .insert(transactions)
      .values({ ...b, householdId: hid, userId: req.user!.id, source: "web" })
      .returning()
      .get();
    return reply.code(201).send({ transaction: row });
  });

  app.patch("/api/transactions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = TxPatch.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const hid = req.user!.householdId;
    const own = and(eq(transactions.id, id), eq(transactions.householdId, hid), isNull(transactions.deletedAt));
    const current = db.select().from(transactions).where(own).get();
    if (!current) return reply.code(404).send({ error: "Transaksi tidak ditemukan" });

    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const next = { ...current, ...patch };
    // Kalau jenis berubah tapi kategori lama tidak cocok lagi, validasi akan menolak.
    if ("categoryId" in patch || "kind" in patch) {
      const catErr = checkCategory(hid, next.categoryId, next.kind);
      if (catErr) return reply.code(400).send({ error: catErr });
    }
    const row = db
      .update(transactions)
      .set({ ...patch, updatedAt: new Date() })
      .where(own)
      .returning()
      .get();
    return { transaction: row };
  });

  // Soft delete: data tetap ada di DB (deleted_at terisi), tidak muncul di daftar/laporan.
  app.delete("/api/transactions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const res = db
      .update(transactions)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(transactions.id, id), eq(transactions.householdId, req.user!.householdId), isNull(transactions.deletedAt)),
      )
      .run();
    if (res.changes === 0) return reply.code(404).send({ error: "Transaksi tidak ditemukan" });
    return { ok: true };
  });

  // ---------------- Anggaran ----------------
  app.get("/api/budgets", async (req) => {
    const hid = req.user!.householdId;
    ensureDefaultCategories(hid);
    const rows = db
      .select({ categoryId: categories.id, name: categories.name, monthlyAmount: budgets.monthlyAmount })
      .from(categories)
      .leftJoin(budgets, and(eq(budgets.categoryId, categories.id), eq(budgets.householdId, hid)))
      .where(and(eq(categories.householdId, hid), eq(categories.kind, "expense"), eq(categories.archived, false)))
      .orderBy(asc(categories.name))
      .all();
    return { budgets: rows.map((r) => ({ ...r, monthlyAmount: r.monthlyAmount ?? 0 })) };
  });

  // Hanya owner yang mengatur anggaran. monthlyAmount = 0 menghapus anggaran kategori itu.
  app.put("/api/budgets/:id", { preHandler: requireOwner }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = BudgetBody.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const hid = req.user!.householdId;
    const cat = findCategory(hid, id);
    if (!cat || cat.kind !== "expense") return reply.code(404).send({ error: "Kategori pengeluaran tidak ditemukan" });

    if (parsed.data.monthlyAmount === 0) {
      db.delete(budgets).where(and(eq(budgets.householdId, hid), eq(budgets.categoryId, id))).run();
    } else {
      db.insert(budgets)
        .values({ householdId: hid, categoryId: id, monthlyAmount: parsed.data.monthlyAmount, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [budgets.householdId, budgets.categoryId],
          set: { monthlyAmount: parsed.data.monthlyAmount, updatedAt: new Date() },
        })
        .run();
    }
    return { categoryId: id, monthlyAmount: parsed.data.monthlyAmount };
  });

  // ---------------- Ringkasan bulanan ----------------
  app.get("/api/summary", async (req, reply) => {
    const parsed = MonthQuery.safeParse(req.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { month } = parsed.data;
    const hid = req.user!.householdId;
    ensureDefaultCategories(hid);

    const inMonth = (m: string) => {
      const r = monthRange(m);
      return and(
        eq(transactions.householdId, hid),
        isNull(transactions.deletedAt),
        gte(transactions.occurredOn, r.from),
        lt(transactions.occurredOn, r.to),
      );
    };
    const totalsFor = (m: string) => {
      const rows = db
        .select({ kind: transactions.kind, total: sumAmount })
        .from(transactions)
        .where(inMonth(m))
        .groupBy(transactions.kind)
        .all();
      const t = Object.fromEntries(rows.map((r) => [r.kind, r.total]));
      return { income: t.income ?? 0, expense: t.expense ?? 0 };
    };

    const cur = totalsFor(month);
    const prev = totalsFor(prevMonth(month));

    const spent = db
      .select({ categoryId: transactions.categoryId, total: sumAmount })
      .from(transactions)
      .where(and(inMonth(month), eq(transactions.kind, "expense")))
      .groupBy(transactions.categoryId)
      .all();
    const spentMap = new Map(spent.map((s) => [s.categoryId, s.total]));

    const cats = db
      .select({ id: categories.id, name: categories.name, archived: categories.archived, budget: budgets.monthlyAmount })
      .from(categories)
      .leftJoin(budgets, and(eq(budgets.categoryId, categories.id), eq(budgets.householdId, hid)))
      .where(and(eq(categories.householdId, hid), eq(categories.kind, "expense")))
      .all();

    const byCategory = cats
      .map((c) => ({ categoryId: c.id, name: c.name, spent: spentMap.get(c.id) ?? 0, budget: c.budget ?? 0 }))
      .filter((c) => c.spent > 0 || c.budget > 0);
    const uncategorized = spentMap.get(null) ?? 0;
    if (uncategorized > 0) byCategory.push({ categoryId: "none", name: "Tanpa kategori", spent: uncategorized, budget: 0 });
    byCategory.sort((a, b) => b.spent - a.spent || b.budget - a.budget);

    return {
      month,
      income: cur.income,
      expense: cur.expense,
      net: cur.income - cur.expense,
      previous: { month: prevMonth(month), ...prev },
      budgetTotal: byCategory.reduce((s, c) => s + c.budget, 0),
      byCategory,
    };
  });
}
