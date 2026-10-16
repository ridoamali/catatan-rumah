import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Kind, type Transaction, type TxList } from "./api";
import { dateLabel, formatRp } from "./format";
import MonthPicker from "./MonthPicker";
import { categoryEmoji, Icon } from "./ui";

const SOURCE_LABEL: Record<Transaction["source"], string> = { web: "", scan: "Scan", telegram: "Telegram", import: "Impor" };

export function TxRow({ t, onOpen, showDate = false }: { t: Transaction; onOpen: (t: Transaction) => void; showDate?: boolean }) {
  const title = t.merchant || t.categoryName || (t.kind === "income" ? "Pemasukan" : "Pengeluaran");
  const meta = [showDate ? dateLabel(t.occurredOn) : null, t.categoryName ?? "Tanpa kategori", t.userName, SOURCE_LABEL[t.source] || null]
    .filter(Boolean)
    .join(", ");
  return (
    <li>
      <button type="button" className="tx-row" onClick={() => onOpen(t)} aria-label={`Ubah ${title} ${formatRp(t.amount)}`}>
        <span className="emoji-dot" aria-hidden="true">{categoryEmoji(t.categoryName, t.kind)}</span>
        <span className="tx-text">
          <span className="tx-title">{title}</span>
          <span className="tx-meta">{meta}{t.note ? ` — ${t.note}` : ""}</span>
        </span>
        <span className={`tx-amount num ${t.kind}`}>{t.kind === "expense" ? "−" : "+"}{formatRp(t.amount)}</span>
      </button>
    </li>
  );
}

export default function TransactionsPage({
  month, onMonthChange, refreshKey, onOpenTx,
}: {
  month: string; onMonthChange: (m: string) => void; refreshKey: number; onOpenTx: (t: Transaction | null) => void;
}) {
  const [list, setList] = useState<TxList | null>(null);
  const [kind, setKind] = useState<"" | Kind>("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ month });
    if (kind) params.set("kind", kind);
    if (q.trim()) params.set("q", q.trim());
    setList(await api<TxList>(`/api/transactions?${params}`));
  }, [month, kind, q]);

  useEffect(() => {
    const t = setTimeout(() => load().catch((e) => setError(e.message)), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q, refreshKey]);

  const groups = useMemo(() => {
    const m = new Map<string, Transaction[]>();
    for (const t of list?.items ?? []) m.set(t.occurredOn, [...(m.get(t.occurredOn) ?? []), t]);
    return [...m.entries()];
  }, [list]);

  return (
    <>
      <div className="page-head">
        <h1>Transaksi</h1>
        <MonthPicker month={month} onChange={onMonthChange} />
      </div>

      {list && (
        <div className="totals" data-testid="tx-totals">
          <div><span>Keluar</span><strong className="num">{formatRp(list.totals.expense)}</strong></div>
          <div><span>Masuk</span><strong className="num">{formatRp(list.totals.income)}</strong></div>
          <div><span>Transaksi</span><strong className="num">{list.totals.count}</strong></div>
        </div>
      )}

      <div className="toolbar">
        <label className="search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Cari toko atau catatan" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari" />
        </label>
        <div className="seg small" role="radiogroup" aria-label="Filter jenis">
          {([["", "Semua"], ["expense", "Keluar"], ["income", "Masuk"]] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {list && list.items.length === 0 && (
        <div className="empty">
          <p>{q || kind ? "Tidak ada transaksi yang cocok." : "Belum ada transaksi bulan ini."}</p>
          {!q && !kind && <button type="button" className="btn primary" onClick={() => onOpenTx(null)}><Icon name="plus" size={18} />Catat transaksi</button>}
        </div>
      )}

      {groups.map(([date, items]) => (
        <section key={date} className="day">
          <h2 className="day-label">{dateLabel(date)}</h2>
          <ul className="tx-rows">
            {items.map((t) => <TxRow key={t.id} t={t} onOpen={onOpenTx} />)}
          </ul>
        </section>
      ))}
    </>
  );
}
