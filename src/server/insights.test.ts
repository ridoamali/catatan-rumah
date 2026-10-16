import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const fake = { status: 200, body: {} as unknown, calls: [] as { secret?: string; raw: string }[] };
const n8n: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    fake.calls.push({ secret: req.headers["x-webhook-secret"] as string | undefined, raw });
    res.writeHead(fake.status, { "content-type": "application/json" });
    res.end(JSON.stringify(fake.body));
  });
});
await new Promise<void>((r) => n8n.listen(0, "127.0.0.1", r));
const port = (n8n.address() as { port: number }).port;

const dir = mkdtempSync(join(tmpdir(), "cr-ins-"));
const SECRET = "rahasia-webhook-uji-123";
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(dir, "test.db");
process.env.N8N_INSIGHT_URL = `http://127.0.0.1:${port}/insight`;
process.env.N8N_WEBHOOK_SECRET = SECRET;
process.env.OCR_MOCK = "off";

const { runMigrations, sqlite } = await import("./db/client.js");
const { buildApp } = await import("./app.js");
const { hashPassword } = await import("./auth/crypto.js");
const { mockInsight } = await import("./insights/result.js");
const { buildInsightInput } = await import("./insights/summary.js");
const { todayIn } = await import("./finance/dates.js");

let app: FastifyInstance;
let owner = "", member = "", other = "";
const cookieOf = (r: LightMyRequestResponse) => `cr_session=${r.cookies.find((c) => c.name === "cr_session")!.value}`;
const req = (method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
const OK = {
  summary: "Pengeluaran Oktober naik 50% dari rata-rata.",
  highlights: [{ type: "warning", title: "Belanja Dapur naik", detail: "Naik 50% dari rata-rata 3 bulan.", category: "Belanja Dapur" }],
  anomalies: [{ date: "2026-10-03", merchant: "Superindo", amount: 1_500_000, reason: "Lebih besar dari biasanya." }],
  tips: [{ title: "Belanja mingguan", detail: "Buat daftar belanja mingguan.", estimatedSaving: 200_000 }],
};

before(async () => {
  runMigrations();
  app = await buildApp();
  owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/setup",
    payload: { householdName: "Rumah Rahasia", name: "Rido Pemilik", email: "rido@pribadi.id", password: "password-a1" } }));
  const code = (await req("POST", "/api/household/invites", owner, {})).json().code;
  member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/join",
    payload: { code, name: "Istri Tercinta", email: "istri@pribadi.id", password: "password-m1" } }));
  sqlite.prepare("INSERT INTO households (id, name) VALUES ('hh-b', 'Rumah B')").run();
  sqlite.prepare("INSERT INTO users (id, household_id, email, name, password_hash, role) VALUES ('u-b','hh-b','b@t.id','B',?, 'owner')").run(await hashPassword("password-b1"));
  other = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "b@t.id", password: "password-b1" } }));
});
beforeEach(() => {
  fake.status = 200;
  fake.body = OK;
  fake.calls = [];
});
after(async () => {
  await app.close();
  sqlite.close();
  n8n.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("analisa AI", () => {
  it("GET awal: belum ada analisa, fitur tersedia", async () => {
    const r = (await req("GET", "/api/insights?month=2026-10", owner)).json();
    assert.deepEqual([r.available, r.insight], [true, null]);
  });

  it("bulan tanpa transaksi → 422, AI tidak dipanggil", async () => {
    assert.equal((await req("POST", "/api/insights", owner, { month: "2026-10" })).statusCode, 422);
    assert.equal(fake.calls.length, 0);
  });

  it("seed data", async () => {
    const cats = (await req("GET", "/api/categories", owner)).json().categories as { id: string; name: string; kind: string }[];
    const dapur = cats.find((c) => c.name === "Belanja Dapur")!.id;
    for (const m of ["2026-07", "2026-08", "2026-09"]) {
      await req("POST", "/api/transactions", owner, { kind: "expense", amount: 1_000_000, occurredOn: `${m}-03`, categoryId: dapur, merchant: "Superindo" });
    }
    await req("POST", "/api/transactions", member, {
      kind: "expense", amount: 1_500_000, occurredOn: "2026-10-03", categoryId: dapur, merchant: "Superindo", note: "catatan-pribadi-jangan-dikirim",
    });
    await req("POST", "/api/transactions", owner, { kind: "income", amount: 10_000_000, occurredOn: "2026-10-01" });
    await req("PUT", `/api/budgets/${dapur}`, owner, { monthlyAmount: 1_200_000 });
  });

  it("angka ringkasan dihitung app: +50% vs rata-rata, anggaran 125%", () => {
    const hid = (sqlite.prepare("SELECT household_id FROM users WHERE email='rido@pribadi.id'").get() as { household_id: string }).household_id;
    const input = buildInsightInput(hid, "2026-10");
    const d = input.categories.find((c) => c.name === "Belanja Dapur")!;
    assert.deepEqual([d.spent, d.avgPrev3, d.changeVsAvgPct, d.budgetUsedPct], [1_500_000, 1_000_000, 50, 125]);
    assert.equal(input.avgExpensePrev3, 1_000_000);
    assert.equal(input.expenseChangeVsAvgPct, 50);
    const today = todayIn();
    assert.equal(input.isCurrentMonth, today.startsWith("2026-10"));
    assert.equal(input.daysElapsed, today.startsWith("2026-10") ? Number(today.slice(8, 10)) : 31);
    assert.equal(input.daysInMonth, 31);
  });

  it("POST: panggil n8n dengan secret; payload TANPA catatan, nama/email anggota, nama rumah tangga", async () => {
    const r = await req("POST", "/api/insights", member, { month: "2026-10" });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().insight.result.summary, OK.summary);
    assert.equal(fake.calls.length, 1);
    const { secret, raw } = fake.calls[0];
    assert.equal(secret, SECRET);
    for (const forbidden of ["catatan-pribadi-jangan-dikirim", "pribadi.id", "Rido Pemilik", "Istri Tercinta", "Rumah Rahasia", "household", "userId"]) {
      assert.ok(!raw.includes(forbidden), `payload tidak boleh berisi "${forbidden}"`);
    }
    assert.ok(raw.includes("Superindo"));
  });

  it("GET mengembalikan analisa tersimpan (tanpa memanggil AI lagi)", async () => {
    const r = (await req("GET", "/api/insights?month=2026-10", owner)).json();
    assert.equal(r.insight.result.tips[0].estimatedSaving, 200_000);
    assert.equal(r.insight.mock, false);
    assert.equal(fake.calls.length, 0);
  });

  it("balasan disanitasi: teks dipotong, butir dibatasi, tipe tak dikenal → info", async () => {
    fake.body = {
      summary: "x".repeat(2000),
      highlights: Array.from({ length: 9 }, (_, i) => ({ type: i === 0 ? "danger" : "good", title: `h${i}`, detail: "d" })),
      anomalies: [], tips: [],
    };
    const res = (await req("POST", "/api/insights", owner, { month: "2026-10" })).json().insight.result;
    assert.equal(res.summary.length, 600);
    assert.equal(res.highlights.length, 6);
    assert.equal(res.highlights[0].type, "info");
  });

  it("balasan tanpa summary → 502, tidak disimpan", async () => {
    const before = (sqlite.prepare("SELECT count(*) n FROM insights").get() as { n: number }).n;
    fake.body = { highlights: [] };
    assert.equal((await req("POST", "/api/insights", owner, { month: "2026-10" })).statusCode, 502);
    assert.equal((sqlite.prepare("SELECT count(*) n FROM insights").get() as { n: number }).n, before);
  });

  it("n8n error 500 → 502", async () => {
    fake.status = 500;
    assert.equal((await req("POST", "/api/insights", owner, { month: "2026-10" })).statusCode, 502);
  });

  it("household lain: tidak melihat analisa A, tidak punya data → 422", async () => {
    assert.equal((await req("GET", "/api/insights?month=2026-10", other)).json().insight, null);
    assert.equal((await req("POST", "/api/insights", other, { month: "2026-10" })).statusCode, 422);
  });

  it("validasi bulan & login", async () => {
    assert.equal((await req("GET", "/api/insights?month=2026-13", owner)).statusCode, 400);
    assert.equal((await req("POST", "/api/insights", owner, { month: "okt" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/insights?month=2026-10" })).statusCode, 401);
  });

  it("mode contoh ditandai (CONTOH)", () => {
    const hid = (sqlite.prepare("SELECT household_id FROM users WHERE email='rido@pribadi.id'").get() as { household_id: string }).household_id;
    const m = mockInsight(buildInsightInput(hid, "2026-10"));
    assert.match(m.summary, /^\(CONTOH\)/);
    assert.ok(m.highlights.some((h) => h.title.includes("Belanja Dapur")));
  });
});
