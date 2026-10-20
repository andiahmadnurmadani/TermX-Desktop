import { useState } from "react";
import { Pencil, Plus, Trash2, Zap } from "lucide-react";
import { api, type Snippet } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { confirmDialog } from "../lib/dialogs";
import { EmptyState, Field, Modal, Switch } from "./ui";

export function SnippetsView() {
  const t = useT();
  const { vault, run } = useStore();
  const [edit, setEdit] = useState<Snippet | null>(null);
  const list = vault?.snippets ?? [];
  const blank = (): Snippet => ({ id: crypto.randomUUID(), name: "", command: "", description: "", autoRun: true });

  const save = async () => {
    if (!edit || !edit.name.trim() || !edit.command.trim()) return;
    await run(api.snippetSave({ ...edit, name: edit.name.trim() }));
    setEdit(null);
  };

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <h1>{t("snip.title")}</h1>
        <div className="sp" />
        <button className="btn primary" onClick={() => setEdit(blank())}><Plus size={15} />{t("snip.new")}</button>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<Zap size={26} />} title={t("snip.empty.title")} body={t("snip.empty.body")}
          action={<button className="btn primary" onClick={() => setEdit(blank())}><Plus size={15} />{t("snip.new")}</button>} />
      ) : (
        <>
          <div className="panel list">
            {list.map((s) => (
              <div className="li" key={s.id}>
                <div className="grow">
                  <div className="ttl">{s.name}</div>
                  <div className="sub mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.command}</div>
                  {s.description && <div className="sub">{s.description}</div>}
                </div>
                <button className="icon-btn" onClick={() => setEdit({ ...s })}><Pencil size={15} /></button>
                <button className="icon-btn danger" onClick={async () => { if (await confirmDialog(t("snip.deleteConfirm"))) run(api.snippetDelete(s.id)); }}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
          <p style={{ color: "var(--text-3)", marginTop: 14 }}>{t("snip.hint")}</p>
        </>
      )}
      {edit && (
        <Modal wide onClose={() => setEdit(null)}>
          <h3>{t("snip.title")}</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            <Field label={t("common.name")}><input className="input" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={t("snip.command")}><textarea className="textarea mono" rows={3} value={edit.command} spellCheck={false} onChange={(e) => setEdit({ ...edit, command: e.target.value })} /></Field>
            <Field label={`${t("snip.description")} (${t("common.optional")})`}><input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <div className="toggle-row"><span>{t("snip.autoRun")}</span><Switch on={edit.autoRun} onChange={(b) => setEdit({ ...edit, autoRun: b })} /></div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setEdit(null)}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={save}>{t("common.save")}</button>
          </div>
        </Modal>
      )}
    </div></div>
  );
}
