import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Download, KeyRound, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { api, errText } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { confirmDialog } from "../lib/dialogs";
import { copyText } from "../lib/util";
import { EmptyState, Field, Modal, PasswordInput, Seg } from "./ui";

export function KeysView() {
  const t = useT();
  const { vault, run, toast } = useStore();
  const [dlg, setDlg] = useState<"gen" | "import" | { install: string } | null>(null);
  const keys = vault?.keys ?? [];
  const hosts = vault?.hosts ?? [];

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <h1>{t("keys.title")}</h1>
        <div className="sp" />
        <button className="btn" onClick={() => setDlg("import")}><Upload size={15} />{t("keys.import")}</button>
        <button className="btn primary" onClick={() => setDlg("gen")}><Sparkles size={15} />{t("keys.generate")}</button>
      </div>
      {keys.length === 0 ? (
        <EmptyState icon={<KeyRound size={26} />} title={t("keys.empty.title")} body={t("keys.empty.body")}
          action={<button className="btn primary" onClick={() => setDlg("gen")}><Plus size={15} />{t("keys.generate")}</button>} />
      ) : (
        <div className="panel list">
          {keys.map((k) => (
            <div className="li" key={k.id}>
              <div className="avatar" style={{ ["--hc" as string]: "var(--accent)", width: 36, height: 36 }}><KeyRound size={17} /></div>
              <div className="grow">
                <div className="ttl">{k.name} <span className="tag">{k.kind}</span></div>
                <div className="sub mono" style={{ fontSize: 11 }} title={k.fingerprint}>{k.fingerprint}</div>
                {k.installedOn.length > 0 && (
                  <div className="sub">{t("keys.installed")}: {k.installedOn.map((id) => hosts.find((h) => h.id === id)?.label).filter(Boolean).join(", ")}</div>
                )}
              </div>
              <button className="btn sm" onClick={async () => { await copyText(k.publicKey); toast(t("common.copied"), "ok"); }}><Copy size={13} />{t("keys.copyPublic")}</button>
              <button className="btn sm" disabled={hosts.length === 0} onClick={() => setDlg({ install: k.id })}><Download size={13} />{t("keys.install")}</button>
              <button className="icon-btn danger" onClick={async () => { if (await confirmDialog(t("keys.deleteConfirm"))) run(api.keyDelete(k.id)); }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
      {dlg === "gen" && <GenerateDialog onClose={() => setDlg(null)} />}
      {dlg === "import" && <ImportDialog onClose={() => setDlg(null)} />}
      {dlg && typeof dlg === "object" && <InstallDialog keyId={dlg.install} onClose={() => setDlg(null)} />}
    </div></div>
  );
}

function GenerateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const run = useStore((s) => s.run);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("ed25519");
  const [comment, setComment] = useState("termx");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await run(api.keyGenerate(name.trim() || `key-${new Date().toISOString().slice(0, 10)}`, kind, comment), t("keys.generated"));
    setBusy(false); onClose();
  };
  return (
    <Modal onClose={onClose}>
      <h3>{t("keys.generate")}</h3>
      <div className="stack" style={{ marginTop: 12 }}>
        <Field label={t("common.name")}><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-laptop" /></Field>
        <Field label={t("keys.type")}>
          <Seg value={kind} onChange={setKind} options={[{ v: "ed25519", label: "Ed25519" }, { v: "rsa4096", label: "RSA 4096" }, { v: "rsa2048", label: "RSA 2048" }]} />
        </Field>
        <Field label={t("keys.comment")}><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={busy} onClick={go}>{busy ? <div className="spinner" style={{ width: 14, height: 14 }} /> : null}{t("keys.generate")}</button>
      </div>
    </Modal>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const run = useStore((s) => s.run);
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [pass, setPass] = useState("");
  const pick = async () => {
    const f = await openDialog({ multiple: false });
    if (typeof f !== "string") return;
    try {
      setText(await api.fileReadText(f));
      if (!name) setName(f.split(/[\\/]/).pop() ?? "");
    } catch (e) { toast(errText(e), "error"); }
  };
  const go = async () => {
    const r = await run(api.keyImport(name.trim() || "imported", text, pass || undefined), t("keys.imported"));
    if (r) onClose();
  };
  return (
    <Modal wide onClose={onClose}>
      <h3>{t("keys.import")}</h3>
      <div className="stack" style={{ marginTop: 12 }}>
        <Field label={t("common.name")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="id_ed25519" /></Field>
        <Field label={t("keys.pastePrivate")}>
          <textarea className="textarea mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
        </Field>
        <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={pick}>{t("keys.fromFile")}</button>
        <Field label={`${t("keys.passphrase")} (${t("common.optional")})`}><PasswordInput value={pass} onChange={setPass} /></Field>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={!text.trim()} onClick={go}>{t("keys.import")}</button>
      </div>
    </Modal>
  );
}

function InstallDialog({ keyId, onClose }: { keyId: string; onClose: () => void }) {
  const t = useT();
  const { vault, run } = useStore();
  const hosts = vault?.hosts ?? [];
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const ok = await run(api.keyInstall(keyId, hostId).then(() => true), t("keys.installOk"));
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <h3>{t("keys.install")}</h3>
      <div style={{ marginTop: 12 }}>
        <Field label={t("keys.chooseHost")}>
          <select className="select" value={hostId} onChange={(e) => setHostId(e.target.value)}>
            {hosts.map((h) => <option key={h.id} value={h.id}>{h.label} — {h.username}@{h.hostname}</option>)}
          </select>
        </Field>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={busy || !hostId} onClick={go}>{t("keys.install")}</button>
      </div>
    </Modal>
  );
}
