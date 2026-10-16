import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatRp } from "./format";

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------

/** "1,2 jt", "450 rb", "12 rb" — label sumbu ringkas. */
export function compactRp(n: number) {
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)} M`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)} jt`;
  if (n >= 1_000) return `${trim(n / 1_000)} rb`;
  return String(n);
}
const trim = (x: number) => (Math.round(x * 10) / 10).toString().replace(".", ",");

/** Batas atas "bagus" untuk sumbu: 1, 2, 2.5, 5 × 10^k. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Bar vertikal: ujung atas membulat 4px, bawah rata di garis dasar. */
function barPath(x: number, y: number, w: number, h: number) {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ---------------------------------------------------------------------------
// Grouped bar: tren bulanan (Keluar vs Masuk)
// ---------------------------------------------------------------------------

export type Series = { key: string; label: string; colorVar: string };

export function GroupedBars({
  data, series, xLabel, xLabelLong, ariaLabel,
}: {
  data: Record<string, number | string>[];
  series: Series[];
  xLabel: (row: Record<string, number | string>, i: number) => string;
  xLabelLong: (row: Record<string, number | string>) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const H = 220, top = 12, bottom = 28, left = 44, right = 4;
  const plotW = Math.max(0, width - left - right), plotH = H - top - bottom;
  const max = niceMax(Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const colW = data.length ? plotW / data.length : 0;
  const gap = 2;
  const barW = Math.max(4, Math.min(28, (colW - 14 - gap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + gap * (series.length - 1);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const everyOther = data.length > 8 && width < 640;

  return (
    <div className="gb" ref={ref}>
      <Legend series={series} />
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={ariaLabel} onPointerLeave={() => setActive(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis-base" : "grid"} />
              <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">{compactRp(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = left + i * colW;
            const gx = cx + (colW - groupW) / 2;
            return (
              <g key={i}>
                {active === i && <rect x={cx + 2} y={top} width={colW - 4} height={plotH} rx={8} className="col-hover" />}
                {series.map((s, si) => {
                  const v = Number(d[s.key]) || 0;
                  return <path key={s.key} d={barPath(gx + si * (barW + gap), y(v), barW, y(0) - y(v))} style={{ fill: `var(${s.colorVar})` }} />;
                })}
                {(!everyOther || i % 2 === 0 || i === data.length - 1) && (
                  <text x={cx + colW / 2} y={H - 8} textAnchor="middle" className="tick x">{xLabel(d, i)}</text>
                )}
                {/* Area hit = seluruh kolom bulan (lebih besar dari bar). */}
                <rect
                  x={cx} y={top} width={colW} height={plotH + bottom} fill="transparent" tabIndex={0}
                  aria-label={`${xLabelLong(d)}: ${series.map((s) => `${s.label} ${formatRp(Number(d[s.key]) || 0)}`).join(", ")}`}
                  onPointerEnter={() => setActive(i)} onPointerMove={() => setActive(i)}
                  onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                  className="hit"
                />
              </g>
            );
          })}
        </svg>
      )}
      {active !== null && data[active] && (
        <div
          className="tooltip" role="presentation"
          style={{ left: Math.min(Math.max(left + active * colW + colW / 2, 90), width - 90), top: 34 }}
        >
          <div className="tt-title">{xLabelLong(data[active])}</div>
          {series.map((s) => (
            <div key={s.key} className="tt-row">
              <span className="tt-key" style={{ background: `var(${s.colorVar})` }} />
              <strong className="num">{formatRp(Number(data[active][s.key]) || 0)}</strong>
              <span className="tt-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="legend">
      {series.map((s) => (
        <li key={s.key}><span className="swatch" style={{ background: `var(${s.colorVar})` }} />{s.label}</li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Bar horizontal berperingkat: label kiri, bar, nilai langsung di kanan.
// ---------------------------------------------------------------------------

export function RankBars({
  rows, colorVar = "--series-1", ariaLabel,
}: {
  rows: { key: string; label: string; value: number; lead?: ReactNode; sub?: string }[];
  colorVar?: string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <ul className="rank" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key} tabIndex={0} aria-label={`${r.label}: ${formatRp(r.value)}${r.sub ? `, ${r.sub}` : ""}`}>
          {r.lead && <span className="rank-lead" aria-hidden="true">{r.lead}</span>}
          <div className="rank-body">
            <div className="rank-head">
              <span className="rank-label">{r.label}</span>
              <span className="rank-value num">
                {formatRp(r.value)}
                <span className="rank-share">{total ? ` ${Math.round((r.value / total) * 100)}%` : ""}</span>
              </span>
            </div>
            <div className="rank-track"><span style={{ width: `${(r.value / max) * 100}%`, background: `var(${colorVar})` }} /></div>
            {r.sub && <span className="rank-sub">{r.sub}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Bingkai chart dengan tombol Grafik/Tabel (tabel = alternatif aksesibel).
// ---------------------------------------------------------------------------

export function ChartCard({
  title, sub, chart, table,
}: { title: string; sub?: string; chart: ReactNode; table?: ReactNode }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <section className="block chart-card">
      <div className="block-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="chart-sub">{sub}</p>}
        </div>
        {table && (
          <div className="seg small" role="radiogroup" aria-label={`Tampilan ${title}`}>
            {(["chart", "table"] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? "on" : undefined} onClick={() => setView(v)}>
                {v === "chart" ? "Grafik" : "Tabel"}
              </button>
            ))}
          </div>
        )}
      </div>
      {view === "chart" || !table ? chart : table}
    </section>
  );
}
