import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { api, errText } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { PasswordInput } from "./ui";

/** Covers the app while the vault is locked. Open terminals keep running underneath. */
export function LockScreen() {
  const t = useT();
  const load = useStore((s) => s.load);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw) return;
    setBusy(true); setErr("");
    try { await api.vaultUnlock(pw); setPw(""); await load(); }
    catch (e2) { setErr(errText(e2)); }
    setBusy(false);
  };
  return (
    <div className="lock">
      <form className="lock-card" onSubmit={submit}>
        <div className="lock-ico"><Lock size={22} /></div>
        <h2>{t("lock.title")}</h2>
        <p>{t("lock.body")}</p>
        <PasswordInput value={pw} onChange={setPw} autoFocus placeholder={t("lock.placeholder")} />
        {err && <div className="lock-err">{err}</div>}
        <button className="btn primary" type="submit" disabled={busy || !pw}>{busy ? <span className="mini-spin" /> : null}{t("lock.unlock")}</button>
      </form>
    </div>
  );
}

/** Locks the vault after `minutes` without keyboard/mouse activity (master-password mode only). */
export function useAutoLock() {
  const status = useStore((s) => s.vault?.status);
  const minutes = useStore((s) => s.vault?.settings.autoLockMin ?? 0);
  const load = useStore((s) => s.load);
  useEffect(() => {
    if (!status || status.mode !== "master" || status.locked || !minutes) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ["keydown", "mousedown", "mousemove", "wheel"] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true, capture: true }));
    const iv = window.setInterval(() => {
      if (Date.now() - last > minutes * 60_000) api.vaultLock().then(load).catch(() => {});
    }, 15_000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump, { capture: true })); clearInterval(iv); };
  }, [status, minutes, load]);
}
