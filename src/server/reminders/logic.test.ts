// Tes unit logika pengingat: perhitungan jatuh tempo berikutnya & klasifikasi.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentDueDate, diffDays, nextDueDate, toView } from "./logic.js";
import type { Reminder } from "../db/schema.js";

const rem = (over: Partial<Reminder>): Reminder => ({
  id: "r1",
  householdId: "hh1",
  createdBy: null,
  title: "Listrik",
  amount: 350000,
  dueDate: "2026-10-25",
  repeat: "none",
  note: null,
  status: "active",
  completedAt: null,
  completedDueDate: null,
  createdAt: new Date(),
  updatedAt: null,
  ...over,
});

describe("nextDueDate", () => {
  it("sekali → null (tidak berulang)", () => {
    assert.equal(nextDueDate("2026-10-25", "none"), null);
  });
  it("monthly: bulan biasa", () => {
    assert.equal(nextDueDate("2026-10-25", "monthly"), "2026-11-25");
  });
  it("monthly: roll over tahun", () => {
    assert.equal(nextDueDate("2026-12-10", "monthly"), "2027-01-10");
  });
  it("monthly: hari 31 dipatok ke akhir bulan pendek", () => {
    assert.equal(nextDueDate("2026-01-31", "monthly"), "2026-02-28");
    assert.equal(nextDueDate("2024-01-31", "monthly"), "2024-02-29"); // kabisat
  });
  it("yearly: +1 tahun pada tanggal sama", () => {
    assert.equal(nextDueDate("2026-02-14", "yearly"), "2027-02-14");
  });
});

describe("diffDays", () => {
  it("positif = a setelah b", () => {
    assert.equal(diffDays("2026-10-26", "2026-10-25"), 1);
    assert.equal(diffDays("2026-10-25", "2026-10-25"), 0);
    assert.equal(diffDays("2026-10-24", "2026-10-25"), -1);
  });
});

describe("toView", () => {
  it("aktif belum jatuh tempo > 7 hari → upcoming", () => {
    const v = toView(rem({}), "2026-10-10");
    assert.equal(v.urgency, "upcoming");
    assert.equal(v.daysLeft, 15);
  });
  it("≤7 hari → soon; hari-H → today", () => {
    assert.equal(toView(rem({}), "2026-10-20").urgency, "soon");
    assert.equal(toView(rem({}), "2026-10-25").urgency, "today");
  });
  it("lewat jatuh tempo → overdue dengan daysLeft negatif", () => {
    const v = toView(rem({}), "2026-10-28");
    assert.equal(v.urgency, "overdue");
    assert.equal(v.daysLeft, -3);
  });
  it("pengingat sekali yang selesai tetap menunjukkan dueDate asli", () => {
    const v = toView(rem({ status: "done", completedDueDate: "2026-10-25" }), "2026-10-28");
    assert.equal(v.dueDate, "2026-10-25");
    assert.equal(v.status, "done");
  });
  it("bulanan selesai siklus ini → jatuh tempo berikutnya dari completedDueDate", () => {
    const v = toView(
      rem({ repeat: "monthly", status: "done", completedDueDate: "2026-10-25" }),
      "2026-10-28",
    );
    assert.equal(v.dueDate, "2026-11-25");
    assert.equal(v.status, "done");
  });
  it("bulanan selesai tanpa completedDueDate (data lama) → tetap dueDate asli", () => {
    const v = toView(rem({ repeat: "monthly", status: "done" }), "2026-10-28");
    assert.equal(v.dueDate, "2026-10-25");
  });
  it("tahunan selesai → +1 tahun", () => {
    const v = toView(
      rem({ dueDate: "2026-12-24", repeat: "yearly", status: "done", completedDueDate: "2026-12-24" }),
      "2026-12-26",
    );
    assert.equal(v.dueDate, "2027-12-24");
  });
  it("currentDueDate: aktif berulang tetap di siklus dueDate (belum digeser)", () => {
    assert.equal(currentDueDate(rem({ repeat: "monthly", dueDate: "2026-09-25" })), "2026-09-25");
  });
});
