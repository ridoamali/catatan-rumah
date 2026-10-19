import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, isProd, isTest } from "./env.js";
import { dbHealthy } from "./db/client.js";
import { loadSession } from "./auth/session.js";
import { authRoutes } from "./routes/auth.js";
import { householdRoutes } from "./routes/household.js";
import { financeRoutes } from "./routes/finance.js";
import { scanRoutes } from "./routes/scans.js";
import { reportRoutes } from "./routes/reports.js";
import { insightRoutes } from "./routes/insights.js";
import { reminderRoutes } from "./routes/reminders.js";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp() {
  const app = Fastify({
    logger: isTest
      ? false
      : { level: isProd ? "info" : "debug", redact: ["req.headers.authorization", "req.headers.cookie"] },
    bodyLimit: 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  app.decorateRequest("user", null);

  // Proteksi CSRF lapis kedua (lapis pertama: cookie SameSite=Lax).
  // Request yang mengubah data dan membawa header Origin asing ditolak.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !env.ALLOWED_ORIGINS.includes(origin)) {
        return reply.code(403).send({ error: "Origin tidak diizinkan" });
      }
    }
    await loadSession(req, reply);
  });

  app.get("/api/health", async (_req, reply) => {
    const db = dbHealthy() ? "ok" : "error";
    return reply.code(db === "ok" ? 200 : 503).send({ status: db === "ok" ? "ok" : "degraded", db });
  });

  await app.register(authRoutes);
  await app.register(householdRoutes);
  await app.register(financeRoutes);
  await app.register(scanRoutes);
  await app.register(reportRoutes);
  await app.register(insightRoutes);
  await app.register(reminderRoutes);

  // Produksi: Fastify juga menyajikan hasil build frontend (dist/).
  const distDir = resolve("dist");
  if (isProd && existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
