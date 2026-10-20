import { useEffect, useState } from "react";
import { api } from "./api";
import { ChartCard, GroupedBars, RankBars } from "./charts";
import { currentMonth, formatNum, formatRp, shiftMonth } from "./format";
import { categoryEmoji, Icon } from "./ui";

type Report = {
  from: string; to: string; months: string[];
  totals: { expense: number; income: number; net: number; avgMonthlyExpense: number };
  monthly: { month: string; expense: number; income: number }[];
  byCategory: { categoryId: string; name: string; total: number; count: number }[];
  byMember: { userId: string; name: string; total: number; count: number }[];
  topMerchants: { name: string; total: number; count: number }[];
  itemPrices: {
    name: string; times: number; firstPrice: number; firstOn: string; lastPrice: number; lastOn: string;
    minPrice: number; maxPrice: number; changePct: number;
  }[];
};

type Preset = "3" | "6" | "12" | "ytd";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "3", label: "3 bln" },
  { key: "6", label: "6 bln" },
  { key: "12", label: "12 bln" },
  { key: "ytd", label: "Tahun ini" },
];

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTHS_LONG = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const mShort = (m: string, withYear: boolean) => {
  const [y, mm] = m.split("-").map(Number);
  return withYear ? `${MONTHS_SHORT[mm - 1]} ${String(y).slice(2)}` : MONTHS_SHORT[mm - 1];
};
const mLong = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return `${MONTHS_LONG[mm - 1]} ${y}`;
};
const dShort = (d: string) => {
  const [, mm, dd] = d.split("-").map(Number);
  return `${dd} ${MONTHS_SHORT[mm - 1]} ${d.slice(2, 4)}`;
};

function rangeFor(p: Preset) {
  const to = currentMonth();
  if (p === "ytd") return { from: `${to.slice(0, 4)}-01`, to };
  return { from: shiftMonth(to, -(Number(p) - 1)), to };
}

