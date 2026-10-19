import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "./api";
import { formatRp, parseAmount, formatNum } from "./format";
import { Icon } from "./ui";

export type ReminderItem = {
  id: string;
  title: string;
  amount: number | null;
  dueDate: string;
  repeat: "none" | "monthly" | "yearly";
  note: string | null;
  status: "active" | "done";
  urgency: "overdue" | "today" | "soon" | "upcoming";
  daysLeft: number;
};

const REPEAT_LABEL = { none: "Sekali", monthly: "Tiap bulan", yearly: "Tiap tahun" } as const;
const URGENCY_LABEL = {
  overdue: "Terlambat",
  today: "Hari ini",
  soon: "Segera",
  upcoming: "Mendatang",
} as const;

// Tanggal lokal browser sebagai YYYY-MM-DD (untuk default & min input date).
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dueLabel(r: ReminderItem): string {
  if (r.status === "done") return "Selesai";
  if (r.urgency === "overdue") return `Terlambat ${-r.daysLeft} hari`;
  if (r.urgency === "today") return "Jatuh tempo hari ini";
  if (r.urgency === "soon") return `${r.daysLeft} hari lagi`;
  return r.dueDate;
}

export default function RemindersPage({ me }: { me: Me }) {
  const [items, setItems] = useState<ReminderItem[]>([]);
  const [today, setToday] = useState(todayLocal());
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [form, setForm] = useState({ title: "", amount: "", dueDate: "", repeat: "none" as ReminderItem["repeat"], note: "" });

  async function load() {
    const data = await api<{ items: ReminderItem[]; today: string }>("/api/reminders");
    setItems(data.items);
    setToday(data.today);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  const active = useMemo(
    () => items.filter((r) => r.status === "active").sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [items],
  );
  const done = useMemo(() => items.filter((r) => r.status === "done"), [items]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const amount = parseAmount(form.amount);
    try {
      await api("/api/reminders", {
        body: {
          title: form.title,
          amount: amount === null ? null : amount,
          dueDate: form.dueDate,
          repeat: form.repeat,
          note: form.note || null,
        },
      });
      setForm({ title: "", amount: "", dueDate: "", repeat: "none", note: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.fields ? Object.values(err.fields).flat().join(" ") : (err as Error).message);
    }
  }

  async function toggleDone(r: ReminderItem) {
    setError(null);
    try {
      await api(`/api/reminders/${r.id}`, { method: "PATCH", body: { status: r.status === "done" ? "active" : "done" } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(r: ReminderItem) {
    setError(null);
    try {
      await api(`/api/reminders/${r.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const row = (r: ReminderItem) => (
    <li key={r.id} className={r.status === "done" ? "rem-done" : undefined}>
      <span className={`rem-dot ${r.status === "done" ? "" : r.urgency}`} aria-hidden="true" />
      <span className="grow">
        <strong>{r.title}</strong>
        <small>
          {r.dueDate} · {r.repeat === "none" ? "Sekali" : REPEAT_LABEL[r.repeat]}
          {r.amount !== null ? ` · ${formatRp(r.amount)}` : ""}
          {r.note ? ` · ${r.note}` : ""}
        </small>
      </span>
      {r.status === "active" && (
        <span className={`rem-badge ${r.urgency}`} aria-live="polite">{dueLabel(r)}</span>
      )}
      <button type="button" className="icon-btn" onClick={() => toggleDone(r)} aria-label={r.status === "done" ? `Buka kembali ${r.title}` : `Tandai selesai ${r.title}`} title={r.status === "done" ? "Buka kembali" : "Tandai selesai"}>
        {r.status === "done" ? "↩" : "✓"}
      </button>
      <button type="button" className="icon-btn" onClick={() => remove(r)} aria-label={`Hapus ${r.title}`} title="Hapus">✕</button>
    </li>
  );

  return (
    <>
      <div className="page-head">
        <h1>Pengingat</h1>
        <p className="muted">Tagihan dan pembayaran yang harus diingat keluarga.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="block">
        <form className="rem-form" onSubmit={submit}>
          <input
            name="title"
            placeholder="Judul, mis. Listrik PLN"
            maxLength={80}
            required
            aria-label="Judul pengingat"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <div className="rem-row">
            <label className="money-input">
              <span aria-hidden="true">Rp</span>
              <input
                inputMode="numeric"
                placeholder="Nominal (opsional)"
                aria-label="Nominal (opsional)"
                value={form.amount}
                onChange={(e) => {
                  const n = parseAmount(e.target.value);
                  setForm({ ...form, amount: n === null ? "" : formatNum(n) });
                }}
              />
            </label>
            <input
              type="date"
              name="dueDate"
              required
              aria-label="Tanggal jatuh tempo"
              min={today}
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            />
            <select
              aria-label="Pengulangan"
              value={form.repeat}
              onChange={(e) => setForm({ ...form, repeat: e.target.value as ReminderItem["repeat"] })}
            >
              <option value="none">Sekali</option>
              <option value="monthly">Tiap bulan</option>
              <option value="yearly">Tiap tahun</option>
            </select>
          </div>
          <input
            name="note"
            placeholder="Catatan (opsional)"
            maxLength={500}
            aria-label="Catatan (opsional)"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <button type="submit" className="btn primary">
            <Icon name="plus" size={16} />Tambah pengingat
          </button>
        </form>
      </section>

      <section className="block">
        <div className="block-head">
          <h2>Aktif ({active.length})</h2>
        </div>
        {active.length === 0 ? (
          <p className="muted">Belum ada pengingat aktif.</p>
        ) : (
          <ul className="rem-list">{active.map(row)}</ul>
        )}
      </section>

      {done.length > 0 && (
        <section className="block">
          <div className="block-head">
            <h2>
              <button type="button" className="linklike" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
                Selesai ({done.length}) {showDone ? "▾" : "▸"}
              </button>
            </h2>
          </div>
          {showDone && <ul className="rem-list">{done.map(row)}</ul>}
        </section>
      )}

      <p className="hint">
        Pengingat selesai tidak otomatis membuat transaksi — catat pembayarannya lewat tombol
        <strong> Catat transaksi</strong> bila perlu. Zona waktu: {me.household.timezone}.
      </p>
    </>
  );
}
