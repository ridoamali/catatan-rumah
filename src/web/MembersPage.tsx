import { useEffect, useState } from "react";
import { api, type Me, type Member } from "./api";
import { Icon } from "./ui";

export default function MembersPage({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ members: Member[] }>("/api/household/members").then((r) => setMembers(r.members)).catch((e) => setError(e.message));
  }, []);

  async function createInvite() {
    setError(null);
    setCopied(false);
    try {
      setInvite(await api("/api/household/invites", { body: { role: "member" } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copy() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Anggota</h1>
      </div>
      <p className="lede">{me.household.name}</p>

      <section className="block">
        <ul className="member-rows">
          {members.map((m) => (
            <li key={m.id}>
              <span className="avatar" aria-hidden="true">{m.name.slice(0, 1).toUpperCase()}</span>
              <span className="grow">
                <span className="member-name">{m.name}{m.id === me.user.id && <span className="you"> (kamu)</span>}</span>
                <span className="member-email">{m.email}</span>
              </span>
              <span className={`role ${m.role}`}>{m.role === "owner" ? "Owner" : "Anggota"}</span>
            </li>
          ))}
        </ul>
      </section>

      {me.user.role === "owner" && (
        <section className="block">
          <div className="block-head"><h2>Undang anggota</h2></div>
          <p className="hint">Kode sekali pakai, berlaku 7 hari, dan hanya ditampilkan sekali. Anggota baru memasukkan kode ini di layar masuk.</p>
          {invite && (
            <div className="invite-code" data-testid="invite-code">
              <strong>{invite.code}</strong>
              <button type="button" className="btn ghost" onClick={copy}>{copied ? "Tersalin" : "Salin kode"}</button>
              <small>Berlaku sampai {new Date(invite.expiresAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</small>
            </div>
          )}
          <button type="button" className={`btn ${invite ? "ghost" : "primary"}`} onClick={createInvite}>
            {invite ? "Buat kode baru" : "Buat kode undangan"}
          </button>
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <button type="button" className="btn ghost logout-mobile" onClick={onLogout}><Icon name="logout" size={18} />Keluar</button>
    </>
  );
}
