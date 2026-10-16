import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// ---- Server n8n palsu: perilaku diatur per tes ----
type Behaviour = { status?: number; body?: unknown; delayMs?: number };
const fake = { ocr: {} as Behaviour, archive: {} as Behaviour, calls: [] as { path: string; secret?: string; body: any }[] };
const readBody = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => res(s));
  });
const n8n: Server = createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  fake.calls.push({ path: req.url!, secret: req.headers["x-webhook-secret"] as string | undefined, body });
  const b = req.url === "/ocr" ? fake.ocr : fake.archive;
  if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
  res.writeHead(b.status ?? 200, { "content-type": "application/json" });
  res.end(JSON.stringify(b.body ?? {}));
});
await new Promise<void>((r) => n8n.listen(0, "127.0.0.1", r));
const port = (n8n.address() as { port: number }).port;

const dir = mkdtempSync(join(tmpdir(), "cr-scan-"));
const SECRET = "rahasia-webhook-uji-123";
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(dir, "test.db");
process.env.RECEIPTS_DIR = join(dir, "receipts");
process.env.N8N_RECEIPT_OCR_URL = `http://127.0.0.1:${port}/ocr`;
process.env.N8N_RECEIPT_ARCHIVE_URL = `http://127.0.0.1:${port}/archive`;
process.env.N8N_WEBHOOK_SECRET = SECRET;
process.env.OCR_MOCK = "off";

const { runMigrations, sqlite } = await import("./db/client.js");
const { buildApp } = await import("./app.js");
const { hashPassword } = await import("./auth/crypto.js");
const { purgeStaleScans, drainArchives, resumeArchives } = await import("./routes/scans.js");

// JPEG minimal valid secara magic bytes (FF D8 FF ...).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
const jpeg64 = JPEG.toString("base64");
const OCR_OK = {
  merchant: "Indomaret Rungkut", date: "2026-10-14", category: "belanja dapur",
  items: [
    { name: "Telur Ayam 1kg", qty: 1, unit_price: 29500, total: 29500 },
    { name: "Indomie Goreng", qty: "5", unit_price: "3.100", total: null },
    { name: "Kantong plastik", qty: 1, unit_price: null, total: null },
  ],
  subtotal: 45000, discount: 0, tax: 0, total: "Rp 45.000",
};

