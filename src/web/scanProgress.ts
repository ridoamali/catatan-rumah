import { useCallback, useEffect, useRef, useState } from "react";

// Indikator progres scan.
// - Kompres foto (0–8%) & upload (8–30%): progres NYATA (byte terkirim).
// - Menunggu OCR (30–95%): ESTIMASI dari rata-rata durasi OCR sebelumnya di perangkat ini.
//   Kurva melambat mendekati 95% dan tidak pernah lewat 95% sebelum hasil datang.
// - 100% hanya saat hasil benar-benar diterima.

export const STAGES = [
  // Batas dipilih agar pada scan berdurasi normal keempat tahap terlihat:
  // memuat (upload) → memindai (~0–35% waktu OCR) → merapikan (~35–80%) → hampir selesai (sisa).
  { key: "load", label: "Memuat foto", until: 30 },
  { key: "scan", label: "Memindai nota", until: 65 },
  { key: "refine", label: "Merapikan hasil", until: 85 },
  { key: "almost", label: "Hampir selesai", until: 100 },
] as const;

const STORE_KEY = "cr_ocr_ms";
const DEFAULT_MS = 6000;
const CAP_WAITING = 95;

function readExpected(): number {
  try {
    const v = Number(localStorage.getItem(STORE_KEY));
    return Number.isFinite(v) && v >= 1500 && v <= 90_000 ? v : DEFAULT_MS;
  } catch {
    return DEFAULT_MS;
  }
}
function recordDuration(ms: number) {
  try {
    const next = Math.round(readExpected() * 0.7 + Math.min(Math.max(ms, 1500), 90_000) * 0.3);
    localStorage.setItem(STORE_KEY, String(next));
  } catch {
    /* penyimpanan browser tidak tersedia: tetap pakai default */
  }
}

/** 1 − e^(−2.3·t/E): ≈90% dari rentang tercapai saat t = durasi yang diharapkan, lalu melambat. */
export const waitingPct = (elapsedMs: number, expectedMs: number) =>
  Math.min(CAP_WAITING, 30 + 65 * (1 - Math.exp((-2.3 * elapsedMs) / expectedMs)));

export function stageIndex(pct: number) {
  const i = STAGES.findIndex((s) => pct < s.until);
  return i === -1 ? STAGES.length - 1 : i;
}

export function useScanProgress() {
  const [pct, setPct] = useState(0);
  const [done, setDone] = useState(false);
  const waitStart = useRef<number | null>(null);
  const expected = useRef(DEFAULT_MS);
  const raf = useRef<number | null>(null);

  // Persen hanya boleh naik.
  const bump = useCallback((v: number) => setPct((p) => Math.max(p, Math.min(100, v))), []);

  const stopTicker = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  };
  useEffect(() => stopTicker, []);

  const tick = useCallback(() => {
    if (waitStart.current === null) return;
    bump(waitingPct(performance.now() - waitStart.current, expected.current));
    raf.current = requestAnimationFrame(tick);
  }, [bump]);

  return {
    pct: Math.floor(pct),
    done,
    stage: stageIndex(pct),
    start() {
      stopTicker();
      waitStart.current = null;
      expected.current = readExpected();
      setDone(false);
      setPct(2);
    },
    compressed: () => bump(8),
    uploading: (ratio: number) => bump(8 + 22 * ratio),
    uploaded() {
      bump(30);
      if (waitStart.current === null) {
        waitStart.current = performance.now();
        raf.current = requestAnimationFrame(tick);
      }
    },
    finish() {
      if (waitStart.current !== null) recordDuration(performance.now() - waitStart.current);
      waitStart.current = null;
      stopTicker();
      setPct(100);
      setDone(true);
    },
    reset() {
      waitStart.current = null;
      stopTicker();
      setPct(0);
      setDone(false);
    },
  };
}
