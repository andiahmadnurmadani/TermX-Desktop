import { useMemo, useState } from "react";
import { ChevronRight, Plug, Trash2 } from "lucide-react";
import { api, errText, type Env, type Host } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { confirmDialog } from "../lib/dialogs";
import { Drawer, Field, PasswordInput, Seg, Switch } from "./ui";

const blank = (): Partial<Host> => ({
  id: crypto.randomUUID(), label: "", hostname: "", port: 22, username: "", auth: "password", keyId: null, groupId: null, tags: [], environment: "",
  color: Math.floor(Math.random() * 8), tmux: false, tmuxName: "termx", jumpHostId: null, startupCommand: "", keepaliveSec: 20, autoReconnect: true, notes: "",
});

export function HostDrawer() {
  const t = useT();
  const { vault, hostDialog, closeHostDialog, load, toast, run, openTerm } = useStore();
  const existing = useMemo(() => vault?.hosts.find((h) => h.id === hostDialog?.hostId), [vault, hostDialog]);
  const [h, setH] = useState<Partial<Host>>(() => (existing ? { ...existing } : blank()));
  const [password, setPassword] = useState("");
  const [tags, setTags] = useState((existing?.tags ?? []).join(", "));
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));
  const keys = vault?.keys ?? [];
  const groups = vault?.groups ?? [];
  const others = (vault?.hosts ?? []).filter((x) => x.id !== h.id);

  /** Save, then (connect=true) open a terminal right away. */
  const save = async (connect = false) => {
    if (!h.hostname?.trim() || !h.username?.trim()) return toast(t("host.required"), "error");
    setBusy(true);
    try {
      const tagList = tags.split(",").map((x) => x.trim()).filter(Boolean);
      const payload: Partial<Host> = { ...h, hostname: h.hostname.trim(), username: h.username.trim(), tags: tagList, port: Number(h.port) || 22 };
      delete payload.hasPassword;
      await api.hostSave(payload, h.auth === "password" && password ? password : null);
      await load();
      closeHostDialog();
      if (connect && h.id) openTerm(h.id);
    } catch (e) { toast(errText(e), "error"); }
    setBusy(false);
  };
  const remove = async () => {
    if (!existing) return;
    if (await confirmDialog(t("hosts.deleteConfirm"))) { await run(api.hostDelete(existing.id)); closeHostDialog(); }
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); save(!existing); };

  return (
    <Drawer title={existing ? t("host.titleEdit") : t("host.titleNew")} onClose={closeHostDialog}
      footer={<>
        {existing && <button className="btn danger" style={{ marginRight: "auto" }} onClick={remove}><Trash2 size={14} />{t("common.delete")}</button>}
        <button className="btn" onClick={closeHostDialog}>{t("common.cancel")}</button>
        {existing ? (
          <>
            <button className="btn" disabled={busy} onClick={() => save(true)}><Plug size={14} />{t("host.saveConnect")}</button>
            <button className="btn primary" disabled={busy} onClick={() => save()}>{t("common.save")}</button>
          </>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={() => save()}>{t("common.save")}</button>
            <button className="btn primary" disabled={busy} onClick={() => save(true)}><Plug size={14} />{t("host.connect")}</button>
          </>
        )}
      </>}>
      <form onSubmit={submit} className="stack">
        <Field label={t("host.hostname")}><input className="input" autoFocus={!existing} value={h.hostname ?? ""} placeholder="192.168.1.10" spellCheck={false} onChange={(e) => set("hostname", e.target.value)} /></Field>
        <div className="row">
          <Field label={t("host.username")}><input className="input" value={h.username ?? ""} placeholder="root" spellCheck={false} autoCapitalize="off" onChange={(e) => set("username", e.target.value)} /></Field>
          <div style={{ flex: "0 0 92px" }}><Field label={t("host.port")}><input className="input" type="number" value={h.port ?? 22} onChange={(e) => set("port", Number(e.target.value))} /></Field></div>
        </div>
        <Field label={`${t("host.label")} (${t("common.optional")})`}><input className="input" value={h.label ?? ""} placeholder={h.hostname || "My server"} onChange={(e) => set("label", e.target.value)} /></Field>

        <div className="sect-label">{t("host.auth")}</div>
        <Seg value={h.auth ?? "password"} onChange={(v) => set("auth", v)} options={[{ v: "password", label: t("host.authPassword") }, { v: "key", label: t("host.authKey") }, { v: "agent", label: t("host.authAgent") }]} />
        {h.auth === "agent" ? (
          <p className="hint-block">{t("host.agentHint")}</p>
        ) : h.auth === "key" ? (
          <Field label={t("host.key")} hint={keys.length === 0 ? t("host.noKeys") : undefined}>
            <select className="select" value={h.keyId ?? ""} onChange={(e) => set("keyId", e.target.value || null)}>
              <option value="">—</option>
              {keys.map((k) => <option key={k.id} value={k.id}>{k.name} · {k.kind}</option>)}
            </select>
          </Field>
        ) : (
          <Field label={t("host.password")} hint={existing?.hasPassword ? `${t("host.passwordSaved")}. ${t("host.passwordKeep")}` : t("host.passwordAsk")}>
            <PasswordInput value={password} onChange={setPassword} placeholder={existing?.hasPassword ? "••••••••" : ""} />
          </Field>
        )}

        <div className="sect-label">{t("host.environment")}</div>
        <Seg value={(h.environment ?? "") as Env} onChange={(v) => set("environment", v)} options={[
          { v: "", label: t("common.none") }, { v: "development", label: t("env.development") },
          { v: "staging", label: t("env.staging") }, { v: "production", label: t("env.production") },
        ]} />
        {h.environment === "production" && <p className="hint-block">{t("host.prodHint")}</p>}

        <div className="sect-label">{t("host.group")}</div>
        <div className="row">
          <Field label={t("host.group")}>
            <select className="select" value={h.groupId ?? ""} onChange={(e) => set("groupId", e.target.value || null)}>
              <option value="">{t("common.none")}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field label={t("host.tags")} hint={t("host.tagsHint")}><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, web" /></Field>
        </div>
        <Field label={t("host.color")}>
          <div className="swatches">{[0, 1, 2, 3, 4, 5, 6, 7].map((c) => (
            <button type="button" key={c} className={"swatch" + (h.color === c ? " on" : "")} style={{ background: `var(--c${c})` }} onClick={() => set("color", c)} />
          ))}</div>
        </Field>

        <button type="button" className={"disclosure" + (adv ? " open" : "")} onClick={() => setAdv(!adv)}><ChevronRight size={15} />{t("host.advanced")}</button>
        {adv && (
          <div className="stack">
            <Field label={t("host.jump")} hint={t("host.jumpHint")}>
              <select className="select" value={h.jumpHostId ?? ""} onChange={(e) => set("jumpHostId", e.target.value || null)}>
                <option value="">{t("common.none")}</option>
                {others.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <div className="toggle-row"><div className="meta"><span>{t("host.tmux")}</span><small>{t("host.tmuxHint")}</small></div><Switch on={!!h.tmux} onChange={(b) => set("tmux", b)} /></div>
            {h.tmux && <Field label={t("host.tmuxName")}><input className="input mono" value={h.tmuxName ?? ""} onChange={(e) => set("tmuxName", e.target.value)} /></Field>}
            <Field label={t("host.startup")} hint={t("host.startupHint")}><input className="input mono" value={h.startupCommand ?? ""} onChange={(e) => set("startupCommand", e.target.value)} placeholder="cd /var/www && ls" /></Field>
            <div className="row">
              <Field label={t("host.keepalive")}><input className="input" type="number" min={0} value={h.keepaliveSec ?? 20} onChange={(e) => set("keepaliveSec", Number(e.target.value))} /></Field>
              <div className="toggle-row" style={{ alignSelf: "end", height: 34 }}><span>{t("host.autoReconnect")}</span><Switch on={!!h.autoReconnect} onChange={(b) => set("autoReconnect", b)} /></div>
            </div>
            <Field label={t("host.notes")}><textarea className="textarea" value={h.notes ?? ""} onChange={(e) => set("notes", e.target.value)} /></Field>
          </div>
        )}
        <button type="submit" style={{ display: "none" }} />
      </form>
    </Drawer>
  );
}
