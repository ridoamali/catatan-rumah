import { and, count, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { categories } from "../db/schema.js";

export const DEFAULT_CATEGORIES = {
  expense: [
    "Belanja Dapur",
    "Makan di Luar",
    "Transportasi",
    "Listrik & Air",
    "Internet & Pulsa",
    "Kesehatan",
    "Pendidikan",
    "Kebutuhan Rumah",
    "Hiburan",
    "Cicilan",
    "Lain-lain",
  ],
  income: ["Gaji", "Usaha / Freelance", "Lain-lain"],
} as const;

// Idempotent: hanya mengisi kategori default bila household belum punya kategori sama sekali.
export function ensureDefaultCategories(householdId: string) {
  const n = db.select({ n: count() }).from(categories).where(eq(categories.householdId, householdId)).get()!.n;
  if (n > 0) return;
  const rows = (["expense", "income"] as const).flatMap((kind) =>
    DEFAULT_CATEGORIES[kind].map((name) => ({ householdId, kind, name })),
  );
  db.insert(categories).values(rows).onConflictDoNothing().run();
}

export function findCategory(householdId: string, categoryId: string) {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.householdId, householdId)))
    .get();
}
