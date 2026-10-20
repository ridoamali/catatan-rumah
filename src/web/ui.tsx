import { useEffect, useRef, type ReactNode } from "react";

// Emoji per kategori (dicocokkan dari nama; kategori buatan sendiri memakai label default).
const EMOJI: Record<string, string> = {
  "belanja dapur": "🛒",
  "makan di luar": "🍜",
  transportasi: "🛵",
  "listrik & air": "💡",
  "internet & pulsa": "📶",
  kesehatan: "💊",
  pendidikan: "🎓",
  "kebutuhan rumah": "🏠",
  hiburan: "🎬",
  cicilan: "💳",
  gaji: "💼",
  "usaha / freelance": "💻",
};
export function categoryEmoji(name: string | null | undefined, kind: "expense" | "income" = "expense") {
  if (!name) return kind === "income" ? "✨" : "🧾";
  const key = name.trim().toLowerCase();
  if (key === "lain-lain") return kind === "income" ? "✨" : "📦";
  return EMOJI[key] ?? "🏷️";
}

// Ikon garis 24px, stroke mengikuti currentColor.
const paths = {
  home: "M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  wallet: "M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5ZM16 13.5h.01",
  users: "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.6a3 3 0 0 1 0 5.8",
  plus: "M12 5v14M5 12h14",
  chevronLeft: "m14.5 6-6 6 6 6",
  chevronRight: "m9.5 6 6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-3.5-3.5",
  scan: "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M8 12h8",
  chart: "M5 19V11M12 19V5M19 19v-6",
  sparkle: "M12 4.5 13.6 9a2 2 0 0 0 1.4 1.4l4.5 1.6-4.5 1.6a2 2 0 0 0-1.4 1.4L12 19.5 10.4 15A2 2 0 0 0 9 13.6L4.5 12 9 10.4A2 2 0 0 0 10.4 9z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  eyeOff: "M4 4l16 16M9.9 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.5 17.5 0 0 1-3 3.6M6.1 7.6A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5c1 0 2-.2 2.9-.5M9.9 9.4a2.5 2.5 0 0 0 3.4 3.4",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10",
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

// Bottom sheet (mobile) / dialog (desktop). Escape & klik latar menutup; fokus dikembalikan.
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("[data-autofocus], input, button")?.focus());
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Tutup"><Icon name="close" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
