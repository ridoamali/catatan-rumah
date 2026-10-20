import { useEffect, useState } from "react";
import { api, type Me, type Summary, type Transaction, type TxList } from "./api";
import { currentMonth, formatRp, monthLabel, todayJakarta } from "./format";
import MonthPicker from "./MonthPicker";
import { categoryEmoji, Icon } from "./ui";
import { TxRow } from "./TransactionsPage";
import type { Page } from "./App";
import type { InsightResp } from "./InsightsPage";
import type { ReminderItem } from "./RemindersPage";

// Status anggaran: warna selalu disertai ikon + label (tidak mengandalkan warna saja).
function budgetStatus(spent: number, budget: number) {
  const pct = spent / budget;
  if (pct > 1) return { key: "critical", icon: "▲", label: "Lewat anggaran" };
  if (pct >= 0.8) return { key: "warning", icon: "●", label: "Hampir habis" };
  return { key: "good", icon: "✓", label: "Aman" };
}

function daysInMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function changeSentence(cur: number, prev: number, what: string, prevMonth: string) {
  if (prev === 0) return null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `${what} sama dengan ${monthLabel(prevMonth)}.`;
  return `${what} ${pct > 0 ? "naik" : "turun"} ${Math.abs(pct)}% dari ${monthLabel(prevMonth)}.`;
}

