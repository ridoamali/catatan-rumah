import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { budgets, categories, transactionItems, transactions } from "../db/schema.js";
import { monthRange, prevMonth, todayIn } from "../finance/dates.js";

/**
 * Ringkasan bulanan yang dikirim ke AI.
 * SEMUA angka dihitung di sini; AI hanya menafsirkan.
 * Sengaja TIDAK berisi: catatan transaksi, nama/email anggota, ID internal.
 */
export type InsightInput = {
  month: string;
  isCurrentMonth: boolean;
  daysElapsed: number;
  daysInMonth: number;
  totals: { income: number; expense: number; net: number };
  previousMonths: { month: string; expense: number; income: number }[];
  avgExpensePrev3: number;
  expenseChangeVsAvgPct: number | null;
  categories: {
    name: string;
    spent: number;
    budget: number | null;
    budgetUsedPct: number | null;
    avgPrev3: number;
    changeVsAvgPct: number | null;
  }[];
  topMerchants: { name: string; total: number; count: number }[];
  largestTransactions: { date: string; merchant: string | null; category: string | null; amount: number }[];
  priceChanges: { item: string; firstPrice: number; lastPrice: number; changePct: number; times: number }[];
};

const pct = (cur: number, base: number) => (base > 0 ? Math.round(((cur - base) / base) * 1000) / 10 : null);
const daysIn = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mm, 0)).getUTCDate();
};

export function buildInsightInput(householdId: string, month: string): InsightInput {
  const live = and(eq(transactions.householdId, householdId), isNull(transactions.deletedAt));
  const inMonth = (m: string) => {
    const r = monthRange(m);
    return and(live, gte(transactions.occurredOn, r.from), lt(transactions.occurredOn, r.to));
  };
  const sumAmount = sql<number>`coalesce(sum(${transactions.amount}), 0)`.mapWith(Number);

  const totalsFor = (m: string) => {
    const rows = db.select({ kind: transactions.kind, total: sumAmount }).from(transactions).where(inMonth(m)).groupBy(transactions.kind).all();
    const t = Object.fromEntries(rows.map((r) => [r.kind, r.total]));
    return { income: t.income ?? 0, expense: t.expense ?? 0 };
  };
  const byCategoryFor = (m: string) =>
    new Map(
      db
        .select({ name: sql<string>`coalesce(${categories.name}, 'Tanpa kategori')`, total: sumAmount })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(and(inMonth(m), eq(transactions.kind, "expense")))
        .groupBy(transactions.categoryId)
        .all()
        .map((r) => [r.name, r.total]),
    );

  const cur = totalsFor(month);
  const prevMonths = [1, 2, 3].map((i) => {
    let m = month;
    for (let k = 0; k < i; k++) m = prevMonth(m);
    return { month: m, ...totalsFor(m) };
  });
  const prevWithData = prevMonths.filter((p) => p.expense > 0);
  const avgPrev3 = prevWithData.length ? Math.round(prevWithData.reduce((s, p) => s + p.expense, 0) / prevWithData.length) : 0;

  // Per kategori: bulan ini vs rata-rata 3 bulan sebelumnya + anggaran.
  const curCat = byCategoryFor(month);
  const prevCats = prevMonths.map((p) => byCategoryFor(p.month));
  const budgetRows = db
    .select({ name: categories.name, amount: budgets.monthlyAmount })
    .from(budgets)
    .innerJoin(categories, eq(categories.id, budgets.categoryId))
    .where(eq(budgets.householdId, householdId))
    .all();
  const budgetMap = new Map(budgetRows.map((b) => [b.name, b.amount]));
  const names = new Set([...curCat.keys(), ...budgetMap.keys()]);
  const cats = [...names]
    .map((name) => {
      const spent = curCat.get(name) ?? 0;
      const prevVals = prevCats.map((m) => m.get(name) ?? 0).filter((_, i) => prevMonths[i].expense > 0);
      const avg = prevVals.length ? Math.round(prevVals.reduce((s, v) => s + v, 0) / prevVals.length) : 0;
      const budget = budgetMap.get(name) ?? null;
      return {
        name, spent, budget,
        budgetUsedPct: budget ? Math.round((spent / budget) * 1000) / 10 : null,
        avgPrev3: avg,
        changeVsAvgPct: pct(spent, avg),
      };
    })
    .filter((c) => c.spent > 0 || c.budget)
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 15);

  const merchantKey = sql<string>`lower(trim(${transactions.merchant}))`;
  const topMerchants = db
    .select({ name: sql<string>`max(${transactions.merchant})`, total: sumAmount, count: sql<number>`count(*)`.mapWith(Number) })
    .from(transactions)
    .where(and(inMonth(month), eq(transactions.kind, "expense"), sql`${transactions.merchant} IS NOT NULL AND trim(${transactions.merchant}) <> ''`))
    .groupBy(merchantKey)
    .orderBy(desc(sumAmount))
    .limit(5)
    .all();

  const largest = db
    .select({ date: transactions.occurredOn, merchant: transactions.merchant, category: categories.name, amount: transactions.amount })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(inMonth(month), eq(transactions.kind, "expense")))
    .orderBy(desc(transactions.amount))
    .limit(10)
    .all();

  // Perubahan harga barang dalam 6 bulan terakhir (sampai bulan ini).
  let from6 = month;
  for (let k = 0; k < 5; k++) from6 = prevMonth(from6);
  const items = db
    .select({ name: transactionItems.name, qty: transactionItems.qty, unitPrice: transactionItems.unitPrice, total: transactionItems.total })
    .from(transactionItems)
    .innerJoin(transactions, eq(transactions.id, transactionItems.transactionId))
    .where(and(live, gte(transactions.occurredOn, monthRange(from6).from), lt(transactions.occurredOn, monthRange(month).to)))
    .orderBy(transactions.occurredOn)
    .all();
  const groups = new Map<string, { item: string; prices: number[] }>();
  for (const r of items) {
    const price = r.unitPrice ?? (r.qty > 0 ? Math.round(r.total / r.qty) : r.total);
    if (!price) continue;
    const key = r.name.trim().toLowerCase().replace(/\s+/g, " ");
    const g = groups.get(key) ?? { item: r.name.trim(), prices: [] };
    g.prices.push(price);
    groups.set(key, g);
  }
  const priceChanges = [...groups.values()]
    .filter((g) => g.prices.length >= 2)
    .map((g) => ({
      item: g.item.slice(0, 80),
      firstPrice: g.prices[0],
      lastPrice: g.prices[g.prices.length - 1],
      changePct: pct(g.prices[g.prices.length - 1], g.prices[0]) ?? 0,
      times: g.prices.length,
    }))
    .filter((p) => p.changePct !== 0)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5);

  const today = todayIn();
  const isCurrentMonth = today.slice(0, 7) === month;
  const dim = daysIn(month);
  return {
    month,
    isCurrentMonth,
    daysElapsed: isCurrentMonth ? Number(today.slice(8, 10)) : dim,
    daysInMonth: dim,
    totals: { ...cur, net: cur.income - cur.expense },
    previousMonths: prevMonths.map(({ month: m, expense, income }) => ({ month: m, expense, income })),
    avgExpensePrev3: avgPrev3,
    expenseChangeVsAvgPct: pct(cur.expense, avgPrev3),
    categories: cats,
    topMerchants: topMerchants.map((m) => ({ name: m.name.slice(0, 80), total: m.total, count: m.count })),
    largestTransactions: largest.map((t) => ({ date: t.date, merchant: t.merchant?.slice(0, 80) ?? null, category: t.category ?? null, amount: t.amount })),
    priceChanges,
  };
}
