import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch('subsec') * 1000)`);

// Satu rumah tangga = satu "household". Semua data (transaksi, pengingat, dst.) nanti
// selalu di-scope ke household_id.
export const households = sqliteTable("households", {
  id: id(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("IDR"),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  createdAt: createdAt(),
});

export const users = sqliteTable(
  "users",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), index("users_household_idx").on(t.householdId)],
);

// Token sesi disimpan sebagai SHA-256; token mentah hanya ada di cookie browser.
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256(token)
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// Kode undangan anggota keluarga: sekali pakai, ada masa berlaku. Disimpan sebagai hash.
export const invites = sqliteTable(
  "invites",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_code_uq").on(t.codeHash)],
);

export type User = typeof users.$inferSelect;

// ---------------------------------------------------------------------------
// Langkah 7: pengingat pembayaran/tagihan (in-app)
// ---------------------------------------------------------------------------
export const REMINDER_REPEAT = ["none", "monthly", "yearly"] as const;
export const REMINDER_STATUS = ["active", "done"] as const;

// Pengingat tagihan keluarga. Tanggal jatuh tempo berformat YYYY-MM-DD (zona
// Asia/Jakarta, sama dengan transaksi). Pengulangan monthly = jatuh tempo tiap
// bulan pada hari yang sama (dari dueDate), yearly = tiap tahun pada tanggal
// yang sama. Tidak otomatis membuat transaksi — itu keputusan pengguna.
export const reminders = sqliteTable(
  "reminders",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    // Nominal opsional (rupiah, bilangan bulat) — null = tanpa nominal.
    amount: integer("amount"),
    dueDate: text("due_date").notNull(), // YYYY-MM-DD
    repeat: text("repeat", { enum: REMINDER_REPEAT }).notNull().default("none"),
    note: text("note"),
    status: text("status", { enum: REMINDER_STATUS }).notNull().default("active"),
    // Saat status=done: kapan ditandai selesai & untuk siklus mana
    // (YYYY-MM-DD jatuh tempo yang diselesaikan — dipakai untuk menghitung
    // jatuh tempo berikutnya pada pengingat berulang).
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    completedDueDate: text("completed_due_date"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("reminders_household_due_idx").on(t.householdId, t.dueDate)],
);

export type Reminder = typeof reminders.$inferSelect;

// ---------------------------------------------------------------------------
// Langkah 3: kategori, transaksi, anggaran
// ---------------------------------------------------------------------------

export const KINDS = ["expense", "income"] as const;
export const SOURCES = ["web", "scan", "telegram", "import"] as const;

export const categories = sqliteTable(
  "categories",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: KINDS }).notNull(),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("categories_household_kind_name_uq").on(t.householdId, t.kind, t.name)],
);

// Nominal disimpan sebagai INTEGER rupiah (tanpa desimal) agar tidak ada error pembulatan.
// occurred_on = tanggal transaksi lokal rumah tangga, format YYYY-MM-DD.
export const transactions = sqliteTable(
  "transactions",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    kind: text("kind", { enum: KINDS }).notNull(),
    amount: integer("amount").notNull(),
    occurredOn: text("occurred_on").notNull(),
    merchant: text("merchant"),
    note: text("note"),
    // Asal data: web (input manual), scan (nota via n8n), telegram (bot), import (data lama Sheets).
    source: text("source", { enum: SOURCES }).notNull().default("web"),
    // ID dari sistem asal (mis. message_id Telegram / baris Sheet) untuk mencegah data dobel.
    externalRef: text("external_ref"),
    // Foto nota (hanya untuk source=scan): local = tersimpan di server, pending = sedang diarsip ke Drive,
    // archived = di Google Drive, failed = arsip gagal (file lokal disimpan, dicoba ulang otomatis).
    receiptStatus: text("receipt_status", { enum: ["local", "pending", "archived", "failed"] }),
    receiptFileId: text("receipt_file_id"),
    receiptUrl: text("receipt_url"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("tx_household_date_idx").on(t.householdId, t.occurredOn),
    index("tx_household_category_idx").on(t.householdId, t.categoryId),
    uniqueIndex("tx_external_ref_uq")
      .on(t.householdId, t.source, t.externalRef)
      .where(sql`${t.externalRef} IS NOT NULL`),
  ],
);

// Anggaran bulanan tetap per kategori pengeluaran.
export const budgets = sqliteTable(
  "budgets",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    monthlyAmount: integer("monthly_amount").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("budgets_household_category_uq").on(t.householdId, t.categoryId)],
);

// ---------------------------------------------------------------------------
// Langkah 4: item nota & sesi scan
// ---------------------------------------------------------------------------

// Rincian barang per transaksi (dari nota). Dasar analisa tren harga per barang.
export const transactionItems = sqliteTable(
  "transaction_items",
  {
    id: id(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    qty: real("qty").notNull().default(1),
    unitPrice: integer("unit_price"),
    total: integer("total").notNull(),
  },
  (t) => [
    index("items_tx_idx").on(t.transactionId),
    index("items_household_name_idx").on(t.householdId, t.name),
  ],
);

// Satu sesi scan: foto sementara + hasil OCR mentah, sampai disimpan (committed) atau dibatalkan.
export const receiptScans = sqliteTable(
  "receipt_scans",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status", { enum: ["pending", "committed", "cancelled", "expired", "failed"] }).notNull(),
    imagePath: text("image_path"),
    imageBytes: integer("image_bytes"),
    ocrJson: text("ocr_json"),
    mock: integer("mock", { mode: "boolean" }).notNull().default(false),
    transactionId: text("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("scans_household_status_idx").on(t.householdId, t.status)],
);

// ---------------------------------------------------------------------------
// Langkah 6: hasil analisa AI (disimpan agar tidak memanggil AI tiap halaman dibuka)
// ---------------------------------------------------------------------------
export const insights = sqliteTable(
  "insights",
  {
    id: id(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    month: text("month").notNull(), // YYYY-MM
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    inputJson: text("input_json").notNull(), // ringkasan yang dikirim ke AI (untuk audit)
    resultJson: text("result_json").notNull(),
    mock: integer("mock", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("insights_household_month_idx").on(t.householdId, t.month)],
);
