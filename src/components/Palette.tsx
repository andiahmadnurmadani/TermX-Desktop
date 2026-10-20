import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, KeyRound, Plus, Server, Settings, Terminal, Zap } from "lucide-react";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";

interface Item { id: string; group: string; label: string; sub?: string; icon: React.ReactNode; run: () => void }

export function Palette() {
  const t = useT();
  const { vault, tabs, setPalette, openTerm, openSftp, openHostDialog, setView, setActive } = useStore();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const s = q.trim().toLowerCase();
    const out: Item[] = [];
    for (const tab of tabs) out.push({ id: "t" + tab.id, group: t("palette.tabs"), label: tab.title, icon: tab.kind === "term" ? <Terminal size={15} /> : <FolderOpen size={15} />, run: () => setActive(tab.id) });
    for (const h of vault?.hosts ?? []) {
      out.push({ id: "h" + h.id, group: t("palette.hosts"), label: h.label, sub: `${h.username}@${h.hostname}`, icon: <Server size={15} />, run: () => openTerm(h.id) });
      out.push({ id: "f" + h.id, group: t("palette.hosts"), label: `${h.label} · SFTP`, sub: `${h.username}@${h.hostname}`, icon: <FolderOpen size={15} />, run: () => openSftp(h.id) });
    }
    out.push(
      { id: "a1", group: t("palette.actions"), label: t("palette.newHost"), icon: <Plus size={15} />, run: () => openHostDialog(null) },
      { id: "a2", group: t("palette.actions"), label: t("nav.keys"), icon: <KeyRound size={15} />, run: () => setView("keys") },
      { id: "a3", group: t("palette.actions"), label: t("nav.snippets"), icon: <Zap size={15} />, run: () => setView("snippets") },
      { id: "a4", group: t("palette.actions"), label: t("nav.settings"), icon: <Settings size={15} />, run: () => setView("settings") },
    );
    if (!s) return out.filter((i) => !i.id.startsWith("f"));
    return out.filter((i) => (i.label + " " + (i.sub ?? "")).toLowerCase().includes(s));
  }, [q, vault, tabs, t, openTerm, openSftp, openHostDialog, setView, setActive]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") useStore.getState().setPalette(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  useEffect(() => { listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); }, [idx]);

  const close = () => setPalette(false);
  const go = (i?: Item) => { if (!i) return; close(); setTimeout(i.run, 0); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(items[idx]); }
  };

  let last = "";
  return (
    <div className="scrim palette-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette">
        <input autoFocus value={q} placeholder={t("palette.placeholder")} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
        <div className="res" ref={listRef}>
          {items.length === 0 && <div className="none">{t("palette.empty")}</div>}
          {items.map((it, i) => {
            const head = it.group !== last ? <div className="grp">{it.group}</div> : null;
            last = it.group;
            return (
              <div key={it.id}>
                {head}
                <button className={"it" + (i === idx ? " sel" : "")} onMouseEnter={() => setIdx(i)} onClick={() => go(it)}>{it.icon}<span>{it.label}</span>{it.sub && <span className="sub">{it.sub}</span>}</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
