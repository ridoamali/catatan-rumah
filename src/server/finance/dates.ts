// Utilitas tanggal berbasis string YYYY-MM-DD / YYYY-MM (tanpa jam, tanpa zona waktu).

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const isValidMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** Rentang [from, to) untuk satu bulan: { from: "2026-10-01", to: "2026-11-01" }. */
export function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

export function prevMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Tanggal hari ini di zona waktu tertentu (default Asia/Jakarta). */
export function todayIn(timeZone = "Asia/Jakarta") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
