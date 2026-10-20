import { useState } from "react";
import { LayoutGrid, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, type Layout, type Workspace } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { confirmDialog } from "../lib/dialogs";
import { EmptyState, Field, Modal, Seg } from "./ui";
import { EnvBadge } from "./HostsView";

const blank = (): Workspace => ({ id: crypto.randomUUID(), name: "", layout: "4", colSplit: 0.5, rowSplit: 0.5, panes: [null, null, null, null], createdAt: Date.now() });

/** Miniature of the layout with the host in each slot. */
function Mini({ ws }: { ws: Workspace }) {
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const slots = ws.layout === "1" ? 1 : ws.layout === "4" ? 4 : 2;
  return (
    <div className={"ws-mini l" + ws.layout}>
      {ws.panes.slice(0, slots).map((id, i) => {
        const h = hosts.find((x) => x.id === id);
        return <div key={i} className={"ws-slot" + (h ? "" : " empty")}>{h ? h.label : "—"}</div>;
      })}
    </div>
  );
}

export function WorkspacesView() {
  const t = useT();
  const { vault, run, openGrid } = useStore();
  const [edit, setEdit] = useState<Workspace | null>(null);
  const list = vault?.workspaces ?? [];
  const hosts = vault?.hosts ?? [];

  const save = async () => {
    if (!edit || !edit.name.trim()) return;
    await run(api.workspaceSave({ ...edit, name: edit.name.trim() }));
    setEdit(null);
  };
  const slots = edit ? (edit.layout === "1" ? 1 : edit.layout === "4" ? 4 : 2) : 0;

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <h1>{t("ws.title")}</h1>
        <div className="sp" />
        <button className="btn" onClick={() => openGrid()}><LayoutGrid size={15} />{t("ws.newEmpty")}</button>
        <button className="btn primary" onClick={() => setEdit(blank())}><Plus size={15} />{t("ws.new")}</button>
      </div>
      <p className="lede">{t("ws.lede")}</p>
      {list.length === 0 ? (
        <EmptyState icon={<LayoutGrid size={26} />} title={t("ws.empty.title")} body={t("ws.empty.body")}
          action={<button className="btn primary" onClick={() => openGrid()}><LayoutGrid size={15} />{t("ws.newEmpty")}</button>} />
      ) : (
        <div className="ws-grid">
          {list.map((w) => (
            <div key={w.id} className="ws-card">
              <Mini ws={w} />
              <div className="ws-meta">
                <div className="ttl">{w.name}</div>
                <div className="sub">{w.panes.filter(Boolean).length} / {w.layout === "1" ? 1 : w.layout === "4" ? 4 : 2} {t("ws.panes")}</div>
              </div>
              <div className="ws-acts">
                <button className="icon-btn" title={t("common.edit")} onClick={() => setEdit({ ...w, panes: [...w.panes] })}><Pencil size={15} /></button>
                <button className="icon-btn danger" title={t("common.delete")} onClick={async () => { if (await confirmDialog(t("ws.deleteConfirm"))) run(api.workspaceDelete(w.id)); }}><Trash2 size={15} /></button>
                <button className="btn primary sm" onClick={() => openGrid(w)}><Play size={13} />{t("ws.open")}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {edit && (
        <Modal wide onClose={() => setEdit(null)}>
          <h3>{t("ws.title")}</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            <Field label={t("common.name")}><input className="input" autoFocus value={edit.name} placeholder="Production" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={t("ws.layout")}>
              <Seg<Layout> value={edit.layout} onChange={(v) => setEdit({ ...edit, layout: v })} options={[
                { v: "4", label: t("ws.layout4") }, { v: "2v", label: t("ws.layout2v") }, { v: "2h", label: t("ws.layout2h") }, { v: "1", label: t("ws.layout1") },
              ]} />
            </Field>
            <div className={"ws-edit-grid l" + edit.layout}>
              {Array.from({ length: slots }).map((_, i) => {
                const cur = hosts.find((h) => h.id === edit.panes[i]);
                return (
                  <Field key={i} label={`${t("ws.pane")} ${i + 1}`}>
                    <div className="row" style={{ alignItems: "center" }}>
                      <select className="select" value={edit.panes[i] ?? ""} onChange={(e) => { const p = [...edit.panes]; p[i] = e.target.value || null; setEdit({ ...edit, panes: p }); }}>
                        <option value="">{t("ws.emptyPane")}</option>
                        {hosts.map((h) => <option key={h.id} value={h.id}>{h.label} — {h.username}@{h.hostname}</option>)}
                      </select>
                      {cur?.environment && <div style={{ flex: "0 0 auto" }}><EnvBadge env={cur.environment} /></div>}
                    </div>
                  </Field>
                );
              })}
            </div>
            <p className="hint-block">{t("ws.restoreNote")}</p>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setEdit(null)}>{t("common.cancel")}</button>
            <button className="btn primary" disabled={!edit.name.trim()} onClick={save}>{t("common.save")}</button>
          </div>
        </Modal>
      )}
    </div></div>
  );
}
