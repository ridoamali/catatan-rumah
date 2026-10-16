import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, postWithProgress, type Category } from "./api";
import { compressImage, formatBytes, type Compressed } from "./compress";
import { formatNum, formatRp, parseAmount, todayJakarta } from "./format";
import { categoryEmoji, Icon } from "./ui";
import { STAGES, useScanProgress } from "./scanProgress";

type OcrItem = { name: string; qty: number; unitPrice: number | null; total: number };
type ScanResponse = {
  scanId: string;
  mock: boolean;
  result: {
    merchant: string | null; date: string | null; categoryId: string | null; items: OcrItem[];
    subtotal: number | null; discount: number | null; tax: number | null; total: number | null; itemsSum: number;
  };
};
type Row = { key: number; name: string; qty: string; unitPrice: string; total: string };
type ReceiptStatus = "archived" | "failed" | "local" | "pending";
type Saved = { transactionId: string; receiptStatus: ReceiptStatus };

type Phase =
  | { kind: "idle" }
  | { kind: "working"; preview: string }
  | { kind: "review"; scan: ScanResponse; preview: string; img: Compressed }
  | { kind: "done"; saved: Saved; amount: number; merchant: string | null };

let rowKey = 0;
const toRow = (i: OcrItem): Row => ({
  key: ++rowKey, name: i.name, qty: String(i.qty).replace(".", ","),
  unitPrice: i.unitPrice === null ? "" : formatNum(i.unitPrice), total: formatNum(i.total),
});
const parseQty = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export default function ScanPage({ onSaved, onOpenTransactions }: { onSaved: (occurredOn: string) => void; onOpenTransactions: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const progress = useScanProgress();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  // Lepas object URL preview saat tidak dipakai lagi.
  const previewUrl = phase.kind === "working" || phase.kind === "review" ? phase.preview : null;
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    let preview = "";
    try {
      progress.start();
      setPhase({ kind: "working", preview: "" });
      const img = await compressImage(file);
      progress.compressed();
      preview = URL.createObjectURL(img.blob);
      setPhase({ kind: "working", preview });
      const scan = await postWithProgress<ScanResponse>(
        "/api/scans",
        { imageBase64: img.base64, mimeType: img.mimeType },
        { onUploadProgress: progress.uploading, onUploaded: progress.uploaded },
      );
      progress.finish();
      await new Promise((r) => setTimeout(r, 450)); // tampilkan 100% sejenak
      setPhase({ kind: "review", scan, preview, img });
    } catch (e) {
      if (preview) URL.revokeObjectURL(preview);
      progress.reset();
      setPhase({ kind: "idle" });
      setError((e as Error).message);
    } finally {
      if (camera.current) camera.current.value = "";
      if (gallery.current) gallery.current.value = "";
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Scan nota</h1>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {phase.kind === "idle" && (
        <section className="scan-start">
          <div className="scan-illustration" aria-hidden="true"><Icon name="scan" size={44} /></div>
          <p className="scan-lead">Foto nota belanja, cek hasilnya, lalu simpan sebagai transaksi.</p>
          <div className="scan-buttons">
            <button type="button" className="btn primary" onClick={() => camera.current?.click()}>
              <Icon name="scan" size={18} />Ambil foto
            </button>
            <button type="button" className="btn ghost" onClick={() => gallery.current?.click()}>Pilih dari galeri</button>
          </div>
          <ul className="scan-tips">
            <li>Letakkan nota di permukaan datar dengan cahaya cukup.</li>
            <li>Pastikan seluruh nota masuk, dari nama toko sampai total.</li>
            <li>Foto otomatis dikecilkan sebelum dikirim agar hemat kuota.</li>
          </ul>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => handleFile(e.target.files?.[0])} data-testid="scan-camera" />
          <input ref={gallery} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files?.[0])} data-testid="scan-gallery" />
        </section>
      )}

      {phase.kind === "working" && (
        <section className="scan-progress">
          <div className="scan-visual" aria-hidden="true">
            {phase.preview ? <img src={phase.preview} alt="" /> : <div className="scan-visual-empty"><Icon name="scan" size={40} /></div>}
            {!progress.done && <span className="scan-beam" />}
          </div>
          <div className="scan-meter">
            <div className="scan-pct" aria-hidden="true">
              <span className="num">{progress.pct}</span><small>%</small>
            </div>
            <p className="scan-stage" aria-live="polite">
              {progress.done ? "Selesai" : `${STAGES[progress.stage].label}…`}
            </p>
            <div
              className="scan-bar" role="progressbar" aria-label="Progres scan nota"
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}
              aria-valuetext={`${progress.pct}%, ${progress.done ? "selesai" : STAGES[progress.stage].label}`}
            >
              <span style={{ width: `${progress.pct}%` }} />
            </div>
            <ol className="scan-steps">
              {STAGES.map((st, i) => {
                const state = progress.done || i < progress.stage ? "done" : i === progress.stage ? "now" : "next";
                return (
                  <li key={st.key} className={state}>
                    <span className="dot" aria-hidden="true">{state === "done" ? "✓" : ""}</span>
                    {st.label}
                  </li>
                );
              })}
            </ol>
            <p className="hint small">Persentase memindai adalah perkiraan dari lama scan sebelumnya.</p>
          </div>
        </section>
      )}

      {phase.kind === "review" && (
        <Review
          key={phase.scan.scanId}
          scan={phase.scan}
          preview={phase.preview}
          img={phase.img}
          onCancel={async () => {
            await api(`/api/scans/${phase.scan.scanId}`, { method: "DELETE" }).catch(() => undefined);
            setPhase({ kind: "idle" });
          }}
          onSaved={(saved, amount, merchant, occurredOn) => {
            setPhase({ kind: "done", saved, amount, merchant });
            onSaved(occurredOn);
          }}
        />
      )}

      {phase.kind === "done" && (
        <section className="scan-done" aria-live="polite">
          <div className="done-mark" aria-hidden="true">✓</div>
          <h2>Tersimpan</h2>
          <p className="hint">
            {phase.merchant ?? "Nota"} sebesar <strong>{formatRp(phase.amount)}</strong> masuk ke transaksi.
          </p>
          <ArchiveNote transactionId={phase.saved.transactionId} initial={phase.saved.receiptStatus} />
          <div className="scan-buttons">
            <button type="button" className="btn primary" onClick={() => setPhase({ kind: "idle" })}>Scan nota lain</button>
            <button type="button" className="btn ghost" onClick={onOpenTransactions}>Lihat transaksi</button>
          </div>
        </section>
      )}
    </>
  );
}

