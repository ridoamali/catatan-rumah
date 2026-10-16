import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { insights } from "../db/schema.js";
import { requireAuth } from "../auth/session.js";
import { env, insightMock } from "../env.js";
import { isValidMonth } from "../finance/dates.js";
import { buildInsightInput } from "../insights/summary.js";
import { InsightResult, mockInsight } from "../insights/result.js";
import { postWebhook, WebhookError } from "../receipts/n8n.js";

const INSIGHT_TIMEOUT_MS = 90_000;
const MonthQ = z.object({ month: z.string().refine(isValidMonth, "Format bulan YYYY-MM") });

function latest(householdId: string, month: string) {
  const row = db
    .select()
    .from(insights)
    .where(and(eq(insights.householdId, householdId), eq(insights.month, month)))
    .orderBy(desc(insights.createdAt))
    .get();
  return row ? { id: row.id, month: row.month, createdAt: row.createdAt, mock: row.mock, result: JSON.parse(row.resultJson) } : null;
}

export async function insightRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/insights", async (req, reply) => {
    const q = MonthQ.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Format bulan YYYY-MM" });
    return { available: insightMock || !!env.N8N_INSIGHT_URL, mock: insightMock, insight: latest(req.user!.householdId, q.data.month) };
  });

  // Membuat analisa baru (memanggil AI). Dibatasi agar kuota AI tidak terkuras.
  app.post("/api/insights", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const q = MonthQ.safeParse(req.body);
    if (!q.success) return reply.code(400).send({ error: "Format bulan YYYY-MM" });
    if (!insightMock && !env.N8N_INSIGHT_URL) {
      return reply.code(503).send({ error: "Analisa AI belum tersambung ke n8n. Isi N8N_INSIGHT_URL di .env." });
    }
    const hid = req.user!.householdId;
    const input = buildInsightInput(hid, q.data.month);
    if (input.totals.expense === 0 && input.totals.income === 0) {
      return reply.code(422).send({ error: "Belum ada transaksi di bulan ini untuk dianalisa." });
    }

    let raw: unknown;
    try {
      raw = insightMock ? mockInsight(input) : await postWebhook(env.N8N_INSIGHT_URL!, { input }, INSIGHT_TIMEOUT_MS);
    } catch (e) {
      const timeout = e instanceof WebhookError && e.kind === "timeout";
      return reply.code(502).send({ error: timeout ? "Analisa terlalu lama. Coba lagi." : "Layanan analisa tidak bisa dihubungi. Coba lagi sebentar." });
    }
    const parsed = InsightResult.safeParse(raw);
    if (!parsed.success) return reply.code(502).send({ error: "Balasan analisa tidak dikenali. Periksa workflow n8n." });

    db.insert(insights)
      .values({ householdId: hid, month: q.data.month, createdBy: req.user!.id, inputJson: JSON.stringify(input), resultJson: JSON.stringify(parsed.data), mock: insightMock })
      .run();
    return reply.code(201).send({ insight: latest(hid, q.data.month) });
  });
}
