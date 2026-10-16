import { env, ocrMock } from "./env.js";
import { runMigrations, sqlite } from "./db/client.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { buildApp } from "./app.js";
import { drainArchives, purgeStaleScans, resumeArchives } from "./routes/scans.js";

runMigrations();
purgeExpiredSessions();
await purgeStaleScans();

const app = await buildApp();
// Lanjutkan arsip Drive yang tertunda (mis. server sempat mati di tengah arsip).
resumeArchives({ staleMs: 0, includeFailed: true }).catch((e) => app.log.error(e, "resumeArchives gagal"));
const purgeTimer = setInterval(() => {
  purgeExpiredSessions();
  purgeStaleScans().catch((e) => app.log.error(e, "purgeStaleScans gagal"));
  // Arsip yang gagal (mis. Drive sempat error) dicoba ulang tiap 6 jam, tidak lebih sering.
  resumeArchives({ includeFailed: true }).catch((e) => app.log.error(e, "resumeArchives gagal"));
}, 6 * 60 * 60 * 1000);
const archiveTimer = setInterval(() => {
  resumeArchives().catch((e) => app.log.error(e, "resumeArchives gagal"));
}, 15 * 60 * 1000);
app.log.info(
  { ocr: ocrMock ? "mock" : env.N8N_RECEIPT_OCR_URL ? "n8n" : "off", archive: env.N8N_RECEIPT_ARCHIVE_URL ? "n8n" : "local" },
  "scan nota",
);

const shutdown = async () => {
  clearInterval(purgeTimer);
  clearInterval(archiveTimer);
  await app.close();
  await drainArchives();
  sqlite.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