export default function ReportsPage({ onGoAI }: { onGoAI?: () => void }) {
  const [preset, setPreset] = useState<Preset>("6");
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const { from, to } = rangeFor(preset);
    setError(null);
    api<Report>(`/api/reports?from=${from}&to=${to}`).then(setR).catch((e) => setError(e.message));
  }, [preset]);

  const empty = r && r.totals.expense === 0 && r.totals.income === 0;

  return (
    <div className="viz-root">
      <div className="page-head">
        <h1>Laporan</h1>
        <div className="seg small" role="radiogroup" aria-label="Rentang waktu">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" role="radio" aria-checked={preset === p.key} className={preset === p.key ? "on" : undefined} onClick={() => setPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {onGoAI && (
        <button type="button" className="ai-shortcut" onClick={onGoAI}>
          <Icon name="sparkle" size={18} />
          <span className="grow">
            <strong>Analisa AI</strong>
            <small>Sorotan, janggal, dan saran hemat dari data pengeluaranmu.</small>
          </span>
          <Icon name="chevronRight" size={16} />
        </button>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {r && (
        <>
          <p className="lede report-range">{mLong(r.from)} – {mLong(r.to)}</p>
          <div className="totals totals-4" data-testid="report-totals">
            <div><span>Total keluar</span><strong className="num">{formatRp(r.totals.expense)}</strong></div>
            <div><span>Rata-rata / bulan</span><strong className="num">{formatRp(r.totals.avgMonthlyExpense)}</strong></div>
            <div><span>Total masuk</span><strong className="num">{formatRp(r.totals.income)}</strong></div>
            <div><span>Selisih</span><strong className={`num ${r.totals.net < 0 ? "neg" : ""}`}>{r.totals.net < 0 ? "−" : ""}{formatRp(Math.abs(r.totals.net))}</strong></div>
          </div>

          {empty ? (
            <div className="empty"><p>Belum ada transaksi di rentang ini.</p></div>
          ) : (
            <>
              <ChartCard
                title="Tren bulanan"
                sub="Pengeluaran dan pemasukan per bulan"
                chart={
                  <GroupedBars
                    data={r.monthly}
                    series={[
                      { key: "expense", label: "Keluar", colorVar: "--series-1" },
                      { key: "income", label: "Masuk", colorVar: "--series-2" },
                    ]}
                    xLabel={(d, i) => mShort(String(d.month), i === 0 || String(d.month).endsWith("-01"))}
                    xLabelLong={(d) => mLong(String(d.month))}
                    ariaLabel={`Grafik pengeluaran dan pemasukan per bulan, ${mLong(r.from)} sampai ${mLong(r.to)}`}
                  />
                }
                table={
                  <table className="table data-table">
                    <thead><tr><th>Bulan</th><th className="right">Keluar</th><th className="right">Masuk</th></tr></thead>
                    <tbody>
                      {r.monthly.map((m) => (
                        <tr key={m.month}><td>{mLong(m.month)}</td><td className="right num">{formatRp(m.expense)}</td><td className="right num">{formatRp(m.income)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                }
              />

              <div className="report-grid">
                {r.byCategory.length > 0 && (
                  <ChartCard
                    title="Per kategori"
                    sub="Porsi pengeluaran"
                    chart={
                      <RankBars
                        ariaLabel="Pengeluaran per kategori"
                        rows={r.byCategory.map((c) => ({
                          key: c.categoryId, label: c.name, value: c.total,
                          lead: categoryEmoji(c.categoryId === "none" ? null : c.name),
                          sub: `${c.count} transaksi`,
                        }))}
                      />
                    }
                  />
                )}
                {r.byMember.length > 0 && (
                  <ChartCard
                    title="Per anggota"
                    sub="Pengeluaran yang dicatat tiap anggota"
                    chart={
                      <RankBars
                        ariaLabel="Pengeluaran per anggota"
                        rows={r.byMember.map((m) => ({
                          key: m.userId, label: m.name, value: m.total,
                          lead: <span className="avatar">{m.name.slice(0, 1).toUpperCase()}</span>,
                          sub: `${m.count} transaksi`,
                        }))}
                      />
                    }
                  />
                )}
              </div>

              {r.topMerchants.length > 0 && (
                <ChartCard
                  title="Toko teratas"
                  chart={
                    <RankBars
                      ariaLabel="Toko dengan pengeluaran terbesar"
                      rows={r.topMerchants.map((m, i) => ({ key: `${i}`, label: m.name, value: m.total, sub: `${m.count}× belanja` }))}
                    />
                  }
                />
              )}

              <section className="block">
                <div className="block-head">
                  <div>
                    <h2>Perubahan harga barang</h2>
                    <p className="chart-sub">Barang dari nota yang dibeli 2 kali atau lebih, harga satuan pertama vs terakhir</p>
                  </div>
                </div>
                {r.itemPrices.length === 0 ? (
                  <p className="hint">Belum cukup data. Scan nota belanja rutin agar perubahan harga terlihat.</p>
                ) : (
                  <table className="table data-table price-table">
                    <thead>
                      <tr><th>Barang</th><th className="right">Awal</th><th className="right">Terakhir</th><th className="right">Perubahan</th></tr>
                    </thead>
                    <tbody>
                      {r.itemPrices.map((p) => (
                        <tr key={p.name}>
                          <td>
                            <span className="item-name-cell">{p.name}</span>
                            <span className="item-meta">{p.times}× dibeli, {dShort(p.firstOn)} – {dShort(p.lastOn)}</span>
                          </td>
                          <td className="right num">{formatNum(p.firstPrice)}</td>
                          <td className="right num">{formatNum(p.lastPrice)}</td>
                          <td className="right">
                            <span className={`change ${p.changePct > 0 ? "up" : p.changePct < 0 ? "down" : ""}`}>
                              {p.changePct > 0 ? "▲ +" : p.changePct < 0 ? "▼ " : "■ "}
                              {String(p.changePct).replace(".", ",")}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
