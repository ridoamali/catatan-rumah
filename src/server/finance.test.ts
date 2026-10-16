import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const dir = mkdtempSync(join(tmpdir(), "cr-fin-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(dir, "test.db");

const { runMigrations, sqlite } = await import("./db/client.js");
const { buildApp } = await import("./app.js");
const { hashPassword } = await import("./auth/crypto.js");

let app: FastifyInstance;
const cookieOf = (res: LightMyRequestResponse) => `cr_session=${res.cookies.find((c) => c.name === "cr_session")!.value}`;
const req = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });

let owner = "", member = "", other = "";
let cats: { id: string; name: string; kind: string }[] = [];
const cat = (name: string, kind = "expense") => cats.find((c) => c.name === name && c.kind === kind)!.id;

before(async () => {
  runMigrations();
  app = await buildApp();
  // Household A: owner + member (lewat undangan)
  owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/setup",
    payload: { householdName: "Rumah A", name: "Owner A", email: "a@test.id", password: "password-a1" } }));
  const code = (await req("POST", "/api/household/invites", owner, {})).json().code;
  member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/join",
    payload: { code, name: "Member A", email: "m@test.id", password: "password-m1" } }));
  // Household B dibuat langsung di DB (setup publik hanya sekali), lalu login biasa.
  const hash = await hashPassword("password-b1");
  sqlite.prepare("INSERT INTO households (id, name) VALUES ('hh-b', 'Rumah B')").run();
  sqlite.prepare("INSERT INTO users (id, household_id, email, name, password_hash, role) VALUES ('u-b','hh-b','b@test.id','Owner B',?, 'owner')").run(hash);
  other = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "b@test.id", password: "password-b1" } }));
  cats = (await req("GET", "/api/categories", owner)).json().categories;
});
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("kategori", () => {
  it("kategori default terisi saat setup (11 pengeluaran + 3 pemasukan)", () => {
    assert.equal(cats.filter((c) => c.kind === "expense").length, 11);
    assert.equal(cats.filter((c) => c.kind === "income").length, 3);
  });
  it("tanpa login → 401", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/categories" })).statusCode, 401);
  });
  it("nama kategori duplikat → 409", async () => {
    assert.equal((await req("POST", "/api/categories", owner, { name: "Belanja Dapur", kind: "expense" })).statusCode, 409);
  });
  it("membuat kategori baru → 201", async () => {
    const res = await req("POST", "/api/categories", member, { name: "Hewan Peliharaan", kind: "expense" });
    assert.equal(res.statusCode, 201);
    cats.push(res.json().category);
  });
  it("household lain punya kategori sendiri, tidak melihat milik A", async () => {
    const b = (await req("GET", "/api/categories", other)).json().categories;
    assert.equal(b.length, 14);
    assert.ok(!b.some((c: { id: string }) => cats.some((a) => a.id === c.id)));
  });
});

describe("transaksi", () => {
  let txId = "";
  it("membuat pengeluaran → 201, source=web, userId pencatat", async () => {
    const res = await req("POST", "/api/transactions", owner, {
      kind: "expense", amount: 72000, occurredOn: "2026-10-14", categoryId: cat("Belanja Dapur"), merchant: "Indomaret",
    });
    assert.equal(res.statusCode, 201);
    const t = res.json().transaction;
    assert.equal(t.source, "web");
    assert.equal(t.amount, 72000);
    txId = t.id;
  });

  it("validasi: nominal desimal/negatif, tanggal tidak ada → 400", async () => {
    for (const body of [
      { kind: "expense", amount: 10.5, occurredOn: "2026-10-01" },
      { kind: "expense", amount: -5, occurredOn: "2026-10-01" },
      { kind: "expense", amount: 1000, occurredOn: "2026-02-30" },
      { kind: "transfer", amount: 1000, occurredOn: "2026-10-01" },
    ]) {
      assert.equal((await req("POST", "/api/transactions", owner, body)).statusCode, 400, JSON.stringify(body));
    }
  });

  it("kategori pemasukan untuk pengeluaran → 400", async () => {
    const res = await req("POST", "/api/transactions", owner, { kind: "expense", amount: 1000, occurredOn: "2026-10-01", categoryId: cat("Gaji", "income") });
    assert.equal(res.statusCode, 400);
  });

  it("kategori milik household lain → 400", async () => {
    const bCat = (await req("GET", "/api/categories", other)).json().categories[0].id;
    const res = await req("POST", "/api/transactions", owner, { kind: "expense", amount: 1000, occurredOn: "2026-10-01", categoryId: bCat });
    assert.equal(res.statusCode, 400);
  });

  it("data seed: pemasukan, tanpa kategori, batas bulan, bulan lalu", async () => {
    const add = (c: string, b: object) => req("POST", "/api/transactions", c, b);
    assert.equal((await add(member, { kind: "income", amount: 10_000_000, occurredOn: "2026-10-01", categoryId: cat("Gaji", "income") })).statusCode, 201);
    assert.equal((await add(member, { kind: "expense", amount: 50_000, occurredOn: "2026-10-31", merchant: "Diskon 100% Toko_X" })).statusCode, 201);
    assert.equal((await add(owner, { kind: "expense", amount: 30_000, occurredOn: "2026-11-01", categoryId: cat("Transportasi") })).statusCode, 201);
    assert.equal((await add(owner, { kind: "expense", amount: 400_000, occurredOn: "2026-09-20", categoryId: cat("Makan di Luar") })).statusCode, 201);
  });

  it("daftar per bulan menghormati batas bulan + total benar", async () => {
    const body = (await req("GET", "/api/transactions?month=2026-10", member)).json();
    assert.equal(body.items.length, 3);
    assert.deepEqual(body.totals, { income: 10_000_000, expense: 122_000, count: 3 });
    assert.equal(body.items[0].occurredOn, "2026-10-31"); // urut terbaru dulu
    assert.equal(body.items.find((i: { id: string }) => i.id === txId).categoryName, "Belanja Dapur");
  });

  it("pencarian memperlakukan % dan _ secara literal", async () => {
    const a = (await req("GET", "/api/transactions?q=100%25", owner)).json().items;
    assert.equal(a.length, 1);
    const b = (await req("GET", "/api/transactions?q=Toko_X", owner)).json().items;
    assert.equal(b.length, 1);
    const c = (await req("GET", "/api/transactions?q=_", owner)).json().items;
    assert.equal(c.length, 1);
  });

  it("filter tanpa kategori", async () => {
    const items = (await req("GET", "/api/transactions?month=2026-10&categoryId=none", owner)).json().items;
    assert.equal(items.length, 1);
  });

  it("household lain: tidak melihat, tidak bisa ubah/hapus (404)", async () => {
    assert.equal((await req("GET", "/api/transactions?month=2026-10", other)).json().items.length, 0);
    assert.equal((await req("PATCH", `/api/transactions/${txId}`, other, { amount: 1 })).statusCode, 404);
    assert.equal((await req("DELETE", `/api/transactions/${txId}`, other)).statusCode, 404);
  });

  it("edit nominal oleh member lain di household yang sama → 200", async () => {
    const res = await req("PATCH", `/api/transactions/${txId}`, member, { amount: 75000 });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().transaction.amount, 75000);
    assert.ok(res.json().transaction.updatedAt);
  });

  it("ubah jenis jadi pemasukan tapi kategori tetap pengeluaran → 400", async () => {
    assert.equal((await req("PATCH", `/api/transactions/${txId}`, owner, { kind: "income" })).statusCode, 400);
  });

  it("kategori yang diarsipkan tidak bisa dipakai", async () => {
    const id = cat("Hewan Peliharaan");
    assert.equal((await req("PATCH", `/api/categories/${id}`, owner, { archived: true })).statusCode, 200);
    const res = await req("POST", "/api/transactions", owner, { kind: "expense", amount: 1000, occurredOn: "2026-10-02", categoryId: id });
    assert.equal(res.statusCode, 400);
  });
});

