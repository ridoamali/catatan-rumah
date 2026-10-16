import { z } from "zod";
import { isValidDate } from "../finance/dates.js";

// Angka dari LLM bisa berupa number atau string ("25.500", "Rp 25.500"). Dinormalisasi jadi number|null.
const num = z.preprocess((v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().finite().nullable());

/** Bentuk balasan webhook OCR n8n (toleran: field opsional boleh hilang/null). */
export const OcrResponse = z.object({
  error: z.string().nullish(),
  merchant: z.string().nullish(),
  date: z.string().nullish(),
  category: z.string().nullish(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        qty: num.optional(),
        unit_price: num.optional(),
        total: num.optional(),
      }),
    )
    .max(300)
    .nullish(),
  subtotal: num.optional(),
  discount: num.optional(),
  tax: num.optional(),
  total: num.optional(),
});

export type OcrItem = { name: string; qty: number; unitPrice: number | null; total: number };
export type OcrResult = {
  merchant: string | null;
  date: string | null;
  categoryName: string | null;
  items: OcrItem[];
  subtotal: number | null;
  discount: number | null;
  tax: number | null;
  total: number | null;
  itemsSum: number;
};

const money = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.max(0, Math.round(n)));

/** Normalisasi hasil OCR menjadi data yang aman dipakai form review. */
export function normalizeOcr(raw: z.infer<typeof OcrResponse>): OcrResult {
  const items: OcrItem[] = [];
  for (const it of raw.items ?? []) {
    const qty = it.qty && it.qty > 0 ? Math.round(it.qty * 1000) / 1000 : 1;
    const unitPrice = money(it.unit_price);
    const total = money(it.total) ?? (unitPrice !== null ? Math.round(unitPrice * qty) : null);
    if (total === null) continue; // tanpa harga sama sekali: tidak berguna untuk dicatat
    items.push({ name: it.name.slice(0, 120), qty, unitPrice, total });
  }
  const itemsSum = items.reduce((s, i) => s + i.total, 0);
  const date = raw.date && isValidDate(raw.date) ? raw.date : null;
  return {
    merchant: raw.merchant?.trim().slice(0, 120) || null,
    date,
    categoryName: raw.category?.trim() || null,
    items,
    subtotal: money(raw.subtotal),
    discount: money(raw.discount),
    tax: money(raw.tax),
    total: money(raw.total) ?? (itemsSum > 0 ? itemsSum : null),
    itemsSum,
  };
}

/** Data contoh untuk development saat webhook OCR belum tersambung. */
export function mockOcr(today: string): z.infer<typeof OcrResponse> {
  return {
    merchant: "Indomaret Rungkut (CONTOH)",
    date: today,
    category: "Belanja Dapur",
    items: [
      { name: "Telur Ayam 1kg", qty: 1, unit_price: 29500, total: 29500 },
      { name: "Beras Premium 5kg", qty: 1, unit_price: 72000, total: 72000 },
      { name: "Minyak Goreng 2L", qty: 1, unit_price: 36900, total: 36900 },
      { name: "Indomie Goreng", qty: 5, unit_price: 3100, total: 15500 },
    ],
    subtotal: 153900,
    discount: 3900,
    tax: 0,
    total: 150000,
  };
}
