import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { categories, households, receiptScans, transactionItems, transactions } from "../db/schema.js";
import { requireAuth } from "../auth/session.js";
import { env, ocrMock } from "../env.js";
import { ensureDefaultCategories, findCategory } from "../finance/defaults.js";
import { isValidDate, todayIn } from "../finance/dates.js";
import { postWebhook, WebhookError } from "../receipts/n8n.js";
import { mockOcr, normalizeOcr, OcrResponse } from "../receipts/ocr.js";
import { decodeImage, deleteImage, IMAGE_MIMES, mimeFromPath, readImage, saveImage } from "../receipts/storage.js";

const OCR_TIMEOUT_MS = 90_000;
const ARCHIVE_TIMEOUT_MS = 30_000;
const SCAN_TTL_MS = 24 * 60 * 60 * 1000;

const idParam = z.object({ id: z.string().min(1).max(64) });
const ScanBody = z.object({
  imageBase64: z.string().min(16).max(8 * 1024 * 1024),
  mimeType: z.enum(IMAGE_MIMES as [string, ...string[]]),
});
const CommitBody = z.object({
  amount: z.number().int().positive().max(1_000_000_000_000),
  occurredOn: z.string().refine(isValidDate, "Tanggal harus YYYY-MM-DD"),
  categoryId: z.string().min(1).max(64).nullish().transform((v) => v ?? null),
  merchant: z.string().trim().max(120).nullish().transform((v) => v || null),
  note: z.string().trim().max(500).nullish().transform((v) => v || null),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        qty: z.number().positive().max(100_000),
        unitPrice: z.number().int().min(0).max(1_000_000_000_000).nullable(),
        total: z.number().int().min(0).max(1_000_000_000_000),
      }),
    )
    .max(300)
    .default([]),
});
const ArchiveResponse = z.object({ fileId: z.string().min(1).max(200), webViewLink: z.url() });

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "Input tidak valid", fields: z.flattenError(error).fieldErrors });
}

const slug = (s: string | null) =>
  (s ?? "nota").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "nota";

/**
 * Kirim foto transaksi ke webhook arsip n8n (Google Drive).
 * Berhasil → receipt_status=archived + link Drive, file lokal dihapus.
 * Gagal    → receipt_status=failed, file lokal disimpan untuk dicoba ulang.
 * Webhook belum diatur → receipt_status=local (foto tetap di server).
 */
export async function archiveReceipt(transactionId: string): Promise<"archived" | "failed" | "local"> {
  // Satu transaksi hanya diarsip oleh satu proses pada satu waktu.
  const running = inflight.get(transactionId);
  if (running) return running;
  const p = doArchive(transactionId).finally(() => inflight.delete(transactionId));
  inflight.set(transactionId, p);
  return p;
}

const inflight = new Map<string, Promise<"archived" | "failed" | "local">>();

/** Tunggu semua arsip background selesai (dipakai tes & saat shutdown). */
export async function drainArchives() {
  while (inflight.size) await Promise.allSettled([...inflight.values()]);
}

/**
 * Lanjutkan arsip yang tertunda: status pending yang macet (mis. server restart di tengah arsip)
 * dan status failed yang fotonya masih ada di server. Dipanggil saat start & berkala.
 */
export async function resumeArchives({ staleMs = 2 * 60 * 1000, includeFailed = false } = {}) {
  if (!env.N8N_RECEIPT_ARCHIVE_URL) return 0;
  const rows = db
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(receiptScans, eq(receiptScans.transactionId, transactions.id))
    .where(
      and(
        isNull(transactions.deletedAt),
        isNotNull(receiptScans.imagePath),
        or(
          includeFailed ? eq(transactions.receiptStatus, "failed") : undefined,
          and(eq(transactions.receiptStatus, "pending"), lt(transactions.createdAt, new Date(Date.now() - staleMs))),
        ),
      ),
    )
    .all();
  for (const r of rows) await archiveReceipt(r.id);
  return rows.length;
}

