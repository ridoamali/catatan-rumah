import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Category, type Kind, type Transaction } from "./api";
import { formatNum, parseAmount, todayJakarta } from "./format";
import { categoryEmoji, Sheet } from "./ui";

type Detail = {
  items: { name: string; qty: number; unitPrice: number | null; total: number }[];
  receipt: { status: "local" | "pending" | "archived" | "failed"; url: string } | null;
};

type Draft = { kind: Kind; amount: string; occurredOn: string; categoryId: string; merchant: string; note: string };

const fromTx = (t: Transaction): Draft => ({
  kind: t.kind, amount: formatNum(t.amount), occurredOn: t.occurredOn,
  categoryId: t.categoryId ?? "", merchant: t.merchant ?? "", note: t.note ?? "",
});
const blank = (kind: Kind): Draft => ({ kind, amount: "", occurredOn: todayJakarta(), categoryId: "", merchant: "", note: "" });

export default function TxSheet({
  open, editing, onClose, onSaved,
}: {
  open: boolean;
  editing: Transaction | null;
  onClose: () => void;
  onSaved: (occurredOn: string) => void;
}) {
  const [cats, setCats] = useState<Category[]>([]);
  const [d, setD] = useState<Draft>(blank("expense"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setD(editing ? fromTx(editing) : blank("expense"));
    setError(null);
    setConfirmDelete(false);
    setDetail(null);
    if (editing?.source === "scan") {
      api<Detail>(`/api/transactions/${editing.id}`).then(setDetail).catch(() => undefined);
    }
    api<{ categories: Category[] }>("/api/categories").then((r) => setCats(r.categories)).catch((e) => setError(e.message));
  }, [open, editing]);

  const options = useMemo(
    () => cats.filter((c) => c.kind === d.kind && (!c.archived || c.id === d.categoryId)),
    [cats, d.kind, d.categoryId],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amount = parseAmount(d.amount);
    if (!amount) return setError("Isi nominal lebih dari 0.");
    const body = {
      kind: d.kind, amount, occurredOn: d.occurredOn,
      categoryId: d.categoryId || null, merchant: d.merchant || null, note: d.note || null,
    };
    setBusy(true);
    setError(null);
    try {
      if (editing) await api(`/api/transactions/${editing.id}`, { method: "PATCH", body });
      else await api("/api/transactions", { body });
      onSaved(d.occurredOn);
    } catch (err) {
      setError(err instanceof ApiError && err.fields ? Object.values(err.fields).flat().join(" ") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/api/transactions/${editing.id}`, { method: "DELETE" });
      onSaved(editing.occurredOn);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retryArchive() {
    if (!editing) return;
    setArchiving(true);
    try {
      await api(`/api/transactions/${editing.id}/receipt/archive`, { body: {} });
      setDetail(await api<Detail>(`/api/transactions/${editing.id}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setArchiving(false);
    }
  }

  const amountValue = parseAmount(d.amount);

  return (
    <Sheet open={open} title={editing ? "Ubah transaksi" : "Catat transaksi"} onClose={onClose}>
      <form className="tx-sheet" onSubmit={submit} aria-label="Form transaksi">
        <div className="seg" role="radiogroup" aria-label="Jenis transaksi">
          {(["expense", "income"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={d.kind === k} className={d.kind === k ? "on" : undefined}
              onClick={() => setD({ ...d, kind: k, categoryId: "" })}>
              {k === "expense" ? "Pengeluaran" : "Pemasukan"}
            </button>
          ))}
        </div>

        <label className={`amount-field ${d.kind}`}>
          <span className="sr-only">Nominal</span>
          <span className="amount-prefix" aria-hidden="true">Rp</span>
          <input
            name="amount" inputMode="numeric" placeholder="0" autoComplete="off" data-autofocus
            value={d.amount}
            onChange={(e) => {
              const n = parseAmount(e.target.value);
              setD({ ...d, amount: n === null ? "" : formatNum(n) });
            }}
          />
        </label>
        {!amountValue && <p id="amount-hint" className="amount-hint">Ketik angka saja, titik ribuan otomatis.</p>}

        <fieldset className="cat-grid">
          <legend>Kategori</legend>
          {options.map((c) => (
            <button key={c.id} type="button" className={`cat-chip ${d.categoryId === c.id ? "on" : ""}`} aria-pressed={d.categoryId === c.id}
              onClick={() => setD({ ...d, categoryId: d.categoryId === c.id ? "" : c.id })}>
              <span aria-hidden="true">{categoryEmoji(c.name, c.kind)}</span>{c.name}
            </button>
          ))}
        </fieldset>

        <div className="field-row">
          <label className="field">
            <span>Tanggal</span>
            <input name="occurredOn" type="date" value={d.occurredOn} onChange={(e) => setD({ ...d, occurredOn: e.target.value })} required />
          </label>
          <label className="field">
            <span>{d.kind === "expense" ? "Toko" : "Dari"}</span>
            <input name="merchant" value={d.merchant} maxLength={120} placeholder={d.kind === "expense" ? "Indomaret" : "Kantor"}
              onChange={(e) => setD({ ...d, merchant: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Catatan</span>
          <input name="note" value={d.note} maxLength={500} placeholder="Opsional" onChange={(e) => setD({ ...d, note: e.target.value })} />
        </label>

        {detail && (detail.items.length > 0 || detail.receipt) && (
          <details className="receipt-detail" open={detail.items.length <= 6}>
            <summary>Rincian nota{detail.items.length ? ` (${detail.items.length} item)` : ""}</summary>
            {detail.items.length > 0 && (
              <ul className="receipt-items">
                {detail.items.map((it, i) => (
                  <li key={i}>
                    <span className="grow">{it.name}</span>
                    <span className="muted num">{String(it.qty).replace(".", ",")}×{it.unitPrice !== null ? ` ${formatNum(it.unitPrice)}` : ""}</span>
                    <span className="num">{formatNum(it.total)}</span>
                  </li>
                ))}
              </ul>
            )}
            {detail.receipt && (
              <div className="receipt-links">
                <a className="btn ghost" href={detail.receipt.url} target="_blank" rel="noreferrer">
                  {detail.receipt.status === "archived" ? "Lihat nota di Drive" : "Lihat foto nota"}
                </a>
                {detail.receipt.status === "pending" && <span className="hint small">Sedang diarsip ke Drive…</span>}
                {detail.receipt.status === "failed" && (
                  <button type="button" className="text-btn" onClick={retryArchive} disabled={archiving}>
                    {archiving ? "Mengarsipkan…" : "Arsipkan ulang ke Drive"}
                  </button>
                )}
              </div>
            )}
          </details>
        )}

        {error && <p className="error" role="alert">{error}</p>}

        <div className="sheet-actions">
          {editing && (confirmDelete ? (
            <div className="confirm">
              <span>Hapus transaksi ini?</span>
              <button type="button" className="btn danger" onClick={remove} disabled={busy}>Hapus</button>
              <button type="button" className="text-btn" onClick={() => setConfirmDelete(false)}>Batal</button>
            </div>
          ) : (
            <button type="button" className="text-btn danger-text" onClick={() => setConfirmDelete(true)}>Hapus</button>
          ))}
          {!confirmDelete && (
            <button type="submit" className="btn primary wide" disabled={busy}>{editing ? "Simpan perubahan" : "Simpan"}</button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
