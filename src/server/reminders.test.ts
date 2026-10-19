// Tes API pengingat: CRUD, validasi, isolation household, recurring, auth.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const dir = mkdtempSync(join(tmpdir(), "cr-rem-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(dir, "test.db");

const { runMigrations, sqlite } = await import("./db/client.js");
const { buildApp } = await import("./app.js");
const { hashPassword } = await import("./auth/crypto.js");

let app: FastifyInstance;
const cookieOf = (res: LightMyRequestResponse) => `cr_session=${res.cookies.find((c) => c.name === "cr_session")!.value}`;
const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });

let owner = "", member = "", other = "";

before(async () => {
  runMigrations();
  app = await buildApp();
  owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/setup",
    payload: { householdName: "Rumah A", name: "Owner A", email: "a@test.id", password: "password-a1" } }));
  const code = (await req("POST", "/api/household/invites", owner, {})).json().code;
  member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/join",
    payload: { code, name: "Member A", email: "m@test.id", password: "password-m1" } }));
  // Household B (login langsung).
  const hash = await hashPassword("password-b1");
  sqlite.prepare("INSERT INTO households (id, name) VALUES ('hh-b', 'Rumah B')").run();
  sqlite.prepare("INSERT INTO users (id, household_id, email, name, password_hash, role) VALUES ('u-b','hh-b','b@test.id','Owner B',?, 'owner')").run(hash);
  other = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "b@test.id", password: "password-b1" } }));
});
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("pengingat — auth & validasi", () => {
  it("tanpa login → 401", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/reminders" })).statusCode, 401);
  });
  it("judul kosong → 400", async () => {
    const res = await req("POST", "/api/reminders", owner, { title: "  ", dueDate: "2026-11-01" });
    assert.equal(res.statusCode, 400);
  });
  it("tanggal bukan YYYY-MM-DD → 400", async () => {
    for (const bad of ["01-11-2026", "2026-13-01", "2026-11-31", "20261101"]) {
      const res = await req("POST", "/api/reminders", owner, { title: "X", dueDate: bad });
      assert.equal(res.statusCode, 400, bad);
    }
  });
  it("tanggal terlalu jauh (>5 tahun) → 400", async () => {
    const res = await req("POST", "/api/reminders", owner, { title: "X", dueDate: "2262-01-01" });
    assert.equal(res.statusCode, 400);
  });
  it("nominal negatif / non-bulat → 400", async () => {
    assert.equal((await req("POST", "/api/reminders", owner, { title: "X", dueDate: "2026-11-01", amount: -5 })).statusCode, 400);
    assert.equal((await req("POST", "/api/reminders", owner, { title: "X", dueDate: "2026-11-01", amount: 10.5 })).statusCode, 400);
  });
  it("repeat selain enum → 400", async () => {
    assert.equal((await req("POST", "/api/reminders", owner, { title: "X", dueDate: "2026-11-01", repeat: "weekly" })).statusCode, 400);
  });
  it("nominal nol dan absen diterima (null)", async () => {
    const a = await req("POST", "/api/reminders", owner, { title: "Tanpa nominal", dueDate: "2026-11-01" });
    assert.equal(a.statusCode, 201);
    assert.equal(a.json().reminder.amount, null);
    const b = await req("POST", "/api/reminders", owner, { title: "Nol", dueDate: "2026-11-02", amount: 0 });
    assert.equal(b.statusCode, 400); // amount harus > 0 bila diisi
  });
});