export default function SummaryPage({
  me, month, onMonthChange, refreshKey, onOpenTx, onGo, reminders, today,
}: {
  me: Me; month: string; onMonthChange: (m: string) => void; refreshKey: number;
  onOpenTx: (t: Transaction | null) => void; onGo: (p: Page) => void;
  reminders: ReminderItem[]; today: string;
}) {
  const [s, setS] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [insight, setInsight] = useState<InsightResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    Promise.all([
      api<Summary>(`/api/summary?month=${month}`),
      api<TxList>(`/api/transactions?month=${month}&limit=5`),
    ])
      .then(([sum, tx]) => {
        setS(sum);
        setRecent(tx.items);
      })
      .catch((e) => setError(e.message));
    api<InsightResp>(`/api/insights?month=${month}`).then(setInsight).catch(() => setInsight(null));
  }, [month, refreshKey]);

  const monthName = monthLabel(month).split(" ")[0];
  const withBudget = s?.byCategory.filter((c) => c.budget > 0) ?? [];
  const withoutBudget = s?.byCategory.filter((c) => c.budget === 0) ?? [];

  // Kartu Pengingat Terdekat: aktif saja, urut jatuh tempo siklus berjalan
  // (server memakai zona waktu rumah tangga), maksimal 2 — overdue otomatis
  // di depan karena dueDate-nya paling kecil.
  const upcomingReminders = reminders
    .filter((r) => r.status === "active")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
    .slice(0, 2);

  // Ritme: hari berjalan vs porsi dana yang sudah terpakai (terhadap anggaran, atau pemasukan bila belum ada anggaran).
  const total = daysInMonth(month);
  const day = month === currentMonth() ? Number(todayJakarta().slice(8, 10)) : month < currentMonth() ? total : 0;
  const base = s ? (s.budgetTotal > 0 ? s.budgetTotal : s.income) : 0;
  const baseLabel = s && s.budgetTotal > 0 ? "anggaran" : "pemasukan";
  const usedPct = s && base > 0 ? (s.expense / base) * 100 : null;
  const dayPct = (day / total) * 100;
  const ahead = usedPct !== null && day > 0 && usedPct > dayPct + 10;

  return (
    <>
      <div className="page-head">
        <h1 className="greet">Halo, {me.user.name.split(" ")[0]}</h1>
        <MonthPicker month={month} onChange={onMonthChange} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {s && (
        <section className="hero" aria-label="Ringkasan bulan">
          {s.expense === 0 && s.income === 0 ? (
            <>
              <p className="hero-line">{monthName} belum ada catatan.</p>
              <button type="button" className="btn primary" onClick={() => onOpenTx(null)}><Icon name="plus" size={18} />Catat transaksi pertama</button>
            </>
          ) : (
            <>
              <p className="hero-line">
                <span>{monthName} ini keluar</span>
                <strong className="hero-num" data-testid="sum-expense">{formatRp(s.expense)}</strong>
                {s.income > 0 && (
                  <span>dari <strong className="hero-num soft">{formatRp(s.income)}</strong> yang masuk.</span>
                )}
              </p>
              <p className="hero-sub">
                {s.income > 0 && (s.net >= 0
                  ? <>Masih tersisa <strong>{formatRp(s.net)}</strong>. </>
                  : <>Defisit <strong className="neg">{formatRp(-s.net)}</strong>. </>)}
                {changeSentence(s.expense, s.previous.expense, "Pengeluaran", s.previous.month)}
              </p>

              {usedPct !== null && day > 0 && (
                <div className="pace">
                  <div className="pace-track" role="img" aria-label={`Hari ke-${day} dari ${total}; terpakai ${Math.round(usedPct)}% dari ${baseLabel}`}>
                    <span className={`pace-fill ${ahead ? "ahead" : ""}`} style={{ width: `${Math.min(usedPct, 100)}%` }} />
                    <span className="pace-day" style={{ left: `${dayPct}%` }} />
                  </div>
                  <div className="pace-legend">
                    <span>Terpakai <strong>{Math.round(usedPct)}%</strong> dari {baseLabel}</span>
                    <span>Hari ke-{day} dari {total}</span>
                  </div>
                  {ahead && <p className="pace-note">▲ Pengeluaran lebih cepat dari ritme bulan ini.</p>}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {s && insight?.available && (s.expense > 0 || s.income > 0) && (
        <section className="block ai-card">
          <div className="ai-card-icon" aria-hidden="true"><Icon name="sparkle" size={22} /></div>
          <div className="ai-card-body">
            <h2>Analisa AI</h2>
            {insight.insight ? (
              <p className="ai-card-text">{insight.insight.result.summary}</p>
            ) : (
              <p className="hint">Minta AI membaca pengeluaran {monthName} dan memberi saran hemat.</p>
            )}
          </div>
          <button type="button" className="btn ghost" onClick={() => onGo("analisa")}>
            {insight.insight ? "Lihat analisa" : "Analisa"}
          </button>
        </section>
      )}

      {/* Kartu Pengingat Terdekat: maksimal 2 pengingat aktif terurut jatuh
          tempo siklus berjalan (server sudah menghitung urgensi memakai zona
          waktu rumah tangga — bukan bulan laporan). Tanpa aksi edit/hapus. */}
      {upcomingReminders.length > 0 && (
        <section className="block" aria-label="Pengingat terdekat">
          <div className="block-head">
            <h2>Pengingat Terdekat</h2>
            <button type="button" className="text-btn" onClick={() => onGo("pengingat")}>Lihat semua</button>
          </div>
          <ul className="rem-list rem-list-compact">
            {upcomingReminders.map((r) => (
              <li key={r.id}>
                <span className={`rem-dot ${r.urgency}`} aria-hidden="true" />
                <span className="grow">
                  <strong>{r.title}</strong>
                  <small>
                    {r.dueDate}
                    {r.amount !== null ? ` · ${formatRp(r.amount)}` : ""}
                  </small>
                </span>
                <span className={`rem-badge ${r.urgency}`} aria-live="polite">
                  {r.urgency === "overdue" ? "Terlambat" : r.urgency === "today" ? "Hari ini" : r.dueDate}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {s && withBudget.length > 0 && (
        <section className="block">
          <div className="block-head">
            <h2>Anggaran</h2>
            <button type="button" className="text-btn" onClick={() => onGo("anggaran")}>Atur</button>
          </div>
          <ul className="meters">
            {withBudget.map((c) => {
              const st = budgetStatus(c.spent, c.budget);
              const pct = Math.round((c.spent / c.budget) * 100);
              return (
                <li key={c.categoryId}>
                  <span className="emoji-dot" aria-hidden="true">{categoryEmoji(c.name)}</span>
                  <div className="meter-body">
                    <div className="meter-head">
                      <span className="meter-name">{c.name}</span>
                      <span className="num">{formatRp(c.spent)}<span className="muted"> / {formatRp(c.budget)}</span></span>
                    </div>
                    <div className={`meter ${st.key}`} role="meter" aria-label={`${c.name}: ${pct}% dari anggaran`}
                      aria-valuemin={0} aria-valuemax={c.budget} aria-valuenow={c.spent}>
                      <span style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <span className={`bstatus ${st.key}`}>
                      <span aria-hidden="true">{st.icon}</span> {st.label}, {pct}%
                      {c.spent > c.budget && ` (lebih ${formatRp(c.spent - c.budget)})`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {s && withBudget.length === 0 && (
        <section className="block budget-cta">
          <div>
            <h2>Anggaran</h2>
            <p className="hint">Atur batas belanja bulanan per kategori untuk melihat sisa anggaran di sini.</p>
          </div>
          <button type="button" className="btn ghost" onClick={() => onGo("anggaran")}>Atur anggaran</button>
        </section>
      )}

      {s && withoutBudget.length > 0 && (
        <section className="block">
          <div className="block-head"><h2>Tanpa anggaran</h2></div>
          <ul className="plain-list">
            {withoutBudget.map((c) => (
              <li key={c.categoryId}>
                <span className="emoji-dot" aria-hidden="true">{categoryEmoji(c.categoryId === "none" ? null : c.name)}</span>
                <span className="grow">{c.name}</span>
                <span className="num">{formatRp(c.spent)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="block">
          <div className="block-head">
            <h2>Terakhir dicatat</h2>
            <button type="button" className="text-btn" onClick={() => onGo("transaksi")}>Lihat semua</button>
          </div>
          <ul className="tx-rows">
            {recent.map((t) => <TxRow key={t.id} t={t} onOpen={onOpenTx} showDate />)}
          </ul>
        </section>
      )}
    </>
  );
}