let app: FastifyInstance;
let owner = "", other = "";
const cookieOf = (r: LightMyRequestResponse) => `cr_session=${r.cookies.find((c) => c.name === "cr_session")!.value}`;
const req = (method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
const scan = (cookie = owner, body: object = { imageBase64: jpeg64, mimeType: "image/jpeg" }) => req("POST", "/api/scans", cookie, body);
const filesIn = (p: string) => (existsSync(p) ? readdirSync(p, { recursive: true }).filter((f) => String(f).includes(".")) : []);

before(async () => {
  runMigrations();
  app = await buildApp();
  owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/setup",
    payload: { householdName: "Rumah A", name: "A", email: "a@t.id", password: "password-a1" } }));
  sqlite.prepare("INSERT INTO households (id, name) VALUES ('hh-b', 'Rumah B')").run();
  sqlite.prepare("INSERT INTO users (id, household_id, email, name, password_hash, role) VALUES ('u-b','hh-b','b@t.id','B',?, 'owner')").run(await hashPassword("password-b1"));
  other = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "b@t.id", password: "password-b1" } }));
});
beforeEach(() => {
  fake.ocr = { body: OCR_OK };
  fake.archive = { body: { fileId: "drive-file-123", webViewLink: "https://drive.google.com/file/d/drive-file-123/view" } };
  fake.calls = [];
});
after(async () => {
  await app.close();
  sqlite.close();
  n8n.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("scan → review → simpan", () => {
  let scanId = "";
  let result: any;

  it("OCR sukses: hasil dinormalisasi, kategori dicocokkan, secret terkirim", async () => {
    const res = await scan();
    assert.equal(res.statusCode, 201, res.body);
    const b = res.json();
    scanId = b.scanId;
    result = b.result;
    assert.equal(b.mock, false);
    assert.equal(result.merchant, "Indomaret Rungkut");
    assert.equal(result.total, 45000); // "Rp 45.000" → 45000
    assert.equal(result.items.length, 2); // item tanpa harga dibuang
    assert.deepEqual(result.items[1], { name: "Indomie Goreng", qty: 5, unitPrice: 3100, total: 15500 });
    assert.ok(result.categoryId, "kategori 'belanja dapur' harus cocok (case-insensitive)");
    const call = fake.calls.find((c) => c.path === "/ocr")!;
    assert.equal(call.secret, SECRET);
    assert.ok(call.body.categories.includes("Belanja Dapur"));
    assert.match(call.body.today, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("respons ke browser tidak membocorkan secret / URL n8n", async () => {
    const res = await scan();
    assert.ok(!res.body.includes(SECRET));
    assert.ok(!res.body.includes(String(port)));
    await req("DELETE", `/api/scans/${res.json().scanId}`, owner);
  });

  it("preview foto bisa diambil pemiliknya, tidak oleh household lain", async () => {
    const mine = await req("GET", `/api/scans/${scanId}/image`, owner);
    assert.equal(mine.statusCode, 200);
    assert.equal(mine.headers["content-type"], "image/jpeg");
    assert.equal((await req("GET", `/api/scans/${scanId}/image`, other)).statusCode, 404);
  });

  it("household lain tidak bisa menyimpan sesi scan milik A (404)", async () => {
    const res = await req("POST", `/api/scans/${scanId}/commit`, other, { amount: 45000, occurredOn: "2026-10-14", items: [] });
    assert.equal(res.statusCode, 404);
  });

  it("simpan: langsung 201 (arsip pending), lalu foto diarsip ke Drive di background & file lokal dihapus", async () => {
    fake.archive.delayMs = 300; // arsip lambat tidak boleh menahan respons simpan
    const t0 = Date.now();
    const res = await req("POST", `/api/scans/${scanId}/commit`, owner, {
      amount: 45000, occurredOn: "2026-10-14", categoryId: result.categoryId, merchant: "Indomaret Rungkut",
      items: result.items,
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().receiptStatus, "pending");
    assert.ok(Date.now() - t0 < 250, "respons simpan tidak menunggu Drive");
    const txId = res.json().transactionId;
    assert.equal((await req("GET", `/api/transactions/${txId}`, owner)).json().receipt.status, "pending");
    await drainArchives();

    const arch = fake.calls.find((c) => c.path === "/archive")!;
    assert.equal(arch.secret, SECRET);
    assert.equal(arch.body.fileName, `2026-10-14_Indomaret-Rungkut_${txId.slice(0, 8)}.jpg`);
    assert.equal(Buffer.from(arch.body.imageBase64, "base64").length, JPEG.length);

    const detail = (await req("GET", `/api/transactions/${txId}`, owner)).json();
    assert.equal(detail.items.length, 2);
    assert.equal(detail.receipt.status, "archived");
    assert.match(detail.receipt.url, /^https:\/\/drive\.google\.com\//);
    const list = (await req("GET", "/api/transactions?month=2026-10", owner)).json().items;
    assert.equal(list[0].source, "scan");
    assert.equal(filesIn(join(dir, "receipts")).length, 0, "file lokal harus terhapus setelah arsip");
  });

  it("sesi yang sudah disimpan tidak bisa disimpan dua kali (404)", async () => {
    const res = await req("POST", `/api/scans/${scanId}/commit`, owner, { amount: 1, occurredOn: "2026-10-14", items: [] });
    assert.equal(res.statusCode, 404);
  });
});

describe("arsip Drive gagal → coba ulang", () => {
  it("arsip error: transaksi tetap tersimpan, status failed, foto tetap di server; retry berhasil", async () => {
    const s = (await scan()).json();
    fake.archive = { status: 500, body: { message: "drive down" } };
    const res = await req("POST", `/api/scans/${s.scanId}/commit`, owner, { amount: 45000, occurredOn: "2026-10-15", items: [] });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().receiptStatus, "pending");
    const txId = res.json().transactionId;
    await drainArchives();
    assert.equal((await req("GET", `/api/transactions/${txId}`, owner)).json().receipt.status, "failed");

    const img = await req("GET", `/api/transactions/${txId}/receipt`, owner);
    assert.equal(img.statusCode, 200);
    assert.equal((await req("GET", `/api/transactions/${txId}/receipt`, other)).statusCode, 404);

    fake.archive = { body: { fileId: "f2", webViewLink: "https://drive.google.com/file/d/f2/view" } };
    const retry = await req("POST", `/api/transactions/${txId}/receipt/archive`, owner, {});
    assert.equal(retry.json().receiptStatus, "archived");
  });

  it("balasan arsip tanpa webViewLink dianggap gagal", async () => {
    const s = (await scan()).json();
    fake.archive = { body: { ok: true } };
    const res = await req("POST", `/api/scans/${s.scanId}/commit`, owner, { amount: 1000, occurredOn: "2026-10-15", items: [] });
    await drainArchives();
    assert.equal((await req("GET", `/api/transactions/${res.json().transactionId}`, owner)).json().receipt.status, "failed");
  });

  it("pemulihan: pending yang macet (server restart) dilanjutkan; failed hanya bila includeFailed", async () => {
    const s = (await scan()).json();
    fake.archive = { status: 500, body: {} };
    const txId = (await req("POST", `/api/scans/${s.scanId}/commit`, owner, { amount: 2000, occurredOn: "2026-10-15", items: [] })).json().transactionId;
    await drainArchives(); // → failed
    fake.archive = { body: { fileId: "f3", webViewLink: "https://drive.google.com/file/d/f3/view" } };

    assert.equal(await resumeArchives(), 0, "failed tidak dicoba ulang tanpa includeFailed");
    // Simulasi server mati di tengah arsip: status pending, dibuat 10 menit lalu.
    sqlite.prepare("UPDATE transactions SET receipt_status = 'pending', created_at = ? WHERE id = ?").run(Date.now() - 600_000, txId);
    assert.equal(await resumeArchives(), 1);
    assert.equal((await req("GET", `/api/transactions/${txId}`, owner)).json().receipt.status, "archived");
  });
});

describe("validasi & kegagalan OCR", () => {
  it("bukan gambar (magic bytes salah) → 400", async () => {
    const res = await scan(owner, { imageBase64: Buffer.from("halo bukan gambar ini").toString("base64"), mimeType: "image/jpeg" });
    assert.equal(res.statusCode, 400);
    assert.equal(fake.calls.length, 0, "tidak boleh memanggil n8n");
  });
  it("PNG diklaim sebagai JPEG → 400", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64");
    assert.equal((await scan(owner, { imageBase64: png, mimeType: "image/jpeg" })).statusCode, 400);
  });
  it("mime tidak didukung → 400", async () => {
    assert.equal((await scan(owner, { imageBase64: jpeg64, mimeType: "application/pdf" })).statusCode, 400);
  });
  it("gambar > 5 MB → 413", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024 + 10)]).toString("base64");
    assert.equal((await scan(owner, { imageBase64: big, mimeType: "image/jpeg" })).statusCode, 413);
  });
  it("tanpa login → 401", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/scans", payload: {} })).statusCode, 401);
  });
  it("nota tidak terbaca (error dari OCR) → 422, foto dibuang", async () => {
    fake.ocr = { body: { error: "Struk tidak dapat dibaca" } };
    const before = filesIn(join(dir, "receipts")).length;
    const res = await scan();
    assert.equal(res.statusCode, 422);
    assert.equal(filesIn(join(dir, "receipts")).length, before);
  });
  it("n8n error 500 → 502", async () => {
    fake.ocr = { status: 500, body: {} };
    assert.equal((await scan()).statusCode, 502);
  });
  it("balasan OCR format aneh → 502", async () => {
    fake.ocr = { body: { items: "bukan array" } };
    assert.equal((await scan()).statusCode, 502);
  });
  it("tanggal OCR tidak valid → null (user isi sendiri saat review)", async () => {
    fake.ocr = { body: { ...OCR_OK, date: "2026-02-31" } };
    const r = (await scan()).json();
    assert.equal(r.result.date, null);
    await req("DELETE", `/api/scans/${r.scanId}`, owner);
  });
  it("commit dengan kategori household lain → 400", async () => {
    const s = (await scan()).json();
    const bCat = (await req("GET", "/api/categories", other)).json().categories[0].id;
    const res = await req("POST", `/api/scans/${s.scanId}/commit`, owner, { amount: 1, occurredOn: "2026-10-15", categoryId: bCat, items: [] });
    assert.equal(res.statusCode, 400);
    await req("DELETE", `/api/scans/${s.scanId}`, owner);
  });
});

describe("batal & kedaluwarsa", () => {
  it("batal: foto dihapus, tidak ada panggilan ke arsip", async () => {
    const s = (await scan()).json();
    const files = filesIn(join(dir, "receipts")).length;
    assert.equal((await req("DELETE", `/api/scans/${s.scanId}`, owner)).statusCode, 200);
    assert.equal(filesIn(join(dir, "receipts")).length, files - 1);
    assert.ok(!fake.calls.some((c) => c.path === "/archive"));
    assert.equal((await req("DELETE", `/api/scans/${s.scanId}`, owner)).statusCode, 404);
  });
  it("sesi pending > 24 jam dibersihkan otomatis", async () => {
    const s = (await scan()).json();
    sqlite.prepare("UPDATE receipt_scans SET created_at = ? WHERE id = ?").run(Date.now() - 25 * 3600 * 1000, s.scanId);
    assert.equal(await purgeStaleScans(), 1);
    const row = sqlite.prepare("SELECT status, image_path FROM receipt_scans WHERE id = ?").get(s.scanId) as { status: string; image_path: string | null };
    assert.deepEqual(row, { status: "expired", image_path: null });
  });
});
