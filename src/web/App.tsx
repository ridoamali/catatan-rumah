import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me, type Transaction } from "./api";
import AuthScreen from "./AuthScreen";
import SummaryPage from "./SummaryPage";
import TransactionsPage from "./TransactionsPage";
import TxSheet from "./TxSheet";
import { currentMonth, todayJakarta } from "./format";
import { Icon, type IconName } from "./ui";

// Halaman yang jarang dibuka dimuat terpisah agar Beranda terbuka lebih cepat.
const MembersPage = lazy(() => import("./MembersPage"));
const BudgetsPage = lazy(() => import("./BudgetsPage"));
const ScanPage = lazy(() => import("./ScanPage"));
const ReportsPage = lazy(() => import("./ReportsPage"));
const InsightsPage = lazy(() => import("./InsightsPage"));
const RemindersPage = lazy(() => import("./RemindersPage"));
import { overdueCount, badgeLabel, type ReminderItem } from "./RemindersPage";

export type Page = "ringkasan" | "transaksi" | "scan" | "laporan" | "analisa" | "anggaran" | "anggota" | "pengingat";
const NAV: { key: Page; label: string; icon: IconName }[] = [
  { key: "ringkasan", label: "Beranda", icon: "home" },
  { key: "transaksi", label: "Transaksi", icon: "list" },
  { key: "scan", label: "Scan", icon: "scan" },
  { key: "laporan", label: "Laporan", icon: "chart" },
  { key: "anggaran", label: "Anggaran", icon: "wallet" },
  { key: "analisa", label: "Analisa AI", icon: "sparkle" },
  { key: "pengingat", label: "Pengingat", icon: "bell" },
  { key: "anggota", label: "Anggota", icon: "users" },
];

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "anon"; needsSetup: boolean }
  | { kind: "authed"; me: Me };

