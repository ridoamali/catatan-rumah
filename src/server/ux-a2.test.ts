// Tes helper tampilan badge overdue (A2 mobile UX): overdueCount & badgeLabel.
// Urgensi server (toView) sudah diuji di reminders/logic.test.ts; di sini kita
// uji pemetaan ke badge sesuai desain A2: due today BUKAN overdue, 1–9 angka,
// 10+ → "9+", 0 → tanpa badge.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { badgeLabel, overdueCount, type ReminderItem } from "../web/RemindersPage.js";

const item = (over: Partial<ReminderItem>): ReminderItem => ({
  id: "r",
  title: "Listrik",
  amount: null,
  dueDate: "2026-10-25",
  repeat: "none",
  note: null,
  status: "active",
  urgency: "upcoming",
  daysLeft: 10,
  ...over,
});

describe("overdueCount (badge lonceng A2)", () => {
  it("hanya pengingat aktif berurgensi overdue yang dihitung", () => {
    const items = [
      item({ id: "1", urgency: "overdue", daysLeft: -3 }),
      item({ id: "2", urgency: "today", daysLeft: 0 }),      // hari ini ≠ terlambat
      item({ id: "3", urgency: "soon", daysLeft: 5 }),
      item({ id: "4", urgency: "overdue", status: "done" }), // selesai tak dihitung
      item({ id: "5", urgency: "overdue", daysLeft: -1 }),
    ];
    assert.equal(overdueCount(items), 2);
  });
  it("0 saat tidak ada yang terlambat → tanpa badge", () => {
    assert.equal(overdueCount([item({ urgency: "today" }), item({ urgency: "soon" })]), 0);
    assert.equal(badgeLabel(0), null);
  });
  it("1 → tampil '1'", () => {
    assert.equal(badgeLabel(overdueCount([item({ urgency: "overdue" })])), "1");
  });
  it("9 → tampil '9'", () => {
    const nine = Array.from({ length: 9 }, (_, i) => item({ id: String(i), urgency: "overdue" }));
    assert.equal(badgeLabel(overdueCount(nine)), "9");
  });
  it("10+ → tampil '9+'", () => {
    const ten = Array.from({ length: 10 }, (_, i) => item({ id: String(i), urgency: "overdue" }));
    assert.equal(badgeLabel(overdueCount(ten)), "9+");
  });
});

describe("kartu Pengingat Terdekat (urutan & limit)", () => {
  // Logika persis seperti SummaryPage.upcomingReminders.
  const pick = (items: ReminderItem[]) =>
    items.filter((r) => r.status === "active")
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
      .slice(0, 2);

  it("maksimal 2, urut jatuh tempo, overdue di depan, selesai tidak muncul", () => {
    const items = [
      item({ id: "a", dueDate: "2026-11-20", urgency: "upcoming" }),
      item({ id: "b", dueDate: "2026-10-01", urgency: "overdue", daysLeft: -24 }),
      item({ id: "c", dueDate: "2026-11-05", status: "done" }),
      item({ id: "d", dueDate: "2026-11-05", urgency: "soon", daysLeft: 11 }),
      item({ id: "e", dueDate: "2026-12-01", urgency: "upcoming" }),
    ];
    const picked = pick(items);
    assert.deepEqual(picked.map((r) => r.id), ["b", "d"]);
  });
  it("tanpa pengingat aktif → kartu tidak tampil (kosong)", () => {
    assert.equal(pick([item({ status: "done" })]).length, 0);
  });
  it("nominal opsional: null maupun angka diterima tanpa memengaruhi urutan", () => {
    const items = [
      item({ id: "a", amount: null, dueDate: "2026-11-02" }),
      item({ id: "b", amount: 250000, dueDate: "2026-11-01" }),
    ];
    assert.deepEqual(pick(items).map((r) => r.id), ["b", "a"]);
  });
});
