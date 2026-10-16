import { z } from "zod";

// Semua konfigurasi dibaca dari environment (.env saat dev).
// Nilai rahasia TIDAK pernah di-log.
const emptyToUndef = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("./data/catatan-rumah.db"),
  TZ: z.string().default("Asia/Jakarta"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // --- Scan nota (Langkah 4) ---
  // Webhook n8n. Kosong = belum tersambung (di development, OCR memakai data contoh/mock).
  N8N_RECEIPT_OCR_URL: emptyToUndef(z.url().optional()),
  N8N_RECEIPT_ARCHIVE_URL: emptyToUndef(z.url().optional()),
  // Dikirim sebagai header X-Webhook-Secret ke n8n (Header Auth). Tidak pernah di-log.
  N8N_WEBHOOK_SECRET: emptyToUndef(z.string().min(16, "N8N_WEBHOOK_SECRET minimal 16 karakter").optional()),
  // Analisa AI pengeluaran (Langkah 6). Kosong = mode contoh di development.
  N8N_INSIGHT_URL: emptyToUndef(z.url().optional()),
  RECEIPTS_DIR: z.string().default("./data/receipts"),
  // auto = pakai mock (OCR & analisa AI) hanya bila URL webhook-nya kosong dan bukan production.
  OCR_MOCK: z.enum(["auto", "on", "off"]).default("auto"),
  // Origin yang boleh melakukan request POST/PUT/PATCH/DELETE (proteksi CSRF tambahan).
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Konfigurasi .env tidak valid:", z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const ocrMock = env.OCR_MOCK === "on" || (env.OCR_MOCK === "auto" && !env.N8N_RECEIPT_OCR_URL && !isProd);
export const insightMock = env.OCR_MOCK === "on" || (env.OCR_MOCK === "auto" && !env.N8N_INSIGHT_URL && !isProd);
