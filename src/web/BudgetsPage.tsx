import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Budget, type Category, type Kind, type Me } from "./api";
import { formatNum, formatRp, parseAmount } from "./format";
import { categoryEmoji } from "./ui";

export default function BudgetsPage({ me }: { me: Me }) {
  const isOwner = me.user.role === "owner";
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cats, setCats] = useState<Category[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<Kind>("expense");

  async function load() {
    const [b, c] = await Promise.all([
      api<{ budgets: Budget[] }>("/api/budgets"),
      api<{ categories: Category[] }>("/api/categories"),
    ]);
    setBudgets(b.budgets);
    setDrafts(Object.fromEntries(b.budgets.map((x) => [x.categoryId, x.monthlyAmount ? formatNum(x.monthlyAmount) : ""])));
    setCats(c.categories);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function save(b: Budget) {
    setError(null);
    const amount = parseAmount(drafts[b.categoryId] ?? "") ?? 0;
    if (amount === b.monthlyAmount) return;
    try {
      await api(`/api/budgets/${b.categoryId}`, { method: "PUT", body: { monthlyAmount: amount } });
      setBudgets((all) => all.map((x) => (x.categoryId === b.categoryId ? { ...x, monthlyAmount: amount } : x)));
      setSaved(b.categoryId);
      setTimeout(() => setSaved((s) => (s === b.categoryId ? null : s)), 1600);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addCategory(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name") ?? "");
    setError(null);
    try {
      await api("/api/categories", { body: { name, kind: newKind } });
      form.reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.fields ? Object.values(err.fields).flat().join(" ") : (err as Error).message);
    }
  }

  async function toggleArchive(c: Category) {
    setError(null);
    try {
      await api(`/api/categories/${c.id}`, { method: "PATCH", body: { archived: !c.archived } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const total = budgets.reduce((s, b) => s + b.monthlyAmount, 0);

  return (
    <>
      <div className="page-head">
        <h1>Anggaran</h1>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="block">
        <div className="budget-total">
          <span>Total per bulan</span>
          <strong className="num">{formatRp(total)}</strong>
        </div>
        <p className="hint">
          {isOwner
            ? "Isi batas bulanan tiap kategori. Kosongkan untuk tanpa batas. Tersimpan otomatis."
            : "Hanya owner yang bisa mengubah anggaran."}
        </p>
        <ul className="budget-rows">
          {budgets.map((b) => (
            <li key={b.categoryId}>
              <span className="emoji-dot" aria-hidden="true">{categoryEmoji(b.name)}</span>
              <span className="grow">{b.name}</span>
              {isOwner ? (
                <label className="money-input">
                  <span aria-hidden="true">Rp</span>
                  <input
                    inputMode="numeric"
                    aria-label={`Anggaran ${b.name}`}
                    placeholder="—"
                    value={drafts[b.categoryId] ?? ""}
                    onChange={(e) => {
                      const n = parseAmount(e.target.value);
                      setDrafts({ ...drafts, [b.categoryId]: n === null ? "" : formatNum(n) });
                    }}
                    onBlur={() => save(b)}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                </label>
              ) : (
                <span className="num">{b.monthlyAmount ? formatRp(b.monthlyAmount) : "—"}</span>
              )}
              <span className="saved" aria-live="polite">{saved === b.categoryId ? "Tersimpan" : ""}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="block">
        <div className="block-head"><h2>Kategori</h2></div>
        <form className="add-cat" onSubmit={addCategory}>
          <input name="name" placeholder="Nama kategori baru" maxLength={40} required aria-label="Nama kategori baru" />
          <div className="seg small" role="radiogroup" aria-label="Jenis kategori">
            {(["expense", "income"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={newKind === k} className={newKind === k ? "on" : undefined} onClick={() => setNewKind(k)}>
                {k === "expense" ? "Keluar" : "Masuk"}
              </button>
            ))}
          </div>
          <button type="submit" className="btn primary">Tambah</button>
        </form>
        {(["expense", "income"] as const).map((k) => (
          <div key={k} className="chips-block">
            <h3>{k === "expense" ? "Pengeluaran" : "Pemasukan"}</h3>
            <ul className="chips">
              {cats.filter((c) => c.kind === k).map((c) => (
                <li key={c.id} className={c.archived ? "archived" : undefined}>
                  <span aria-hidden="true">{categoryEmoji(c.name, c.kind)}</span>
                  <span className="chip-name">{c.name}</span>
                  <button type="button" className="chip-action" onClick={() => toggleArchive(c)} aria-label={`${c.archived ? "Aktifkan" : "Arsipkan"} ${c.name}`}>
                    {c.archived ? "Aktifkan" : "Arsipkan"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}
