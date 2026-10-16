import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { dateLabel, formatRp, monthLabel } from "./format";
import MonthPicker from "./MonthPicker";
import { Icon } from "./ui";

export type InsightResult = {
  summary: string;
  highlights: { type: "warning" | "info" | "good"; title: string; detail: string; category: string | null }[];
  anomalies: { date: string | null; merchant: string | null; amount: number | null; reason: string }[];
  tips: { title: string; detail: string; estimatedSaving: number | null }[];
};
export type InsightResp = {
  available: boolean;
  mock: boolean;
  insight: { id: string; month: string; createdAt: string; mock: boolean; result: InsightResult } | null;
};

// Progres analisa: estimasi dari lama analisa sebelumnya (disimpan di browser). Berhenti di 95% sampai hasil datang.
const STAGES = ["Mengumpulkan angka", "Membaca pola", "Menyusun saran", "Hampir selesai"];
const KEY = "cr_insight_ms";
const expected = () => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v >= 2000 && v <= 120_000 ? v : 12_000;
  } catch {
    return 12_000;
  }
};
const remember = (ms: number) => {
  try {
    localStorage.setItem(KEY, String(Math.round(expected() * 0.7 + Math.min(Math.max(ms, 2000), 120_000) * 0.3)));
  } catch {
    /* abaikan */
  }
};

function useAnalyzeProgress() {
  const [pct, setPct] = useState(0);
  const t0 = useRef(0);
  const raf = useRef<number | null>(null);
  const exp = useRef(12_000);
  const stop = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  };
  useEffect(() => stop, []);
  const loop = useCallback(() => {
    const t = performance.now() - t0.current;
    setPct((p) => Math.max(p, Math.min(95, 3 + 92 * (1 - Math.exp((-2.3 * t) / exp.current)))));
    raf.current = requestAnimationFrame(loop);
  }, []);
  return {
    pct: Math.floor(pct),
    stage: pct < 25 ? 0 : pct < 60 ? 1 : pct < 85 ? 2 : 3,
    start() {
      exp.current = expected();
      t0.current = performance.now();
      setPct(3);
      stop();
      raf.current = requestAnimationFrame(loop);
    },
    finish(ok: boolean) {
      stop();
      if (ok) remember(performance.now() - t0.current);
      setPct(ok ? 100 : 0);
    },
  };
}

const TYPE = {
  warning: { icon: "▲", label: "Perlu perhatian" },
  good: { icon: "✓", label: "Bagus" },
  info: { icon: "●", label: "Info" },
} as const;

export default function InsightsPage({ month, onMonthChange }: { month: string; onMonthChange: (m: string) => void }) {
  const [data, setData] = useState<InsightResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useAnalyzeProgress();

  useEffect(() => {
    setData(null);
    setError(null);
    api<InsightResp>(`/api/insights?month=${month}`).then(setData).catch((e) => setError(e.message));
  }, [month]);

  async function analyze() {
    setBusy(true);
    setError(null);
    progress.start();
    try {
      const r = await api<{ insight: InsightResp["insight"] }>("/api/insights", { body: { month } });
      progress.finish(true);
      await new Promise((res) => setTimeout(res, 350));
      setData((d) => (d ? { ...d, insight: r.insight } : d));
    } catch (e) {
      progress.finish(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ins = data?.insight;
  return (
    <>
      <div className="page-head">
        <h1>Analisa AI</h1>
        <MonthPicker month={month} onChange={onMonthChange} />
      </div>

      {data?.mock && <p className="mock-banner">Mode contoh: analisa belum tersambung ke n8n. Hasil di bawah dibuat dari aturan sederhana, bukan AI.</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {busy ? (
        <section className="block analyze-progress" aria-live="polite">
          <div className="scan-pct"><span className="num">{progress.pct}</span><small>%</small></div>
          <p className="scan-stage">{progress.pct >= 100 ? "Selesai" : `${STAGES[progress.stage]}…`}</p>
          <div className="scan-bar" role="progressbar" aria-label="Progres analisa" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}>
            <span style={{ width: `${progress.pct}%` }} />
          </div>
          <p className="hint small">Persentase adalah perkiraan dari lama analisa sebelumnya.</p>
        </section>
      ) : !ins ? (
        data && (
          <section className="block insight-empty">
            <div className="scan-illustration" aria-hidden="true"><Icon name="sparkle" size={40} /></div>
            <h2>Belum ada analisa untuk {monthLabel(month)}</h2>
            <p className="hint">AI membaca ringkasan pengeluaranmu lalu memberi sorotan, transaksi yang janggal, dan saran hemat.</p>
            <button type="button" className="btn primary" onClick={analyze} disabled={!data.available}>
              <Icon name="sparkle" size={18} />Analisa {monthLabel(month)}
            </button>
            {!data.available && <p className="hint small">Analisa AI belum diatur di server (N8N_INSIGHT_URL).</p>}
          </section>
        )
      ) : (
        <div className="insight">
          <p className="insight-summary">{ins.result.summary}</p>

          {ins.result.highlights.length > 0 && (
            <section className="block">
              <div className="block-head"><h2>Sorotan</h2></div>
              <ul className="highlights">
                {ins.result.highlights.map((h, i) => (
                  <li key={i} className={h.type}>
                    <span className="hl-badge"><span aria-hidden="true">{TYPE[h.type].icon}</span> {TYPE[h.type].label}</span>
                    <strong>{h.title}</strong>
                    <p>{h.detail}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {ins.result.anomalies.length > 0 && (
            <section className="block">
              <div className="block-head"><h2>Transaksi yang perlu dicek</h2></div>
              <ul className="anomalies">
                {ins.result.anomalies.map((a, i) => (
                  <li key={i}>
                    <div className="anom-head">
                      <span>{[a.merchant, a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? dateLabel(a.date) : a.date].filter(Boolean).join(", ") || "Transaksi"}</span>
                      {a.amount !== null && <strong className="num">{formatRp(a.amount)}</strong>}
                    </div>
                    <p>{a.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {ins.result.tips.length > 0 && (
            <section className="block">
              <div className="block-head"><h2>Saran hemat</h2></div>
              <ol className="tips">
                {ins.result.tips.map((t, i) => (
                  <li key={i}>
                    <strong>{t.title}</strong>
                    <p>{t.detail}</p>
                    {t.estimatedSaving ? <span className="saving">Potensi hemat ±{formatRp(t.estimatedSaving)}/bulan</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div className="insight-foot">
            <p className="hint small">
              Dibuat {new Date(ins.createdAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}
              {ins.mock ? " (contoh)" : " oleh AI"}. Angka dihitung oleh app; tafsiran AI bisa keliru, jadi cek sebelum memutuskan.
            </p>
            <button type="button" className="btn ghost" onClick={analyze}>Analisa ulang</button>
          </div>
        </div>
      )}

      <details className="privacy">
        <summary>Data apa yang dikirim ke AI?</summary>
        <p>
          Hanya ringkasan angka bulan ini: total, per kategori (dibanding rata-rata 3 bulan sebelumnya dan anggaran), 5 toko teratas,
          10 transaksi terbesar (tanggal, toko, kategori, nominal), dan perubahan harga barang dari nota. Catatan transaksi, nama, dan
          email anggota tidak dikirim.
        </p>
      </details>
    </>
  );
}
