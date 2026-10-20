import { useMemo, useState } from "react";
import { Copy, FolderOpen, FolderPlus, LayoutGrid, Pencil, Plus, Search, Server, Terminal, Trash2, X } from "lucide-react";
import { api, type Env, type Host } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { ago } from "../lib/util";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { ContextMenu, EmptyState, type MenuItem } from "./ui";

export const hostColor = (c: number) => `var(--c${c % 8})`;

const ENV_SHORT: Record<string, string> = { development: "dev", staging: "staging", production: "prod" };
export function EnvBadge({ env }: { env: Env | string }) {
  if (!env) return null;
  return <span className={"env env-" + env}>{ENV_SHORT[env] ?? env}</span>;
}

export function HostCard({ host, i }: { host: Host; i: number }) {
  const t = useT();
  const { openTerm, openSftp, openHostDialog, openHostInGrid, run } = useStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const duplicate = () => run(api.hostSave({ ...host, id: crypto.randomUUID(), label: host.label + " copy", lastConnectedAt: 0, createdAt: Date.now() }, null), undefined);
  const remove = async () => { if (await confirmDialog(t("hosts.deleteConfirm"))) run(api.hostDelete(host.id)); };
  const items: MenuItem[] = [
    { label: t("hosts.connect"), icon: <Terminal size={14} />, onClick: () => openTerm(host.id) },
    { label: t("hosts.sftp"), icon: <FolderOpen size={14} />, onClick: () => openSftp(host.id) },
    { label: t("hosts.openInWorkspace"), icon: <LayoutGrid size={14} />, onClick: () => openHostInGrid(host.id) },
    { sep: true, label: "", onClick: () => {} },
    { label: t("common.edit"), icon: <Pencil size={14} />, onClick: () => openHostDialog(host.id) },
    { label: t("hosts.duplicate"), icon: <Copy size={14} />, onClick: duplicate },
    { label: t("common.delete"), icon: <Trash2 size={14} />, danger: true, onClick: remove },
  ];

  return (
    <>
      <div
        className="card" role="button" tabIndex={0} title={ago(host.lastConnectedAt, t("hosts.never"))} style={{ ["--hc" as string]: hostColor(host.color), animationDelay: `${Math.min(i, 12) * 18}ms` }}
        onClick={() => openTerm(host.id)}
        onKeyDown={(e) => e.key === "Enter" && openTerm(host.id)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <div className="avatar"><Server size={18} /></div>
        <div className="meta">
          <div className="name">{host.label}<EnvBadge env={host.environment} /></div>
          <div className="sub">{host.username}@{host.hostname}{host.port !== 22 ? `:${host.port}` : ""}</div>
          {(host.tags.length > 0 || host.osName) && (
            <div className="tags">
              {host.osName && <span className="tag">{host.osName}</span>}
              {host.tags.slice(0, 3).map((x) => <span key={x} className="tag">{x}</span>)}
            </div>
          )}
        </div>
        <div className="acts" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title={t("hosts.openInWorkspace")} onClick={() => openHostInGrid(host.id)}><LayoutGrid size={15} /></button>
          <button className="icon-btn" title={t("hosts.sftp")} onClick={() => openSftp(host.id)}><FolderOpen size={15} /></button>
          <button className="icon-btn" title={t("common.edit")} onClick={() => openHostDialog(host.id)}><Pencil size={15} /></button>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

export function HostsView() {
  const t = useT();
  const { vault, openHostDialog, run } = useStore();
  const [q, setQ] = useState("");
  const [groupId, setGroupId] = useState<string | "all">("all");
  const hosts = vault?.hosts ?? [];
  const groups = vault?.groups ?? [];

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return hosts.filter((h) => {
      if (groupId !== "all" && (h.groupId ?? "") !== (groupId === "none" ? "" : groupId)) return false;
      if (!s) return true;
      return [h.label, h.hostname, h.username, h.osName ?? "", h.environment, ...h.tags].some((x) => x.toLowerCase().includes(s));
    });
  }, [hosts, q, groupId]);

  const recent = useMemo(() => (q || groupId !== "all" || hosts.length < 7 ? [] : [...hosts].filter((h) => h.lastConnectedAt).sort((a, b) => b.lastConnectedAt - a.lastConnectedAt).slice(0, 3)), [hosts, q, groupId]);

  const sections = useMemo(() => {
    const byGroup = new Map<string, Host[]>();
    for (const h of filtered) {
      const k = h.groupId && groups.some((g) => g.id === h.groupId) ? h.groupId : "";
      byGroup.set(k, [...(byGroup.get(k) ?? []), h]);
    }
    const out: { id: string; name: string; hosts: Host[] }[] = [];
    for (const g of groups) if (byGroup.has(g.id)) out.push({ id: g.id, name: g.name, hosts: byGroup.get(g.id)! });
    if (byGroup.has("")) out.push({ id: "", name: groups.length ? t("hosts.ungrouped") : "", hosts: byGroup.get("")! });
    return out;
  }, [filtered, groups, t]);

  const newGroup = async () => {
    const name = await promptDialog(t("hosts.newGroup"), "", t("hosts.groupName"));
    if (name) run(api.groupSave({ id: crypto.randomUUID(), name, color: 1 }));
  };
  const delGroup = async (id: string) => {
    if (await confirmDialog(t("hosts.deleteGroupConfirm"))) { setGroupId("all"); run(api.groupDelete(id)); }
  };

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <h1>{t("hosts.title")}</h1>
        <div className="search">
          <Search size={15} />
          <input className="input" placeholder={t("hosts.search")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </div>
        <div className="sp" />
        <button className="btn" onClick={newGroup}><FolderPlus size={15} />{t("hosts.newGroup")}</button>
        <button className="btn primary" onClick={() => openHostDialog(null)}><Plus size={15} />{t("hosts.new")}</button>
      </div>

      {groups.length > 0 && (
        <div className="chips" style={{ marginBottom: 6 }}>
          <button className={"chip" + (groupId === "all" ? " on" : "")} onClick={() => setGroupId("all")}>{t("hosts.all")}</button>
          {groups.map((g) => (
            <button key={g.id} className={"chip" + (groupId === g.id ? " on" : "")} onClick={() => setGroupId(g.id)}>
              {g.name}
              {groupId === g.id && <span title={t("hosts.deleteGroup")} onClick={(e) => { e.stopPropagation(); delGroup(g.id); }}><X size={12} /></span>}
            </button>
          ))}
          <button className={"chip" + (groupId === "none" ? " on" : "")} onClick={() => setGroupId("none")}>{t("hosts.ungrouped")}</button>
        </div>
      )}

      {hosts.length === 0 ? (
        <EmptyState icon={<Server size={26} />} title={t("hosts.empty.title")} body={t("hosts.empty.body")}
          action={<button className="btn primary" onClick={() => openHostDialog(null)}><Plus size={15} />{t("hosts.new")}</button>} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Search size={24} />} title={t("hosts.noresults")} body="" />
      ) : (
        <>
          {recent.length > 0 && (
            <>
              <div className="group-title">{t("hosts.recent")}<span className="line" /></div>
              <div className="grid">{recent.map((h, i) => <HostCard key={"r" + h.id} host={h} i={i} />)}</div>
            </>
          )}
          {sections.map((s) => (
            <div key={s.id || "none"}>
              {(s.name || recent.length > 0) && <div className="group-title">{s.name || t("hosts.all")}<span className="line" /></div>}
              <div className="grid">{s.hosts.map((h, i) => <HostCard key={h.id} host={h} i={i} />)}</div>
            </div>
          ))}
        </>
      )}
    </div></div>
  );
}
