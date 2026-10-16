import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Data uji terpisah; tidak membaca .env dan tidak memanggil webhook asli.
const dir = await mkdtemp(join(tmpdir(), "cr-production-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((e) => e ? reject(e) : resolve()));
const base = `http://127.0.0.1:${port}`;
let child;
let logs = "";

async function start() {
  child = spawn(process.execPath, ["dist-server/index.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
      DATABASE_PATH: join(dir, "test.db"), RECEIPTS_DIR: join(dir, "receipts"),
      ALLOWED_ORIGINS: "https://rumah.example.com", OCR_MOCK: "off",
      N8N_RECEIPT_OCR_URL: "", N8N_RECEIPT_ARCHIVE_URL: "",
      N8N_INSIGHT_URL: "", N8N_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (e) => { logs += String(e); });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (c) => { logs = (logs + c).slice(-8000); });
  }
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      assert.deepEqual(await r.json(), { status: "ok", db: "ok" });
      assert.equal(r.status, 200);
      return;
    } catch { /* tunggu proses siap */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server produksi gagal siap: ${logs}`);
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.kill("SIGTERM");
  try {
    const [code, signal] = await exited;
    assert.equal(code, 0, `Shutdown gagal: ${signal ?? code}`);
  } finally { clearTimeout(timer); }
}

try {
  await start();
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  const route = await fetch(`${base}/overview`);
  assert.equal(route.status, 200);
  assert.match(route.headers.get("content-type"), /text\/html/);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);

  const payload = { householdName: "Smoke Test", name: "Test", email: "smoke@example.test", password: "production-test-123" };
  const setup = (origin) => fetch(`${base}/api/auth/setup`, {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify(payload),
  });
  assert.equal((await setup("https://foreign.example.com")).status, 403);
  const created = await setup("https://rumah.example.com");
  assert.equal(created.status, 201);
  assert.match(created.headers.get("set-cookie"), /; Secure/i);
  assert.match(created.headers.get("set-cookie"), /; HttpOnly/i);
  await stop();

  await start();
  const status = await fetch(`${base}/api/auth/status`);
  assert.equal((await status.json()).needsSetup, false, "Data harus bertahan setelah restart");
  await stop();
  console.log("PASS: server produksi, migrasi, frontend/SPA, API 404, origin, cookie Secure, persistensi, shutdown.");
} finally {
  try { await stop(); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