describe("anggaran & ringkasan", () => {
  it("member tidak boleh mengatur anggaran (403)", async () => {
    assert.equal((await req("PUT", `/api/budgets/${cat("Belanja Dapur")}`, member, { monthlyAmount: 1_500_000 })).statusCode, 403);
  });
  it("anggaran pada kategori pemasukan → 404", async () => {
    assert.equal((await req("PUT", `/api/budgets/${cat("Gaji", "income")}`, owner, { monthlyAmount: 1 })).statusCode, 404);
  });
  it("owner mengatur dan memperbarui anggaran (upsert)", async () => {
    assert.equal((await req("PUT", `/api/budgets/${cat("Belanja Dapur")}`, owner, { monthlyAmount: 1_000_000 })).statusCode, 200);
    assert.equal((await req("PUT", `/api/budgets/${cat("Belanja Dapur")}`, owner, { monthlyAmount: 1_500_000 })).statusCode, 200);
    assert.equal((await req("PUT", `/api/budgets/${cat("Hiburan")}`, owner, { monthlyAmount: 200_000 })).statusCode, 200);
    const b = (await req("GET", "/api/budgets", member)).json().budgets;
    assert.equal(b.find((x: { name: string }) => x.name === "Belanja Dapur").monthlyAmount, 1_500_000);
  });
  it("monthlyAmount 0 menghapus anggaran", async () => {
    await req("PUT", `/api/budgets/${cat("Hiburan")}`, owner, { monthlyAmount: 0 });
    const b = (await req("GET", "/api/budgets", owner)).json().budgets;
    assert.equal(b.find((x: { name: string }) => x.name === "Hiburan").monthlyAmount, 0);
  });
  it("ringkasan Oktober: total, selisih, bulan lalu, per kategori + tanpa kategori", async () => {
    const s = (await req("GET", "/api/summary?month=2026-10", member)).json();
    assert.equal(s.income, 10_000_000);
    assert.equal(s.expense, 125_000);
    assert.equal(s.net, 9_875_000);
    assert.deepEqual(s.previous, { month: "2026-09", income: 0, expense: 400_000 });
    assert.equal(s.budgetTotal, 1_500_000);
    const dapur = s.byCategory.find((c: { name: string }) => c.name === "Belanja Dapur");
    assert.deepEqual([dapur.spent, dapur.budget], [75_000, 1_500_000]);
    assert.ok(s.byCategory.some((c: { categoryId: string; spent: number }) => c.categoryId === "none" && c.spent === 50_000));
  });
  it("format bulan salah → 400", async () => {
    assert.equal((await req("GET", "/api/summary?month=2026-13", owner)).statusCode, 400);
  });
});

describe("hapus transaksi (soft delete)", () => {
  it("hapus → hilang dari daftar & ringkasan, baris tetap ada dengan deleted_at", async () => {
    const items = (await req("GET", "/api/transactions?month=2026-10&kind=income", owner)).json().items;
    const id = items[0].id;
    assert.equal((await req("DELETE", `/api/transactions/${id}`, member)).statusCode, 200);
    assert.equal((await req("GET", "/api/summary?month=2026-10", owner)).json().income, 0);
    const row = sqlite.prepare("SELECT deleted_at FROM transactions WHERE id = ?").get(id) as { deleted_at: number };
    assert.ok(row.deleted_at > 0);
    assert.equal((await req("DELETE", `/api/transactions/${id}`, member)).statusCode, 404);
  });
});
