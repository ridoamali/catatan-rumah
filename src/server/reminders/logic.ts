// Logika pengingat: perhitungan jatuh tempo berikutnya & klasifikasi status tampilan.
// Semua tanggal berformat YYYY-MM-DD (zona Asia/Jakarta), sama dengan transaksi.

import { REMINDER_REPEAT, type Reminder } from "../db/schema.js";

export type RepeatKind = (typeof REMINDER_REPEAT)[number];

/** Geser YYYY-MM-DD: +1 bulan (dipatok ke hari terakhir bila melebihi) atau +1 tahun. */
export function nextDueDate(dueDate: string, repeat: RepeatKind): string | null {
  if (repeat === "none") return null;
  const [y, m, d] = dueDate.split("-").map(Number);
  if (repeat === "monthly") {
    const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  }
  return `${y + 1}-${dueDate.slice(5)}`;
}

/** Jatuh tempo siklus berjalan. Untuk pengingat berulang, basisnya adalah
 * siklus yang terakhir diselesaikan (completedDueDate) bila ada — sehingga
 * selesai maupun dibuka kembali sama-sama menunjuk siklus berikutnya;
 * pengingat sekali selalu memakai dueDate asli. */
export function currentDueDate(r: Pick<Reminder, "dueDate" | "repeat" | "status" | "completedDueDate">): string {
  if (r.repeat === "none") return r.dueDate;
  if (r.completedDueDate) return nextDueDate(r.completedDueDate, r.repeat) ?? r.dueDate;
  return r.dueDate;
}

export type ReminderView = {
  id: string;
  title: string;
  amount: number | null;
  dueDate: string; // jatuh tempo siklus berjalan
  repeat: RepeatKind;
  note: string | null;
  status: "active" | "done";
  /** overdue | today | soon (≤7 hari) | upcoming */
  urgency: "overdue" | "today" | "soon" | "upcoming";
  daysLeft: number;
};

/** Klasifikasi tampilan terhadap tanggal hari ini (Asia/Jakarta). */
export function toView(r: Reminder, today: string): ReminderView {
  const dueDate = currentDueDate(r);
  // Positif = jatuh tempo masih di depan; negatif = sudah terlewat.
  const daysLeft = diffDays(dueDate, today);
  const urgency = daysLeft < 0 ? "overdue" : daysLeft === 0 ? "today" : daysLeft <= 7 ? "soon" : "upcoming";
  return {
    id: r.id,
    title: r.title,
    amount: r.amount,
    dueDate,
    repeat: r.repeat as RepeatKind,
    note: r.note,
    status: r.status,
    urgency,
    daysLeft,
  };
}

/** Selisih hari between dua YYYY-MM-DD (a - b), berbasis UTC agar deterministik. */
export function diffDays(a: string, b: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(a) - parse(b)) / 86_400_000);
}