async function doArchive(transactionId: string): Promise<"archived" | "failed" | "local"> {
  const tx = db.select().from(transactions).where(eq(transactions.id, transactionId)).get();
  const scan = db.select().from(receiptScans).where(eq(receiptScans.transactionId, transactionId)).get();
  if (!tx || !scan?.imagePath) return "failed";
  if (!env.N8N_RECEIPT_ARCHIVE_URL) {
    db.update(transactions).set({ receiptStatus: "local" }).where(eq(transactions.id, transactionId)).run();
    return "local";
  }
  try {
    const buf = await readImage(scan.imagePath);
    const mime = mimeFromPath(scan.imagePath);
    const ext = mime.split("/")[1].replace("jpeg", "jpg");
    const hh = db.select({ name: households.name }).from(households).where(eq(households.id, tx.householdId)).get();
    const raw = await postWebhook(
      env.N8N_RECEIPT_ARCHIVE_URL,
      {
        transactionId: tx.id,
        fileName: `${tx.occurredOn}_${slug(tx.merchant)}_${tx.id.slice(0, 8)}.${ext}`,
        mimeType: mime,
        imageBase64: buf.toString("base64"),
        occurredOn: tx.occurredOn,
        merchant: tx.merchant,
        amount: tx.amount,
        household: hh?.name ?? null,
      },
      ARCHIVE_TIMEOUT_MS,
    );
    const parsed = ArchiveResponse.safeParse(raw);
    if (!parsed.success) throw new WebhookError("format", "format");
    db.update(transactions)
      .set({ receiptStatus: "archived", receiptFileId: parsed.data.fileId, receiptUrl: parsed.data.webViewLink })
      .where(eq(transactions.id, transactionId))
      .run();
    await deleteImage(scan.imagePath);
    db.update(receiptScans).set({ imagePath: null }).where(eq(receiptScans.id, scan.id)).run();
    return "archived";
  } catch {
    db.update(transactions).set({ receiptStatus: "failed" }).where(eq(transactions.id, transactionId)).run();
    return "failed";
  }
}

/** Sesi scan yang ditinggal (tidak disimpan/dibatalkan) > 24 jam: hapus fotonya. */
export async function purgeStaleScans() {
  const stale = db
    .select({ id: receiptScans.id, imagePath: receiptScans.imagePath })
    .from(receiptScans)
    .where(and(eq(receiptScans.status, "pending"), lt(receiptScans.createdAt, new Date(Date.now() - SCAN_TTL_MS))))
    .all();
  for (const s of stale) {
    if (s.imagePath) await deleteImage(s.imagePath);
  }
  if (stale.length) {
    db.update(receiptScans)
      .set({ status: "expired", imagePath: null })
      .where(inArray(receiptScans.id, stale.map((s) => s.id)))
      .run();
  }
  return stale.length;
}

