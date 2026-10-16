import { z } from "zod";
import type { InsightInput } from "./summary.js";

const text = (max: number) => z.string().trim().min(1).transform((s) => s.slice(0, max));
const optText = (max: number) => z.string().trim().nullish().transform((s) => (s ? s.slice(0, max) : null));
const optNum = z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().finite().nonnegative().nullish())
  .transform((n) => (n == null ? null : Math.round(n)));

/** Bentuk balasan webhook analisa n8n. Panjang teks dipotong; jumlah butir dibatasi. */
export const InsightResult = z.object({
  summary: text(600),
  highlights: z
    .array(z.object({
      type: z.enum(["warning", "info", "good"]).catch("info"),
      title: text(90),
      detail: text(400),
      category: optText(60),
    }))
    .max(10).default([]).transform((a) => a.slice(0, 6)),
  anomalies: z
    .array(z.object({ date: optText(10), merchant: optText(80), amount: optNum, reason: text(300) }))
    .max(10).default([]).transform((a) => a.slice(0, 5)),
  tips: z
    .array(z.object({ title: text(90), detail: text(400), estimatedSaving: optNum }))
    .max(10).default([]).transform((a) => a.slice(0, 5)),
});
export type InsightResultT = z.infer<typeof InsightResult>;

const rp = (n: number) => "Rp " + n.toLocaleString("id-ID");

/** Hasil contoh (development tanpa n8n): diturunkan dari angka ringkasan, ditandai CONTOH. */
export function mockInsight(input: InsightInput): InsightResultT {
  const up = [...input.categories].filter((c) => c.changeVsAvgPct !== null).sort((a, b) => (b.changeVsAvgPct ?? 0) - (a.changeVsAvgPct ?? 0))[0];
  const over = input.categories.find((c) => (c.budgetUsedPct ?? 0) > 100);
  const big = input.largestTransactions[0];
  const highlights: InsightResultT["highlights"] = [];
  if (up && (up.changeVsAvgPct ?? 0) > 0) {
    highlights.push({ type: "warning", title: `${up.name} naik ${up.changeVsAvgPct}%`, detail: `Bulan ini ${rp(up.spent)}, rata-rata 3 bulan sebelumnya ${rp(up.avgPrev3)}.`, category: up.name });
  }
  if (over) {
    highlights.push({ type: "warning", title: `Anggaran ${over.name} terlewati`, detail: `Terpakai ${over.budgetUsedPct}% dari ${rp(over.budget ?? 0)}.`, category: over.name });
  }
  if (input.totals.net > 0) {
    highlights.push({ type: "good", title: "Masih surplus", detail: `Pemasukan lebih besar ${rp(input.totals.net)} dari pengeluaran.`, category: null });
  }
  return {
    summary: `(CONTOH) Pengeluaran bulan ini ${rp(input.totals.expense)}${input.expenseChangeVsAvgPct !== null ? `, ${input.expenseChangeVsAvgPct > 0 ? "naik" : "turun"} ${Math.abs(input.expenseChangeVsAvgPct)}% dari rata-rata 3 bulan sebelumnya` : ""}.`,
    highlights,
    anomalies: big ? [{ date: big.date, merchant: big.merchant, amount: big.amount, reason: "Transaksi terbesar bulan ini. Pastikan memang sesuai." }] : [],
    tips: [{ title: "Tetapkan anggaran per kategori", detail: "Kategori dengan anggaran lebih mudah dipantau dari Beranda.", estimatedSaving: null }],
  };
}
