import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUp, Download, Eye, File as FileIcon, FilePlus2, Folder, FolderPlus, FolderUp, Link2, Pencil, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { api, errText, events, uid, type FileEntry } from "../lib/api";
import { useStore, type Tab } from "../lib/store";
import { useT } from "../lib/i18n";
import { baseName, fmtDate, fmtSize, joinPath, parentPath } from "../lib/util";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { ContextMenu, Modal, type MenuItem } from "./ui";

interface Transfer { id: string; name: string; dir: "up" | "down"; done: number; total: number; status: "run" | "ok" | "err" | "cancel"; error?: string }

const modeStr = (m: number, dir: boolean) => {
  const f = "rwxrwxrwx";
  let s = dir ? "d" : "-";
  for (let i = 0; i < 9; i++) s += m & (1 << (8 - i)) ? f[i] : "-";
  return s;
};

export function SftpView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const t = useT();
  const hostId = tab.hostId;
  const toast = useStore((s) => s.toast);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState(false);
  const [drag, setDrag] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [editor, setEditor] = useState<{ path: string; text: string; orig: string } | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const pathRef = useRef(path);
  pathRef.current = path;
  const lastClick = useRef<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true); setError("");
    try {
      const list = await api.sftpList(hostId, p);
      setEntries(list); setPath(p); setSel(new Set());
    } catch (e) { setError(errText(e)); }
    setLoading(false);
  }, [hostId]);

  useEffect(() => {
    (async () => {
      try { await load(await api.sftpHome(hostId)); }
      catch (e) { setError(errText(e)); setLoading(false); }
    })();
    return () => { /* sessions are cached by the backend and closed with the host */ };
  }, [hostId, load]);

  // progress events
  useEffect(() => {
    let un: (() => void) | undefined;
    events.on<{ id: string; done: number; total: number; name: string }>("sftp:progress", (p) => {
      setTransfers((ts) => ts.map((x) => (x.id === p.id ? { ...x, done: p.done, total: p.total, name: p.name || x.name } : x)));
    }).then((u) => { un = u; });
    return () => un?.();
  }, []);

  const track = async (name: string, dir: "up" | "down", job: (id: string) => Promise<void>) => {
    const id = uid();
    setTransfers((ts) => [...ts, { id, name, dir, done: 0, total: 0, status: "run" }]);
    try {
      await job(id);
      setTransfers((ts) => ts.map((x) => (x.id === id ? { ...x, status: "ok", done: x.total } : x)));
      setTimeout(() => setTransfers((ts) => ts.filter((x) => x.id !== id || x.status === "err")), 4000);
    } catch (e) {
      const msg = errText(e);
      const cancelled = /cancel/i.test(msg);
      setTransfers((ts) => ts.map((x) => (x.id === id ? { ...x, status: cancelled ? "cancel" : "err", error: msg } : x)));
      if (cancelled) setTimeout(() => setTransfers((ts) => ts.filter((x) => x.id !== id)), 2500);
    }
  };

  const upload = useCallback(async (locals: string[]) => {
    const dest = pathRef.current;
    await Promise.all(locals.map((l) => track(baseName(l), "up", (id) => api.sftpUpload(hostId, l, joinPath(dest, baseName(l)), id))));
    if (pathRef.current === dest) load(dest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, load]);

  // OS drag & drop (only for the visible tab)
  useEffect(() => {
    if (!visible) return;
    let un: (() => void) | undefined; let dead = false;
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDrag(true);
      else if (p.type === "leave") setDrag(false);
      else if (p.type === "drop") { setDrag(false); if (p.paths.length) upload(p.paths); }
    }).then((u) => { if (dead) u(); else un = u; });
    return () => { dead = true; un?.(); setDrag(false); };
  }, [visible, upload]);

  const shown = useMemo(() => (hidden ? entries : entries.filter((e) => !e.name.startsWith("."))), [entries, hidden]);
  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    return [{ name: "/", p: "/" }, ...parts.map((n, i) => ({ name: n, p: "/" + parts.slice(0, i + 1).join("/") }))];
  }, [path]);

  const selected = shown.filter((e) => sel.has(e.path));
  const openEntry = async (e: FileEntry) => {
    if (e.isDir) return load(e.path);
    if (e.size > 2 * 1024 * 1024) return toast(t("sftp.tooBig"), "error");
    try { const text = await api.sftpReadText(hostId, e.path); setEditor({ path: e.path, text, orig: text }); }
    catch (er) { toast(errText(er), "error"); }
  };
  const download = async (items: FileEntry[]) => {
    const dir = await openDialog({ directory: true, title: t("sftp.chooseFolder") });
    if (!dir || typeof dir !== "string") return;
    const sep = dir.includes("\\") ? "\\" : "/";
    await Promise.all(items.map((it) => track(it.name, "down", (id) => api.sftpDownload(hostId, it.path, it.isDir, dir.replace(/[\\/]$/, "") + sep + it.name, id))));
  };
  const pickUpload = async (directory: boolean) => {
    const r = await openDialog({ multiple: !directory, directory });
    if (!r) return;
    upload(Array.isArray(r) ? r : [r]);
  };
  const remove = async (items: FileEntry[]) => {
    if (!(await confirmDialog(t("sftp.deleteConfirm", { n: items.length })))) return;
    try { for (const it of items) await api.sftpRemove(hostId, it.path, it.isDir); } catch (e) { toast(errText(e), "error"); }
    load(path);
  };
  const rename = async (it: FileEntry) => {
    const n = await promptDialog(t("common.rename"), it.name, t("sftp.newName"));
    if (!n || n === it.name) return;
    try { await api.sftpRename(hostId, it.path, joinPath(path, n)); } catch (e) { toast(errText(e), "error"); }
    load(path);
  };
  const mkdir = async () => {
    const n = await promptDialog(t("sftp.newFolder"), "", t("sftp.folderName"));
    if (!n) return;
    try { await api.sftpMkdir(hostId, joinPath(path, n)); } catch (e) { toast(errText(e), "error"); }
    load(path);
  };
  const newFile = async () => {
    const n = await promptDialog(t("sftp.newFile"), "", t("sftp.newName"));
    if (!n) return;
    try { await api.sftpWriteText(hostId, joinPath(path, n), ""); } catch (e) { toast(errText(e), "error"); }
    load(path);
  };
  const saveEditor = async () => {
    if (!editor) return;
    try { await api.sftpWriteText(hostId, editor.path, editor.text); toast(t("sftp.saved"), "ok"); setEditor(null); load(path); }
    catch (e) { toast(errText(e), "error"); }
  };

  const click = (e: React.MouseEvent, it: FileEntry) => {
    const next = new Set(e.metaKey || e.ctrlKey ? sel : []);
    if (e.shiftKey && lastClick.current) {
      const a = shown.findIndex((x) => x.path === lastClick.current), b = shown.findIndex((x) => x.path === it.path);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(shown[i].path);
    } else if ((e.metaKey || e.ctrlKey) && sel.has(it.path)) next.delete(it.path);
    else next.add(it.path);
    lastClick.current = it.path;
    setSel(next);
  };

  const ctx = (e: React.MouseEvent, it: FileEntry) => {
    e.preventDefault();
    const items = sel.has(it.path) ? selected : [it];
    if (!sel.has(it.path)) setSel(new Set([it.path]));
    const single = items.length === 1;
    setMenu({ x: e.clientX, y: e.clientY, items: [
      ...(single ? [{ label: it.isDir ? t("sftp.open") : t("sftp.edit"), icon: it.isDir ? <Folder size={14} /> : <Pencil size={14} />, onClick: () => openEntry(it) }] : []),
      { label: t("sftp.download"), icon: <Download size={14} />, onClick: () => download(items) },
      ...(single ? [{ label: t("common.rename"), icon: <Pencil size={14} />, onClick: () => rename(it) }] : []),
      { sep: true, label: "", onClick: () => {} },
      { label: t("common.delete"), icon: <Trash2 size={14} />, danger: true, onClick: () => remove(items) },
    ] });
  };

  return (
    <div className={"sftp" + (visible ? "" : " hidden")} style={visible ? undefined : { visibility: "hidden", pointerEvents: "none" }}>
      <div className="sftp-bar">
        <button className="icon-btn" title={t("sftp.up")} disabled={path === "/" || !path} onClick={() => load(parentPath(path))}><ArrowUp size={16} /></button>
        <button className="icon-btn" title={t("common.refresh")} onClick={() => load(path)}><RefreshCw size={15} /></button>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.p} style={{ display: "flex", alignItems: "center" }}>
              {i > 1 && <span className="sep">/</span>}
              <button onClick={() => load(c.p)}>{c.name}</button>
            </span>
          ))}
        </div>
        <button className="icon-btn" title={t("sftp.hidden")} style={hidden ? { color: "var(--accent)" } : undefined} onClick={() => setHidden(!hidden)}><Eye size={16} /></button>
        <button className="icon-btn" title={t("sftp.newFile")} onClick={newFile}><FilePlus2 size={16} /></button>
        <button className="icon-btn" title={t("sftp.newFolder")} onClick={mkdir}><FolderPlus size={16} /></button>
        <button className="icon-btn" title={t("sftp.uploadFolder")} onClick={() => pickUpload(true)}><FolderUp size={16} /></button>
        <button className="btn sm" onClick={() => pickUpload(false)}><Upload size={14} />{t("sftp.upload")}</button>
        <button className="btn sm" disabled={selected.length === 0} onClick={() => download(selected)}><Download size={14} />{t("sftp.download")}</button>
        {selected.length > 0 && <button className="btn sm danger" onClick={() => remove(selected)}><Trash2 size={14} /></button>}
      </div>

      <div className="files" onMouseDown={(e) => { if (e.target === e.currentTarget) setSel(new Set()); }}>
        <div className="fhead"><span>{t("sftp.name")}</span><span>{t("sftp.size")}</span><span>{t("sftp.modified")}</span><span>Mode</span></div>
        {loading && entries.length === 0 && <div className="empty"><div className="spinner" /></div>}
        {error && <div className="empty" style={{ color: "var(--danger)" }}>{error}</div>}
        {!loading && !error && shown.length === 0 && <div className="empty">{t("sftp.empty")}</div>}
        {shown.map((it) => (
          <div key={it.path} className={"frow" + (sel.has(it.path) ? " sel" : "")} onClick={(e) => click(e, it)} onDoubleClick={() => openEntry(it)} onContextMenu={(e) => ctx(e, it)}>
            <div className="nm">
              {it.isDir ? <Folder size={16} color="var(--accent)" /> : it.isLink ? <Link2 size={16} color="var(--text-3)" /> : <FileIcon size={16} color="var(--text-3)" />}
              <span>{it.name}</span>
            </div>
            <span className="dim">{it.isDir ? "" : fmtSize(it.size)}</span>
            <span className="dim">{fmtDate(it.mtime)}</span>
            <span className="perm">{modeStr(it.mode, it.isDir)}</span>
          </div>
        ))}
        {drag && <div className="dropzone"><Upload size={20} style={{ marginRight: 10 }} />{t("sftp.drop")}</div>}
      </div>

      {transfers.length > 0 && (
        <div className="transfers">
          {transfers.map((x) => (
            <div key={x.id} className="transfer">
              {x.dir === "up" ? <Upload size={14} /> : <Download size={14} />}
              <span className="nm">{x.name}</span>
              {x.status === "run" ? <div className="bar"><i style={{ width: x.total ? `${Math.min(100, (x.done / x.total) * 100)}%` : "8%" }} /></div>
                : <span className="dim" style={{ flex: 1, color: x.status === "err" ? "var(--danger)" : "var(--text-2)", userSelect: "text" }}>{x.status === "ok" ? t("sftp.done") : x.status === "cancel" ? t("sftp.cancelled") : x.error}</span>}
              <span className="dim" style={{ width: 120, textAlign: "right" }}>{x.status === "run" ? `${fmtSize(x.done)} / ${fmtSize(x.total)}` : ""}</span>
              {x.status === "run"
                ? <button className="icon-btn" onClick={() => api.sftpCancel(x.id)}><X size={14} /></button>
                : <button className="icon-btn" onClick={() => setTransfers((ts) => ts.filter((y) => y.id !== x.id))}><X size={14} /></button>}
            </div>
          ))}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {editor && (
        <Modal className="editor-modal" onClose={() => { if (editor.text === editor.orig) setEditor(null); }}>
          <h3 className="mono" style={{ fontSize: 13 }}>{editor.path}</h3>
          <textarea className="textarea" spellCheck={false} value={editor.text} autoFocus
            onChange={(e) => setEditor({ ...editor, text: e.target.value })}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveEditor(); } }} />
          <div className="actions">
            <button className="btn" onClick={() => setEditor(null)}>{t("common.cancel")}</button>
            <button className="btn primary" onClick={saveEditor}>{t("common.save")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
