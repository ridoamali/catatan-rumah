import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { categories, transactionItems, transactions, users } from "../db/schema.js";
import { requireAuth } from "../auth/session.js";
import { isValidMonth, monthRange, todayIn } from "../finance/dates.js";

const MAX_MONTHS = 24;

const Query = z
  .object({
    from: z.string().refine(isValidMonth, "Format bulan YYYY-MM").optional(),
    to: z.string().refine(isValidMonth, "Format bulan YYYY-MM").optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "from harus ≤ to");

/** Daftar bulan YYYY-MM dari a sampai b (inklusif). */
export function monthsBetween(a: string, b: string): string[] {
  const out: string[] = [];
  let [y, m] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  while (y < by || (y === by && m <= bm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > MAX_MONTHS) break;
  }
  return out;
}

const shift = (month: string, delta: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

const sumAmount = sql<number>`coalesce(sum(${transactions.amount}), 0)`.mapWith(Number);
const countRows = sql<number>`count(*)`.mapWith(Number);

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/reports", async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Input tidak valid", fields: z.flattenError(parsed.error).fieldErrors });
    const current = todayIn().slice(0, 7);
    const to = parsed.data.to ?? current;
    const from = parsed.data.from ?? shift(to, -5);
    const months = monthsBetween(from, to);
    if (months.length > MAX_MONTHS) return reply.code(400).send({ error: `Rentang maksimal ${MAX_MONTHS} bulan` });

    const hid = req.user!.householdId;
    const range = and(
      eq(transactions.householdId, hid),
      isNull(transactions.deletedAt),
      gte(transactions.occurredOn, monthRange(from).from),
      lt(transactions.occurredOn, monthRange(to).to),
    );
    const expense = and(range, eq(transactions.kind, "expense"));
    const monthExpr = sql<string>`substr(${transactions.occurredOn}, 1, 7)`;

    // 1) Tren bulanan (bulan tanpa transaksi tetap muncul dengan nilai 0)
    const monthlyRows = db
      .select({ month: monthExpr, kind: transactions.kind, total: sumAmount })
      .from(transactions)
      .where(range)
      .groupBy(monthExpr, transactions.kind)
      .all();
    const monthly = months.map((m) => ({
      month: m,
      expense: monthlyRows.find((r) => r.month === m && r.kind === "expense")?.total ?? 0,
      income: monthlyRows.find((r) => r.month === m && r.kind === "income")?.total ?? 0,
    }));

    // 2) Pengeluaran per kategori
    const byCategory = db
      .select({ categoryId: transactions.categoryId, name: categories.name, total: sumAmount, count: countRows })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(expense)
      .groupBy(transactions.categoryId)
      .orderBy(desc(sumAmount), categories.name)
      .all()
      .map((r) => ({ categoryId: r.categoryId ?? "none", name: r.name ?? "Tanpa kategori", total: r.total, count: r.count }));

    // 3) Pengeluaran per anggota (siapa yang mencatat)
    const byMember = db
      .select({ userId: transactions.userId, name: users.name, total: sumAmount, count: countRows })
      .from(transactions)
      .leftJoin(users, eq(users.id, transactions.userId))
      .where(expense)
      .groupBy(transactions.userId)
      .orderBy(desc(sumAmount), users.name)
      .all()
      .map((r) => ({ userId: r.userId ?? "none", name: r.name ?? "Tidak diketahui", total: r.total, count: r.count }));

    // 4) Toko teratas (nama dinormalisasi: huruf kecil + spasi dirapikan)
    const merchantKey = sql<string>`lower(trim(${transactions.merchant}))`;
    const topMerchants = db
      .select({ key: merchantKey, name: sql<string>`max(${transactions.merchant})`, total: sumAmount, count: countRows })
      .from(transactions)
      .where(and(expense, sql`${transactions.merchant} IS NOT NULL AND trim(${transactions.merchant}) <> ''`))
      .groupBy(merchantKey)
      .orderBy(desc(sumAmount), merchantKey)
      .limit(8)
      .all()
      .map(({ name, total, count }) => ({ name, total, count }));

    // 5) Perubahan harga barang yang dibeli ≥ 2 kali (dari rincian nota)
    const itemRows = db
      .select({
        name: transactionItems.name,
        qty: transactionItems.qty,
        unitPrice: transactionItems.unitPrice,
        total: transactionItems.total,
        occurredOn: transactions.occurredOn,
      })
      .from(transactionItems)
      .innerJoin(transactions, eq(transactions.id, transactionItems.transactionId))
      .where(and(range, eq(transactions.kind, "expense")))
      .orderBy(transactions.occurredOn)
      .all();
    const groups = new Map<string, { name: string; prices: { on: string; price: number }[] }>();
    for (const r of itemRows) {
      const price = r.unitPrice ?? (r.qty > 0 ? Math.round(r.total / r.qty) : r.total);
      if (!price) continue;
      const key = r.name.trim().toLowerCase().replace(/\s+/g, " ");
      const g = groups.get(key) ?? { name: r.name.trim(), prices: [] };
      g.prices.push({ on: r.occurredOn, price });
      groups.set(key, g);
    }
    const itemPrices = [...groups.values()]
      .filter((g) => g.prices.length >= 2)
      .map((g) => {
        const first = g.prices[0];
        const last = g.prices[g.prices.length - 1];
        const all = g.prices.map((p) => p.price);
        return {
          name: g.name,
          times: g.prices.length,
          firstPrice: first.price, firstOn: first.on,
          lastPrice: last.price, lastOn: last.on,
          minPrice: Math.min(...all), maxPrice: Math.max(...all),
          changePct: Math.round(((last.price - first.price) / first.price) * 1000) / 10,
        };
      })
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || b.times - a.times)
      .slice(0, 10);

    const totalExpense = monthly.reduce((s, m) => s + m.expense, 0);
    const totalIncome = monthly.reduce((s, m) => s + m.income, 0);
    return {
      from, to, months,
      totals: {
        expense: totalExpense,
        income: totalIncome,
        net: totalIncome - totalExpense,
        avgMonthlyExpense: Math.round(totalExpense / months.length),
      },
      monthly, byCategory, byMember, topMerchants, itemPrices,
    };
  });
}
