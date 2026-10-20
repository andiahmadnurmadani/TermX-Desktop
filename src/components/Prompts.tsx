import { useEffect, useState } from "react";
import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { api, events } from "../lib/api";
import { useT } from "../lib/i18n";
import { Modal, PasswordInput, Switch } from "./ui";

interface HostKeyP { id: string; hostPort: string; keyType: string; fingerprint: string; changed: boolean; oldFingerprint?: string | null }
interface PassP { id: string; title: string; message: string; allowSave: boolean }

/** Backend-initiated dialogs (host key trust, password). Queued in arrival order. */
export function Prompts() {
  const t = useT();
  const [hk, setHk] = useState<HostKeyP[]>([]);
  const [pw, setPw] = useState<PassP[]>([]);
  const [pass, setPass] = useState("");
  const [save, setSave] = useState(false);

  useEffect(() => {
    const subs: Promise<() => void>[] = [
      events.on<HostKeyP>("prompt:hostkey", (p) => setHk((q) => [...q, p])),
      events.on<PassP>("prompt:password", (p) => { setPass(""); setSave(false); setPw((q) => [...q, p]); }),
    ];
    return () => { subs.forEach((s) => s.then((u) => u())); };
  }, []);

  const h = hk[0];
  if (h) {
    const answer = (ok: boolean) => { api.answerPrompt(h.id, ok); setHk((q) => q.slice(1)); };
    return (
      <Modal wide>
        {h.changed ? (
          <div className="warn-box"><ShieldAlert size={20} /><div><b>{t("prompt.hostkey.changed")}</b><div style={{ fontSize: 12 }}>{t("prompt.hostkey.changedBody", { host: h.hostPort })}</div></div></div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}><ShieldQuestion size={20} color="var(--accent)" /><h3 style={{ margin: 0 }}>{t("prompt.hostkey.new")}</h3></div>
            <p>{t("prompt.hostkey.newBody", { host: h.hostPort })}</p>
          </>
        )}
        {h.changed && h.oldFingerprint && (<><div className="label" style={{ marginBottom: 4 }}>{t("prompt.hostkey.old")}</div><div className="fp" style={{ marginBottom: 10 }}>{h.oldFingerprint}</div></>)}
        <div className="label" style={{ marginBottom: 4 }}>{h.changed ? t("prompt.hostkey.new2") : h.keyType}</div>
        <div className={"fp" + (h.changed ? " bad" : "")}>{h.fingerprint}</div>
        <div className="actions">
          <button className="btn" onClick={() => answer(false)}>{t("prompt.hostkey.reject")}</button>
          <button className={"btn " + (h.changed ? "danger solid" : "primary")} onClick={() => answer(true)}>{t("prompt.hostkey.trust")}</button>
        </div>
      </Modal>
    );
  }
  const p = pw[0];
  if (p) {
    const answer = (ok: boolean) => { api.answerPrompt(p.id, ok ? { password: pass, save } : null); setPw((q) => q.slice(1)); setPass(""); setSave(false); };
    return (
      <Modal onClose={() => answer(false)}>
        <form onSubmit={(e) => { e.preventDefault(); answer(true); }}>
          <h3>{p.title}</h3>
          {p.message && <p style={{ marginBottom: 12 }}>{p.message}</p>}
          <PasswordInput value={pass} onChange={setPass} autoFocus />
          {p.allowSave && <div className="toggle-row" style={{ marginTop: 14 }}><span>{t("prompt.password.save")}</span><Switch on={save} onChange={setSave} /></div>}
          <div className="actions">
            <button type="button" className="btn" onClick={() => answer(false)}>{t("common.cancel")}</button>
            <button type="submit" className="btn primary">{t("prompt.password.ok")}</button>
          </div>
        </form>
      </Modal>
    );
  }
  return null;
}
