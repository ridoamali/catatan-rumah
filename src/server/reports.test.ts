import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const dir = mkdtempSync(join(tmpdir(), "cr-rep-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(dir, "test.db");

const { runMigrations, sqlite } = await import("./db/client.js");
const { buildApp } = await import("./app.js");
const { hashPassword } = await import("./auth/crypto.js");
const { todayIn } = await import("./finance/dates.js");
const { monthsBetween } = await import("./routes/reports.js");

let app: FastifyInstance;
let owner = "", member = "", other = "";
const cookieOf = (r: LightMyRequestResponse) => `cr_session=${r.cookies.find((c) => c.name === "cr_session")!.value}`;
const req = (method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
const get = (url: string, c = owner) => req("GET", url, c);

before(async () => {
  runMigrations();
  app = await buildApp();
  owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/setup",
    payload: { householdName: "Rumah A", name: "Rido", email: "a@t.id", password: "password-a1" } }));
  const code = (await req("POST", "/api/household/invites", owner, {})).json().code;
  member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/join",
    payload: { code, name: "Istri", email: "m@t.id", password: "password-m1" } }));
  sqlite.prepare("INSERT INTO households (id, name) VALUES ('hh-b', 'Rumah B')").run();
  sqlite.prepare("INSERT INTO users (id, household_id, email, name, password_hash, role) VALUES ('u-b','hh-b','b@t.id','B',?, 'owner')").run(await hashPassword("password-b1"));
  other = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "b@t.id", password: "password-b1" } }));

  const cats = (await get("/api/categories")).json().categories as { id: string; name: string; kind: string }[];
  const cat = (n: string, k = "expense") => cats.find((c) => c.name === n && c.kind === k)!.id;
  const add = async (c: string, body: object) => {
    const r = await req("POST", "/api/transactions", c, body);
    assert.equal(r.statusCode, 201, r.body);
    return r.json().transaction.id as string;
  };
  await add(owner, { kind: "income", amount: 10_000_000, occurredOn: "2026-08-01", categoryId: cat("Gaji", "income") });
  await add(owner, { kind: "income", amount: 10_000_000, occurredOn: "2026-10-01", categoryId: cat("Gaji", "income") });
  const t1 = await add(owner, { kind: "expense", amount: 300_000, occurredOn: "2026-08-05", categoryId: cat("Belanja Dapur"), merchant: "Indomaret" });
  const t2 = await add(member, { kind: "expense", amount: 200_000, occurredOn: "2026-10-03", categoryId: cat("Belanja Dapur"), merchant: "indomaret " });
  await add(member, { kind: "expense", amount: 150_000, occurredOn: "2026-10-04", categoryId: cat("Makan di Luar"), merchant: "Bakso" });
  await add(owner, { kind: "expense", amount: 50_000, occurredOn: "2026-10-05" });
  const del = await add(owner, { kind: "expense", amount: 999_999, occurredOn: "2026-10-06", merchant: "Indomaret" });
  await req("DELETE", `/api/transactions/${del}`, owner);
  await add(owner, { kind: "expense", amount: 70_000, occurredOn: "2026-04-01", merchant: "Di luar rentang" });

  // Rincian item (biasanya dari scan nota) — langsung ke DB.
  const hid = (sqlite.prepare("SELECT household_id FROM users WHERE email='a@t.id'").get() as { household_id: string }).household_id;
  const item = sqlite.prepare("INSERT INTO transaction_items (id, transaction_id, household_id, position, name, qty, unit_price, total) VALUES (?,?,?,?,?,?,?,?)");
  item.run("i1", t1, hid, 0, "Telur Ayam 1kg", 1, 27000, 27000);
  item.run("i2", t1, hid, 1, "Beras 5kg", 1, 72000, 72000);
  item.run("i3", t2, hid, 0, "telur ayam 1kg", 2, null, 59000); // harga satuan dihitung dari total/qty = 29.500
  item.run("i4", t2, hid, 1, "Minyak 2L", 1, 36900, 36900);
});
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("laporan", () => {
  it("monthsBetween menangani pergantian tahun", () => {
    assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("default: 6 bulan terakhir sampai bulan ini", async () => {
    const r = (await get("/api/reports")).json();
    const cur = todayIn().slice(0, 7);
    assert.equal(r.months.length, 6);
    assert.equal(r.to, cur);
  });

  it("tren bulanan: nol-fill, total & rata-rata benar, transaksi terhapus/di luar rentang tidak dihitung", async () => {
    const r = (await get("/api/reports?from=2026-08&to=2026-10")).json();
    assert.deepEqual(r.monthly, [
      { month: "2026-08", expense: 300_000, income: 10_000_000 },
      { month: "2026-09", expense: 0, income: 0 },
      { month: "2026-10", expense: 400_000, income: 10_000_000 },
    ]);
    assert.deepEqual(r.totals, { expense: 700_000, income: 20_000_000, net: 19_300_000, avgMonthlyExpense: 233_333 });
  });

  it("per kategori (urut terbesar) termasuk 'Tanpa kategori'", async () => {
    const r = (await get("/api/reports?from=2026-08&to=2026-10")).json();
    assert.deepEqual(r.byCategory.map((c: { name: string; total: number }) => [c.name, c.total]), [
      ["Belanja Dapur", 500_000], ["Makan di Luar", 150_000], ["Tanpa kategori", 50_000],
    ]);
  });

  it("per anggota", async () => {
    const r = (await get("/api/reports?from=2026-08&to=2026-10", member)).json();
    // Total sama → urut nama (deterministik).
    assert.deepEqual(r.byMember.map((m: { name: string; total: number; count: number }) => [m.name, m.total, m.count]), [
      ["Istri", 350_000, 2], ["Rido", 350_000, 2],
    ]);
  });

  it("toko teratas menggabungkan beda huruf besar/spasi", async () => {
    const r = (await get("/api/reports?from=2026-08&to=2026-10")).json();
    assert.equal(r.topMerchants[0].total, 500_000);
    assert.equal(r.topMerchants[0].count, 2);
    assert.match(r.topMerchants[0].name, /indomaret/i);
  });

  it("perubahan harga: hanya barang dibeli ≥2x, harga satuan dari total/qty bila kosong", async () => {
    const r = (await get("/api/reports?from=2026-08&to=2026-10")).json();
    assert.equal(r.itemPrices.length, 1);
    const telur = r.itemPrices[0];
    assert.equal(telur.times, 2);
    assert.equal(telur.firstPrice, 27_000);
    assert.equal(telur.lastPrice, 29_500);
    assert.equal(telur.changePct, 9.3);
    assert.equal(telur.firstOn, "2026-08-05");
  });

  it("household lain tidak melihat data A", async () => {
    const r = (await get("/api/reports?from=2026-08&to=2026-10", other)).json();
    assert.equal(r.totals.expense, 0);
    assert.equal(r.byCategory.length, 0);
    assert.equal(r.itemPrices.length, 0);
  });

  it("validasi: from > to, > 24 bulan, format salah → 400; tanpa login → 401", async () => {
    assert.equal((await get("/api/reports?from=2026-10&to=2026-08")).statusCode, 400);
    assert.equal((await get("/api/reports?from=2024-01&to=2026-10")).statusCode, 400);
    assert.equal((await get("/api/reports?from=2026-13")).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/reports" })).statusCode, 401);
  });
});