describe("pengingat — CRUD", () => {
  let id = "";
  it("membuat → 201 dengan view", async () => {
    const res = await req("POST", "/api/reminders", member, {
      title: "Listrik PLN", amount: 350000, dueDate: "2026-11-05", repeat: "monthly", note: "Token",
    });
    assert.equal(res.statusCode, 201);
    const r = res.json().reminder;
    id = r.id;
    assert.equal(r.title, "Listrik PLN");
    assert.equal(r.repeat, "monthly");
    assert.equal(r.status, "active");
  });
  it("muncul di daftar household", async () => {
    const items = (await req("GET", "/api/reminders", owner)).json().items;
    assert.ok(items.some((x: { id: string }) => x.id === id));
  });
  it("edit judul & catatan → 200", async () => {
    const res = await req("PATCH", `/api/reminders/${id}`, owner, { title: "Listrik Token", note: "Catat meter" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reminder.title, "Listrik Token");
    assert.equal(res.json().reminder.note, "Catat meter");
  });
  it("hapus → 204 lalu 404", async () => {
    const del = await req("DELETE", `/api/reminders/${id}`, owner);
    assert.equal(del.statusCode, 204);
    assert.equal((await req("PATCH", `/api/reminders/${id}`, owner, { title: "X" })).statusCode, 404);
    assert.equal((await req("DELETE", `/api/reminders/${id}`, owner)).statusCode, 404);
  });
});

describe("pengingat — isolation household", () => {
  let idA = "";
  it("household B tidak melihat & tidak bisa mengubah milik A", async () => {
    idA = (await req("POST", "/api/reminders", owner, { title: "Milik A", dueDate: "2026-11-05" })).json().reminder.id;
    const listB = (await req("GET", "/api/reminders", other)).json().items;
    assert.equal(listB.length, 0);
    assert.equal((await req("PATCH", `/api/reminders/${idA}`, other, { title: "Direbut" })).statusCode, 404);
    assert.equal((await req("DELETE", `/api/reminders/${idA}`, other)).statusCode, 404);
    // A masih utuh (cari berdasarkan id, urutan list berdasarkan dueDate)
    const mine = (await req("GET", "/api/reminders", owner)).json().items.find((x: { id: string }) => x.id === idA);
    assert.equal(mine.title, "Milik A");
  });
});

describe("pengingat — selesai & berulang", () => {
  it("sekali selesai → status done, tetap di daftar", async () => {
    const r = (await req("POST", "/api/reminders", owner, { title: "BPJS", amount: 200000, dueDate: "2026-11-10" })).json().reminder;
    const done = (await req("PATCH", `/api/reminders/${r.id}`, owner, { status: "done" })).json().reminder;
    assert.equal(done.status, "done");
    const list = (await req("GET", "/api/reminders", owner)).json().items;
    assert.ok(list.some((x: { id: string; status: string }) => x.id === r.id && x.status === "done"));
  });
  it("tandai selesai TIDAK membuat transaksi", async () => {
    const txs = (await req("GET", "/api/transactions", owner)).json();
    assert.equal(txs.totals.count, 0);
  });
  it("bulanan selesai → view menunjukkan siklus berikutnya; buka kembali kembali ke siklus baru", async () => {
    const r = (await req("POST", "/api/reminders", owner, { title: "Sewa", amount: 1500000, dueDate: "2026-11-01", repeat: "monthly" })).json().reminder;
    const done = (await req("PATCH", `/api/reminders/${r.id}`, owner, { status: "done" })).json().reminder;
    assert.equal(done.status, "done");
    assert.equal(done.dueDate, "2026-12-01"); // siklus berikutnya
    const reopen = (await req("PATCH", `/api/reminders/${r.id}`, owner, { status: "active" })).json().reminder;
    assert.equal(reopen.status, "active");
    assert.equal(reopen.dueDate, "2026-12-01");
  });
  it("edit partial tidak mengubah field lain", async () => {
    const r = (await req("POST", "/api/reminders", owner, { title: "Internet", amount: 300000, dueDate: "2026-11-15", repeat: "monthly" })).json().reminder;
    const patched = (await req("PATCH", `/api/reminders/${r.id}`, owner, { note: "Speedy" })).json().reminder;
    assert.equal(patched.amount, 300000);
    assert.equal(patched.repeat, "monthly");
    assert.equal(patched.note, "Speedy");
  });
  it("edit semua field (alur UI Edit) — judul, nominal, tanggal, catatan, pengulangan", async () => {
    const r = (await req("POST", "/api/reminders", member, { title: "Listrik", amount: 350000, dueDate: "2026-11-05" })).json().reminder;
    const patched = (await req("PATCH", `/api/reminders/${r.id}`, member, {
      title: "Listrik Token", amount: 400000, dueDate: "2026-11-10", repeat: "monthly", note: "Token 100k",
    })).json().reminder;
    assert.equal(patched.title, "Listrik Token");
    assert.equal(patched.amount, 400000);
    assert.equal(patched.dueDate, "2026-11-10");
    assert.equal(patched.repeat, "monthly");
    assert.equal(patched.note, "Token 100k");
    assert.equal(patched.status, "active");
  });
  it("edit mengosongkan nominal opsional → null", async () => {
    const r = (await req("POST", "/api/reminders", member, { title: "Sumbangan", amount: 50000, dueDate: "2026-11-08" })).json().reminder;
    const patched = (await req("PATCH", `/api/reminders/${r.id}`, member, { amount: null })).json().reminder;
    assert.equal(patched.amount, null);
    assert.equal(patched.title, "Sumbangan"); // field lain tetap
  });
  it("edit mengubah pengulangan none → monthly; siklus tetap di dueDate sampai selesai", async () => {
    const r = (await req("POST", "/api/reminders", member, { title: "Iuran", dueDate: "2026-11-12" })).json().reminder;
    const patched = (await req("PATCH", `/api/reminders/${r.id}`, member, { repeat: "monthly" })).json().reminder;
    assert.equal(patched.repeat, "monthly");
    assert.equal(patched.dueDate, "2026-11-12"); // belum ada siklus selesai
    const done = (await req("PATCH", `/api/reminders/${r.id}`, member, { status: "done" })).json().reminder;
    assert.equal(done.dueDate, "2026-12-12"); // siklus berikutnya dari completedDueDate
  });
  it("edit validasi tetap berlaku: tanggal buruk & nominal negatif → 400, data tak berubah", async () => {
    const r = (await req("POST", "/api/reminders", member, { title: "Air", amount: 20000, dueDate: "2026-11-09" })).json().reminder;
    assert.equal((await req("PATCH", `/api/reminders/${r.id}`, member, { dueDate: "09-11-2026" })).statusCode, 400);
    assert.equal((await req("PATCH", `/api/reminders/${r.id}`, member, { amount: -1 })).statusCode, 400);
    const after = (await req("GET", "/api/reminders", member)).json().items.find((x: { id: string }) => x.id === r.id);
    assert.equal(after.dueDate, "2026-11-09");
    assert.equal(after.amount, 20000);
  });
  it("urutan daftar berdasar jatuh tempo", async () => {
    await req("POST", "/api/reminders", owner, { title: "C", dueDate: "2026-11-20" });
    await req("POST", "/api/reminders", owner, { title: "A", dueDate: "2026-11-03" });
    const dates = (await req("GET", "/api/reminders", owner)).json().items.map((x: { dueDate: string }) => x.dueDate);
    const sorted = [...dates].sort((a: string, b: string) => a.localeCompare(b));
    assert.deepEqual(dates, sorted);
    assert.ok(dates.includes("2026-11-03") && dates.includes("2026-11-20"));
  });
});
