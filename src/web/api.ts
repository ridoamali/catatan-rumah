export class ApiError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, string[]>) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.fields);
  return data as T;
}

export type Me = {
  user: { id: string; name: string; email: string; role: "owner" | "member" };
  household: { id: string; name: string; currency: string; timezone: string };
};

export type Member = { id: string; name: string; email: string; role: "owner" | "member"; createdAt: string };

export type Kind = "expense" | "income";
export type Category = { id: string; name: string; kind: Kind; archived: boolean };

export type Transaction = {
  id: string;
  kind: Kind;
  amount: number;
  occurredOn: string;
  merchant: string | null;
  note: string | null;
  source: "web" | "scan" | "telegram" | "import";
  receiptStatus?: "local" | "pending" | "archived" | "failed" | null;
  categoryId: string | null;
  categoryName: string | null;
  userId: string | null;
  userName: string | null;
};

export type TxList = { items: Transaction[]; totals: { income: number; expense: number; count: number } };

export type Summary = {
  month: string;
  income: number;
  expense: number;
  net: number;
  previous: { month: string; income: number; expense: number };
  budgetTotal: number;
  byCategory: { categoryId: string; name: string; spent: number; budget: number }[];
};

export type Budget = { categoryId: string; name: string; monthlyAmount: number };

/**
 * POST JSON dengan progres upload nyata (XMLHttpRequest, karena fetch belum punya upload progress).
 * onUploadProgress(0..1) dipanggil selama body terkirim; onUploaded() saat seluruh body sudah diterima server.
 */
export function postWithProgress<T>(
  path: string,
  body: unknown,
  opts: { onUploadProgress?: (ratio: number) => void; onUploaded?: () => void; timeoutMs?: number } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.withCredentials = true;
    xhr.timeout = opts.timeoutMs ?? 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onUploadProgress?.(e.loaded / e.total);
    };
    xhr.upload.onload = () => opts.onUploaded?.();
    xhr.onload = () => {
      let data: { error?: string; fields?: Record<string, string[]> } = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* biarkan kosong */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data.error ?? `HTTP ${xhr.status}`, data.fields));
    };
    xhr.onerror = () => reject(new ApiError(0, "Koneksi ke server terputus. Coba lagi."));
    xhr.ontimeout = () => reject(new ApiError(0, "Proses terlalu lama. Coba lagi."));
    xhr.send(JSON.stringify(body));
  });
}
