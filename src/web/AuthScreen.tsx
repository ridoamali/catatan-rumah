import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

type Mode = "setup" | "login" | "join";

const COPY: Record<Mode, { title: string; sub: string; cta: string }> = {
  setup: { title: "Mulai catat rumah tanggamu", sub: "Akun pertama jadi owner. Anggota keluarga lain bergabung lewat kode undangan.", cta: "Buat rumah tangga" },
  login: { title: "Selamat datang lagi", sub: "Masuk untuk melihat catatan rumah tanggamu.", cta: "Masuk" },
  join: { title: "Gabung ke rumah tangga", sub: "Masukkan kode undangan dari owner.", cta: "Gabung" },
};

export default function AuthScreen({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<Mode>(needsSetup ? "setup" : "login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError(null);
    try {
      await api(`/api/auth/${mode}`, { body });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.fields ? Object.values(err.fields).flat().join(" ") || err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const c = COPY[mode];
  return (
    <div className="auth">
      <div className="auth-side" aria-hidden="true">
        <div className="wordmark big">catatan rumah<span>.</span></div>
        <p>Belanja dapur, tagihan, dan gaji dalam satu catatan bersama keluarga.</p>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark auth-mobile-mark">catatan rumah<span>.</span></div>
        <h1>{c.title}</h1>
        <p className="hint">{c.sub}</p>

        {mode === "join" && (
          <label className="field">
            <span>Kode undangan</span>
            <input name="code" placeholder="ABCD-EFGH" required autoComplete="off" />
          </label>
        )}
        {mode === "setup" && (
          <label className="field">
            <span>Nama rumah tangga</span>
            <input name="householdName" placeholder="Keluarga Rido" required />
          </label>
        )}
        {mode !== "login" && (
          <label className="field">
            <span>Nama kamu</span>
            <input name="name" required autoComplete="name" />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" required minLength={mode === "login" ? 1 : 8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={mode === "login" ? undefined : "Minimal 8 karakter"} />
        </label>

        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn primary wide" disabled={busy}>{busy ? "Memproses…" : c.cta}</button>

        {!needsSetup && (
          <p className="switch">
            {mode === "login" ? (
              <>Punya kode undangan? <button type="button" className="text-btn" onClick={() => setMode("join")}>Gabung</button></>
            ) : (
              <>Sudah punya akun? <button type="button" className="text-btn" onClick={() => setMode("login")}>Masuk</button></>
            )}
          </p>
        )}
      </form>
    </div>
  );
}
