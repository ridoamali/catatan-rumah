import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// Env harus di-set sebelum modul server di-import.
const dir = mkdtempSync(join(tmpdir(), "cr-test-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(dir, "test.db");

const { runMigrations, sqlite } = await import("./db/client.js");
const { buildApp } = await import("./app.js");

let app: FastifyInstance;
const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name === "cr_session");
  return c ? `cr_session=${c.value}` : "";
};
const post = (url: string, payload?: object, cookie = "", headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload, headers: { cookie, ...headers } });
const get = (url: string, cookie = "") => app.inject({ method: "GET", url, headers: { cookie } });

const OWNER = { householdName: "Rumah Uji", name: "Owner", email: "Owner@Example.com", password: "rahasia-123" };
let ownerCookie = "";
let memberCookie = "";

before(async () => {
  runMigrations();
  app = await buildApp();
});
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("setup awal", () => {
  it("status needsSetup=true saat belum ada user", async () => {
    assert.deepEqual((await get("/api/auth/status")).json(), { needsSetup: true });
  });

  it("menolak password terlalu pendek (400)", async () => {
    const res = await post("/api/auth/setup", { ...OWNER, password: "123" });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().fields.password);
  });

  it("membuat household + owner dan memberi cookie sesi httpOnly", async () => {
    const res = await post("/api/auth/setup", OWNER);
    assert.equal(res.statusCode, 201);
    const c = res.cookies.find((x) => x.name === "cr_session")!;
    assert.ok(c.httpOnly);
    assert.equal(c.sameSite, "Lax");
    ownerCookie = cookieOf(res);
  });

  it("setup kedua ditolak (403)", async () => {
    const res = await post("/api/auth/setup", { ...OWNER, email: "lain@example.com" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual((await get("/api/auth/status")).json(), { needsSetup: false });
  });

  it("password & token sesi tidak disimpan mentah", () => {
    const u = sqlite.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    assert.ok(u.password_hash.startsWith("scrypt$"));
    assert.ok(!u.password_hash.includes(OWNER.password));
    const token = ownerCookie.split("=")[1];
    const s = sqlite.prepare("SELECT id FROM sessions").all() as { id: string }[];
    assert.ok(s.every((r) => r.id !== token));
  });
});

describe("login / me / logout", () => {
  it("/me tanpa cookie → 401", async () => {
    assert.equal((await get("/api/auth/me")).statusCode, 401);
  });

  it("/me dengan cookie → data owner (email dinormalisasi lowercase)", async () => {
    const body = (await get("/api/auth/me", ownerCookie)).json();
    assert.equal(body.user.email, "owner@example.com");
    assert.equal(body.user.role, "owner");
    assert.equal(body.household.name, "Rumah Uji");
  });

  it("password salah dan email tak dikenal → 401 dengan pesan sama", async () => {
    const a = await post("/api/auth/login", { email: OWNER.email, password: "salah-salah" });
    const b = await post("/api/auth/login", { email: "tidakada@example.com", password: "salah-salah" });
    assert.equal(a.statusCode, 401);
    assert.equal(b.statusCode, 401);
    assert.equal(a.json().error, b.json().error);
  });

  it("logout mematikan sesi di server", async () => {
    assert.equal((await post("/api/auth/logout", {}, ownerCookie)).statusCode, 200);
    assert.equal((await get("/api/auth/me", ownerCookie)).statusCode, 401);
  });

  it("login ulang berhasil", async () => {
    const res = await post("/api/auth/login", { email: "OWNER@example.com", password: OWNER.password });
    assert.equal(res.statusCode, 200);
    ownerCookie = cookieOf(res);
    assert.equal((await get("/api/auth/me", ownerCookie)).statusCode, 200);
  });
});

describe("undangan anggota", () => {
  let code = "";

  it("tanpa login tidak bisa membuat undangan (401)", async () => {
    assert.equal((await post("/api/household/invites", {})).statusCode, 401);
  });

  it("owner membuat kode undangan format XXXX-XXXX", async () => {
    const res = await post("/api/household/invites", {}, ownerCookie);
    assert.equal(res.statusCode, 201);
    code = res.json().code;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("kode salah → 400", async () => {
    const res = await post("/api/auth/join", { code: "ZZZZ-ZZZZ", name: "X", email: "x@example.com", password: "password-1" });
    assert.equal(res.statusCode, 400);
  });

  it("email yang sudah terdaftar → 409, kode tetap belum terpakai", async () => {
    const res = await post("/api/auth/join", { code, name: "X", email: OWNER.email, password: "password-1" });
    assert.equal(res.statusCode, 409);
  });

  it("gabung dengan kode (huruf kecil, tanpa strip) → member di household yang sama", async () => {
    const res = await post("/api/auth/join", {
      code: code.toLowerCase().replace("-", ""), name: "Istri", email: "istri@example.com", password: "password-1",
    });
    assert.equal(res.statusCode, 201);
    memberCookie = cookieOf(res);
    const me = (await get("/api/auth/me", memberCookie)).json();
    const owner = (await get("/api/auth/me", ownerCookie)).json();
    assert.equal(me.user.role, "member");
    assert.equal(me.household.id, owner.household.id);
  });

  it("kode yang sudah dipakai → 400", async () => {
    const res = await post("/api/auth/join", { code, name: "Y", email: "y@example.com", password: "password-1" });
    assert.equal(res.statusCode, 400);
  });

  it("kode kedaluwarsa → 400", async () => {
    const fresh = (await post("/api/household/invites", {}, ownerCookie)).json().code;
    sqlite.prepare("UPDATE invites SET expires_at = ? WHERE used_at IS NULL").run(Date.now() - 1000);
    const res = await post("/api/auth/join", { code: fresh, name: "Z", email: "z@example.com", password: "password-1" });
    assert.equal(res.statusCode, 400);
  });

  it("member tidak boleh membuat undangan (403)", async () => {
    assert.equal((await post("/api/household/invites", {}, memberCookie)).statusCode, 403);
  });

  it("daftar anggota berisi owner + member, tanpa password_hash", async () => {
    const body = (await get("/api/household/members", memberCookie)).json();
    assert.equal(body.members.length, 2);
    assert.ok(body.members.every((m: object) => !("passwordHash" in m)));
  });
});

describe("keamanan request", () => {
  it("POST dengan Origin asing → 403", async () => {
    const res = await post("/api/auth/login", { email: OWNER.email, password: OWNER.password }, "", {
      origin: "https://evil.example",
    });
    assert.equal(res.statusCode, 403);
  });

  it("POST dari origin dev yang diizinkan → lolos", async () => {
    const res = await post("/api/auth/login", { email: OWNER.email, password: OWNER.password }, "", {
      origin: "http://localhost:5173",
    });
    assert.equal(res.statusCode, 200);
  });

  it("cookie sesi palsu → 401", async () => {
    assert.equal((await get("/api/auth/me", "cr_session=palsu")).statusCode, 401);
  });

  it("brute-force login dibatasi (429)", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await post("/api/auth/login", { email: OWNER.email, password: "salah-salah" }, "", {
        "x-forwarded-for": "10.9.9.9",
      })).statusCode;
    }
    assert.equal(last, 429);
  });
});