function Review({
  scan, preview, img, onCancel, onSaved,
}: {
  scan: ScanResponse; preview: string; img: Compressed;
  onCancel: () => void;
  onSaved: (s: Saved, amount: number, merchant: string | null, occurredOn: string) => void;
}) {
  const r = scan.result;
  const [cats, setCats] = useState<Category[]>([]);
  const [merchant, setMerchant] = useState(r.merchant ?? "");
  const [date, setDate] = useState(r.date ?? todayJakarta());
  const [categoryId, setCategoryId] = useState(r.categoryId ?? "");
  const [rows, setRows] = useState<Row[]>(r.items.map(toRow));
  const [amount, setAmount] = useState(r.total ? formatNum(r.total) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ categories: Category[] }>("/api/categories").then((x) => setCats(x.categories.filter((c) => c.kind === "expense" && !c.archived)));
  }, []);

  const itemsSum = useMemo(() => rows.reduce((s, x) => s + (parseAmount(x.total) ?? 0), 0), [rows]);
  const total = parseAmount(amount) ?? 0;
  const diff = total - itemsSum;

  function update(key: number, patch: Partial<Row>) {
    setRows((all) =>
      all.map((x) => {
        if (x.key !== key) return x;
        const next = { ...x, ...patch };
        // Ubah qty/harga satuan → hitung ulang total baris.
        if ("qty" in patch || "unitPrice" in patch) {
          const q = parseQty(next.qty);
          const u = parseAmount(next.unitPrice);
          if (q !== null && u !== null) next.total = formatNum(Math.round(q * u));
        }
        return next;
      }),
    );
  }

  async function save() {
    setError(null);
    if (!total) return setError("Isi total belanja.");
    const items = [];
    for (const x of rows) {
      const t = parseAmount(x.total);
      if (!x.name.trim() || t === null) return setError("Setiap item perlu nama dan total. Hapus baris yang kosong.");
      items.push({ name: x.name.trim(), qty: parseQty(x.qty) ?? 1, unitPrice: parseAmount(x.unitPrice), total: t });
    }
    setBusy(true);
    try {
      const saved = await api<Saved>(`/api/scans/${scan.scanId}/commit`, {
        body: { amount: total, occurredOn: date, categoryId: categoryId || null, merchant: merchant || null, note: note || null, items },
      });
      onSaved(saved, total, merchant || null, date);
    } catch (e) {
      setError(e instanceof ApiError && e.fields ? Object.values(e.fields).flat().join(" ") : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review">
      <figure className="review-photo">
        <a href={preview} target="_blank" rel="noreferrer"><img src={preview} alt="Foto nota" /></a>
        <figcaption>
          {img.width}×{img.height}px, {formatBytes(img.blob.size)}
          {img.originalBytes > img.blob.size && <> (asli {formatBytes(img.originalBytes)})</>}
        </figcaption>
      </figure>

      <div className="review-form">
        {scan.mock && (
          <p className="mock-banner">Mode contoh: OCR belum tersambung ke n8n, jadi isian di bawah adalah data contoh.</p>
        )}

        <div className="field-row">
          <label className="field"><span>Toko</span>
            <input value={merchant} maxLength={120} onChange={(e) => setMerchant(e.target.value)} placeholder="Nama toko" name="merchant" />
          </label>
          <label className="field"><span>Tanggal{!r.date && " (tidak terbaca)"}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required name="occurredOn" />
          </label>
        </div>

        <fieldset className="cat-grid">
          <legend>Kategori{r.categoryId && " (saran AI)"}</legend>
          {cats.map((c) => (
            <button key={c.id} type="button" className={`cat-chip ${categoryId === c.id ? "on" : ""}`} aria-pressed={categoryId === c.id}
              onClick={() => setCategoryId(categoryId === c.id ? "" : c.id)}>
              <span aria-hidden="true">{categoryEmoji(c.name)}</span>{c.name}
            </button>
          ))}
        </fieldset>

        <div className="items">
          <div className="items-head">
            <h3>Item ({rows.length})</h3>
            <button type="button" className="text-btn"
              onClick={() => setRows([...rows, { key: ++rowKey, name: "", qty: "1", unitPrice: "", total: "" }])}>
              Tambah item
            </button>
          </div>
          {rows.length === 0 && <p className="hint">Tidak ada item terbaca. Total tetap bisa disimpan.</p>}
          <ul className="item-rows">
            {rows.map((x) => (
              <li key={x.key}>
                <input className="item-name" aria-label="Nama item" value={x.name} onChange={(e) => update(x.key, { name: e.target.value })} placeholder="Nama item" />
                <div className="item-nums">
                  <label><span>Qty</span><input inputMode="decimal" aria-label={`Jumlah ${x.name}`} value={x.qty} onChange={(e) => update(x.key, { qty: e.target.value })} /></label>
                  <label><span>@</span><input inputMode="numeric" aria-label={`Harga satuan ${x.name}`} value={x.unitPrice}
                    onChange={(e) => { const n = parseAmount(e.target.value); update(x.key, { unitPrice: n === null ? "" : formatNum(n) }); }} /></label>
                  <label><span>Total</span><input inputMode="numeric" aria-label={`Total ${x.name}`} value={x.total}
                    onChange={(e) => { const n = parseAmount(e.target.value); update(x.key, { total: n === null ? "" : formatNum(n) }); }} /></label>
                  <button type="button" className="icon-btn" aria-label={`Hapus ${x.name || "item"}`} onClick={() => setRows(rows.filter((y) => y.key !== x.key))}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <label className="amount-field">
          <span className="sr-only">Total belanja</span>
          <span className="amount-prefix" aria-hidden="true">Rp</span>
          <input inputMode="numeric" name="amount" value={amount} placeholder="0"
            onChange={(e) => { const n = parseAmount(e.target.value); setAmount(n === null ? "" : formatNum(n)); }} />
        </label>
        {rows.length > 0 && diff !== 0 && (
          <p className="sum-check">
            Jumlah item {formatRp(itemsSum)}, {diff < 0 ? "lebih besar" : "lebih kecil"} {formatRp(Math.abs(diff))} dari total
            {r.discount ? ` (diskon nota ${formatRp(r.discount)})` : ""}.{" "}
            <button type="button" className="text-btn" onClick={() => setAmount(formatNum(itemsSum))}>Pakai jumlah item</button>
          </p>
        )}

        <label className="field"><span>Catatan</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Opsional" />
        </label>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="review-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Batal</button>
          <button type="button" className="btn primary wide" onClick={save} disabled={busy}>{busy ? "Menyimpan…" : "Simpan transaksi"}</button>
        </div>
      </div>
    </div>
  );
}

const ARCHIVE_TEXT: Record<ReceiptStatus, string> = {
  pending: "Foto nota sedang diarsip ke Google Drive…",
  archived: "Foto nota sudah diarsip ke Google Drive.",
  local: "Foto nota disimpan di server. Arsip Drive belum diatur.",
  failed: "Foto nota belum terarsip ke Drive. Akan dicoba ulang otomatis, atau coba ulang dari detail transaksi.",
};

/** Status arsip yang ikut ter-update selama arsip Drive masih berjalan di background. */
function ArchiveNote({ transactionId, initial }: { transactionId: string; initial: ReceiptStatus }) {
  const [status, setStatus] = useState<ReceiptStatus>(initial);
  useEffect(() => {
    if (status !== "pending") return;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      try {
        const d = await api<{ receipt: { status: ReceiptStatus } | null }>(`/api/transactions/${transactionId}`);
        if (d.receipt && d.receipt.status !== "pending") setStatus(d.receipt.status);
      } catch {
        /* abaikan, coba lagi di interval berikutnya */
      }
      if (tries >= 20) clearInterval(t);
    }, 1500);
    return () => clearInterval(t);
  }, [status, transactionId]);
  return (
    <p className={`receipt-note ${status}`} aria-live="polite">
      {status === "pending" && <span className="spinner small" aria-hidden="true" />} {ARCHIVE_TEXT[status]}
    </p>
  );
}