export default function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [page, setPage] = useState<Page>("ringkasan");
  const [month, setMonth] = useState(currentMonth());
  const [sheet, setSheet] = useState<{ open: boolean; editing: Transaction | null }>({ open: false, editing: null });
  const [refreshKey, setRefreshKey] = useState(0);
  // Status pengingat untuk badge topbar & kartu Beranda; dimuat ulang saat
  // refreshKey berubah (setelah tambah/edit/selesai/hapus pengingat dari
  // halaman Pengingat) — satu fetch, dipakai dua tempat tanpa duplikasi state.
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [remToday, setRemToday] = useState(todayJakarta());

  const refreshReminders = useCallback(async () => {
    try {
      const d = await api<{ items: ReminderItem[]; today: string }>("/api/reminders");
      setReminders(d.items);
      setRemToday(d.today);
    } catch {
      // Badge/kartu pengingat bersifat pelengkap; biarkan kosong saat gagal.
    }
  }, []);
  useEffect(() => {
    refreshReminders();
  }, [refreshReminders, refreshKey]);

  const refresh = useCallback(async () => {
    try {
      setState({ kind: "authed", me: await api<Me>("/api/auth/me") });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        const { needsSetup } = await api<{ needsSetup: boolean }>("/api/auth/status");
        setState({ kind: "anon", needsSetup });
      } else {
        setState({ kind: "error", message: "Server tidak terjangkau. Jalankan `npm run dev`, lalu muat ulang halaman." });
      }
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const openTx = useCallback((t: Transaction | null) => setSheet({ open: true, editing: t }), []);
  const closeTx = useCallback(() => setSheet((s) => ({ ...s, open: false })), []);
  const onSaved = useCallback((occurredOn: string) => {
    setSheet({ open: false, editing: null });
    setMonth(occurredOn.slice(0, 7));
    setRefreshKey((k) => k + 1);
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    setPage("ringkasan");
    refresh();
  }

  if (state.kind === "loading") return <div className="center muted">Memuat…</div>;
  if (state.kind === "error") return <div className="center"><p className="error">{state.message}</p></div>;
  if (state.kind === "anon") return <AuthScreen needsSetup={state.needsSetup} onDone={refresh} />;

  const { me } = state;
  const go = (p: Page) => {
    setPage(p);
    window.scrollTo({ top: 0 });
  };

  // Badge lonceng: jumlah pengingat terlambat (1–9, lalu 9+). Server sudah
  // menghitung urgensi memakai zona waktu rumah tangga; due today bukan overdue.
  const overdue = overdueCount(reminders);
  const badge = badgeLabel(overdue);

  return (
    <div className="shell">
      <aside className="rail" aria-label="Navigasi utama">
        <div className="wordmark">catatan rumah<span>.</span></div>
        <p className="rail-household">{me.household.name}</p>
        <nav className="rail-nav">
          {NAV.map((n) => (
            <button key={n.key} type="button" className={`rail-item ${page === n.key ? "on" : ""}`} aria-current={page === n.key ? "page" : undefined} onClick={() => go(n.key)}>
              <Icon name={n.icon} />{n.label}
            </button>
          ))}
        </nav>
        <button type="button" className="btn primary rail-add" onClick={() => openTx(null)}>
          <Icon name="plus" size={18} />Catat transaksi
        </button>
        <div className="rail-user">
          <span className="avatar" aria-hidden="true">{me.user.name.slice(0, 1).toUpperCase()}</span>
          <span className="rail-user-name">{me.user.name}<small>{me.user.role === "owner" ? "Owner" : "Anggota"}</small></span>
          <button type="button" className="icon-btn" onClick={logout} aria-label="Keluar" title="Keluar"><Icon name="logout" size={18} /></button>
        </div>
      </aside>

      <header className="topbar">
        <div className="wordmark">catatan rumah<span>.</span></div>
        <div className="topbar-actions">
          <button type="button" className="icon-btn topbar-bell" onClick={() => go("pengingat")} aria-label={`Pengingat${overdue > 0 ? `, ${overdue} terlambat` : ""}`} title="Pengingat">
            <Icon name="bell" size={20} />
            {badge && <span className="bell-badge" aria-hidden="true">{badge}</span>}
          </button>
          <button type="button" className="avatar" onClick={() => go("anggota")} aria-label={`Anggota & akun (${me.user.name})`}>
            {me.user.name.slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>

      <main className="content">
        <Suspense fallback={<p className="center-inline muted">Memuat…</p>}>
        {page === "ringkasan" && (
          <SummaryPage me={me} month={month} onMonthChange={setMonth} refreshKey={refreshKey} onOpenTx={openTx} onGo={go} reminders={reminders} today={remToday} />
        )}
        {page === "transaksi" && (
          <TransactionsPage month={month} onMonthChange={setMonth} refreshKey={refreshKey} onOpenTx={openTx} />
        )}
        {page === "scan" && (
          <ScanPage onSaved={(d) => { setMonth(d.slice(0, 7)); setRefreshKey((k) => k + 1); }} onOpenTransactions={() => go("transaksi")} />
        )}
        {page === "laporan" && <ReportsPage onGoAI={() => go("analisa")} />}
        {page === "analisa" && <InsightsPage month={month} onMonthChange={setMonth} />}
        {page === "anggaran" && <BudgetsPage me={me} />}
        {page === "anggota" && <MembersPage me={me} onLogout={logout} />}
        {page === "pengingat" && <RemindersPage me={me} onMutate={() => setRefreshKey((k) => k + 1)} />}
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="Navigasi">
        {NAV.slice(0, 2).map((n) => (
          <button key={n.key} type="button" className={page === n.key ? "on" : undefined} aria-current={page === n.key ? "page" : undefined} onClick={() => go(n.key)}>
            <Icon name={n.icon} /><span>{n.label}</span>
          </button>
        ))}
        <button type="button" className="fab" onClick={() => openTx(null)} aria-label="Catat transaksi">
          <Icon name="plus" size={26} />
        </button>
        {NAV.slice(2, 4).map((n) => (
          <button key={n.key} type="button" className={page === n.key ? "on" : undefined} aria-current={page === n.key ? "page" : undefined} onClick={() => go(n.key)}>
            <Icon name={n.icon} /><span>{n.label}</span>
          </button>
        ))}
      </nav>

      <TxSheet open={sheet.open} editing={sheet.editing} onClose={closeTx} onSaved={onSaved} />
    </div>
  );
}
