import { env } from "../env.js";

export class WebhookError extends Error {
  constructor(message: string, public readonly kind: "timeout" | "http" | "network" | "format") {
    super(message);
  }
}

/**
 * POST JSON ke webhook n8n. Secret dikirim lewat header X-Webhook-Secret.
 * Pesan error sengaja tidak menyertakan URL lengkap, header, maupun body (bisa berisi gambar / secret).
 */
export async function postWebhook(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(env.N8N_WEBHOOK_SECRET ? { "x-webhook-secret": env.N8N_WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new WebhookError("timeout", "timeout");
    throw new WebhookError("network", "network");
  }
  if (!res.ok) throw new WebhookError(`HTTP ${res.status}`, "http");
  try {
    return await res.json();
  } catch {
    throw new WebhookError("bukan JSON", "format");
  }
}