export async function scanRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // 1) Upload foto (base64, sudah dikompres di browser) → OCR → hasil untuk direview.
  app.post(
    "/api/scans",
    { bodyLimit: 9 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const parsed = ScanBody.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const mime = parsed.data.mimeType as (typeof IMAGE_MIMES)[number];
      const img = decodeImage(parsed.data.imageBase64, mime);
      if (!img.ok) {
        return img.reason === "size"
          ? reply.code(413).send({ error: "Foto terlalu besar (maks 5 MB)." })
          : reply.code(400).send({ error: "File bukan gambar JPEG, PNG, atau WebP yang valid." });
      }
      if (!ocrMock && !env.N8N_RECEIPT_OCR_URL) {
        return reply.code(503).send({ error: "Scan nota belum tersambung ke n8n. Isi N8N_RECEIPT_OCR_URL di .env." });
      }

      const u = req.user!;
      ensureDefaultCategories(u.householdId);
      const expenseCats = db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(eq(categories.householdId, u.householdId), eq(categories.kind, "expense"), eq(categories.archived, false)))
        .orderBy(asc(categories.name))
        .all();

      const scan = db
        .insert(receiptScans)
        .values({ householdId: u.householdId, userId: u.id, status: "pending", imageBytes: img.buf.length, mock: ocrMock })
        .returning({ id: receiptScans.id })
        .get();
      const imagePath = await saveImage(u.householdId, scan.id, mime, img.buf);
      db.update(receiptScans).set({ imagePath }).where(eq(receiptScans.id, scan.id)).run();

      const today = todayIn();
      let raw: unknown;
      try {
        raw = ocrMock
          ? mockOcr(today)
          : await postWebhook(
              env.N8N_RECEIPT_OCR_URL!,
              { scanId: scan.id, mimeType: mime, imageBase64: img.buf.toString("base64"), categories: expenseCats.map((c) => c.name), today },
              OCR_TIMEOUT_MS,
            );
      } catch (e) {
        await failScan(scan.id, imagePath, null);
        const timeout = e instanceof WebhookError && e.kind === "timeout";
        return reply.code(502).send({ error: timeout ? "OCR terlalu lama merespons. Coba lagi." : "Layanan OCR tidak bisa dihubungi. Coba lagi sebentar." });
      }

      const parsedOcr = OcrResponse.safeParse(raw);
      if (!parsedOcr.success) {
        await failScan(scan.id, imagePath, JSON.stringify(raw).slice(0, 20_000));
        return reply.code(502).send({ error: "Balasan OCR tidak dikenali. Periksa workflow n8n." });
      }
      if (parsedOcr.data.error) {
        await failScan(scan.id, imagePath, JSON.stringify(parsedOcr.data));
        return reply.code(422).send({ error: "Nota tidak terbaca. Coba foto ulang dengan cahaya cukup dan nota tidak terlipat." });
      }

      const result = normalizeOcr(parsedOcr.data);
      db.update(receiptScans).set({ ocrJson: JSON.stringify(parsedOcr.data) }).where(eq(receiptScans.id, scan.id)).run();
      const cat = result.categoryName
        ? expenseCats.find((c) => c.name.toLowerCase() === result.categoryName!.toLowerCase())
        : undefined;

      return reply.code(201).send({
        scanId: scan.id,
        mock: ocrMock,
        result: { ...result, categoryId: cat?.id ?? null },
      });
    },
  );

  // Foto dari sesi scan yang masih berjalan (untuk preview di layar review).
  app.get("/api/scans/:id/image", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const scan = db
      .select()
      .from(receiptScans)
      .where(and(eq(receiptScans.id, id), eq(receiptScans.householdId, req.user!.householdId)))
      .get();
    if (!scan?.imagePath) return reply.code(404).send({ error: "Foto tidak ditemukan" });
    return sendImage(reply, scan.imagePath);
  });

  // 2) Simpan hasil review sebagai transaksi (source=scan) + rincian item, lalu arsipkan foto.
  app.post("/api/scans/:id/commit", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = CommitBody.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const b = parsed.data;
    const u = req.user!;

    if (b.categoryId) {
      const cat = findCategory(u.householdId, b.categoryId);
      if (!cat || cat.archived || cat.kind !== "expense") return reply.code(400).send({ error: "Kategori tidak valid" });
    }

    const txId = db.transaction((tx) => {
      const scan = tx
        .select()
        .from(receiptScans)
        .where(and(eq(receiptScans.id, id), eq(receiptScans.householdId, u.householdId), eq(receiptScans.status, "pending")))
        .get();
      if (!scan) return null;
      const t = tx
        .insert(transactions)
        .values({
          householdId: u.householdId, userId: u.id, kind: "expense", amount: b.amount, occurredOn: b.occurredOn,
          categoryId: b.categoryId, merchant: b.merchant, note: b.note, source: "scan",
          externalRef: scan.id, receiptStatus: "local",
        })
        .returning({ id: transactions.id })
        .get();
      if (b.items.length) {
        tx.insert(transactionItems)
          .values(b.items.map((it, i) => ({ transactionId: t.id, householdId: u.householdId, position: i, ...it })))
          .run();
      }
      tx.update(receiptScans).set({ status: "committed", transactionId: t.id }).where(eq(receiptScans.id, scan.id)).run();
      return t.id;
    });
    if (!txId) return reply.code(404).send({ error: "Sesi scan tidak ditemukan atau sudah disimpan" });

    // Arsip ke Drive berjalan di background agar pengguna tidak menunggu upload Drive.
    if (!env.N8N_RECEIPT_ARCHIVE_URL) {
      return reply.code(201).send({ transactionId: txId, receiptStatus: await archiveReceipt(txId) });
    }
    db.update(transactions).set({ receiptStatus: "pending" }).where(eq(transactions.id, txId)).run();
    archiveReceipt(txId).catch((e) => req.log.error(e, "arsip nota gagal"));
    return reply.code(201).send({ transactionId: txId, receiptStatus: "pending" });
  });

  // Batal: hapus foto, sesi ditandai cancelled. Tidak ada yang masuk ke Drive.
  app.delete("/api/scans/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const scan = db
      .select()
      .from(receiptScans)
      .where(and(eq(receiptScans.id, id), eq(receiptScans.householdId, req.user!.householdId), eq(receiptScans.status, "pending")))
      .get();
    if (!scan) return reply.code(404).send({ error: "Sesi scan tidak ditemukan" });
    if (scan.imagePath) await deleteImage(scan.imagePath);
    db.update(receiptScans).set({ status: "cancelled", imagePath: null }).where(eq(receiptScans.id, id)).run();
    return { ok: true };
  });

  // Foto nota sebuah transaksi yang masih tersimpan di server (status local/failed).
  app.get("/api/transactions/:id/receipt", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const scan = db
      .select({ imagePath: receiptScans.imagePath })
      .from(receiptScans)
      .innerJoin(transactions, eq(transactions.id, receiptScans.transactionId))
      .where(and(eq(transactions.id, id), eq(transactions.householdId, req.user!.householdId), isNull(transactions.deletedAt)))
      .get();
    if (!scan?.imagePath) return reply.code(404).send({ error: "Foto nota tidak tersimpan di server" });
    return sendImage(reply, scan.imagePath);
  });

  // Coba ulang arsip ke Drive (status failed/local).
  app.post("/api/transactions/:id/receipt/archive", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const tx = db
      .select({ status: transactions.receiptStatus })
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.householdId, req.user!.householdId), isNull(transactions.deletedAt)))
      .get();
    if (!tx || !tx.status) return reply.code(404).send({ error: "Transaksi tanpa foto nota" });
    if (tx.status === "archived") return { receiptStatus: "archived" };
    // Retry manual menunggu hasilnya agar UI langsung tahu berhasil/tidak.
    if (!env.N8N_RECEIPT_ARCHIVE_URL) return reply.code(503).send({ error: "Arsip Drive belum diatur (N8N_RECEIPT_ARCHIVE_URL)." });
    return { receiptStatus: await archiveReceipt(id) };
  });
}

async function failScan(scanId: string, imagePath: string, ocrJson: string | null) {
  await deleteImage(imagePath);
  db.update(receiptScans).set({ status: "failed", imagePath: null, ocrJson }).where(eq(receiptScans.id, scanId)).run();
}

async function sendImage(reply: FastifyReply, rel: string) {
  try {
    const buf = await readImage(rel);
    return reply.header("content-type", mimeFromPath(rel)).header("cache-control", "private, max-age=3600").send(buf);
  } catch {
    return reply.code(404).send({ error: "Foto tidak ditemukan" });
  }
}
