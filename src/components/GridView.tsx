import { useMemo, useRef, useState } from "react";
import { Columns2, Rows2, Save, Search, Server, Square, LayoutGrid } from "lucide-react";
import type { Layout } from "../lib/api";
import { useStore, type Tab } from "../lib/store";
import { useT } from "../lib/i18n";
import { promptDialog } from "../lib/dialogs";
import { TerminalView } from "./TerminalView";
import { EnvBadge, hostColor } from "./HostsView";

interface Rect { l: number; t: number; w: number; h: number }

/** Where each of the four slots sits for a layout (fractions of the grid area). */
function rects(layout: Layout, c: number, r: number): (Rect | null)[] {
  switch (layout) {
    case "1": return [{ l: 0, t: 0, w: 1, h: 1 }, null, null, null];
    case "2v": return [{ l: 0, t: 0, w: c, h: 1 }, { l: c, t: 0, w: 1 - c, h: 1 }, null, null];
    case "2h": return [{ l: 0, t: 0, w: 1, h: r }, { l: 0, t: r, w: 1, h: 1 - r }, null, null];
    default: return [
      { l: 0, t: 0, w: c, h: r }, { l: c, t: 0, w: 1 - c, h: r },
      { l: 0, t: r, w: c, h: 1 - r }, { l: c, t: r, w: 1 - c, h: 1 - r },
    ];
  }
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
const GAP = 3;

export function GridView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const t = useT();
  const g = tab.grid!;
  const { patchGrid, setPaneHost, saveGrid } = useStore();
  const areaRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<"col" | "row" | null>(null);

  const max = g.max !== null && g.panes[g.max] ? g.max : null;
  const layoutRects = rects(g.layout, g.colSplit, g.rowSplit);
  const hiddenLive = g.panes.filter((p, i) => p && !layoutRects[i]).length;

  const startDrag = (kind: "col" | "row") => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = areaRef.current!;
    const box = el.getBoundingClientRect();
    setDrag(kind);
    const move = (ev: PointerEvent) => {
      const f = kind === "col" ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      const v = Math.min(0.85, Math.max(0.15, f));
      patchGrid(tab.id, kind === "col" ? { colSplit: v } : { rowSplit: v });
    };
    const up = () => { setDrag(null); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const setLayout = (layout: Layout) => {
    const slots = layout === "1" ? 1 : layout === "4" ? 4 : 2;
    patchGrid(tab.id, { layout, max: null, focus: g.focus < slots ? g.focus : 0 });
  };
  const save = async () => {
    const name = await promptDialog(t("ws.saveAs"), g.name);
    if (name) saveGrid(tab.id, name);
  };

  const LAYOUTS: { v: Layout; icon: React.ReactNode; label: string }[] = [
    { v: "1", icon: <Square size={14} />, label: t("ws.layout1") },
    { v: "2v", icon: <Columns2 size={14} />, label: t("ws.layout2v") },
    { v: "2h", icon: <Rows2 size={14} />, label: t("ws.layout2h") },
    { v: "4", icon: <LayoutGrid size={14} />, label: t("ws.layout4") },
  ];

  return (
    <div className={"grid-tab" + (visible ? "" : " hidden")}>
      <div className="grid-bar">
        <div className="seg" role="group" aria-label={t("ws.layout")}>
          {LAYOUTS.map((l) => (
            <button key={l.v} className={g.layout === l.v ? "on" : ""} title={l.label} onClick={() => setLayout(l.v)}>{l.icon}</button>
          ))}
        </div>
        {hiddenLive > 0 && <span className="muted-note">{t("ws.hiddenLive", { n: hiddenLive })}</span>}
        <div className="sp" />
        <span className="muted-note">{t("ws.maxHint")}</span>
        <button className="btn sm" onClick={save}><Save size={13} />{g.workspaceId ? t("ws.update") : t("ws.save")}</button>
      </div>
      <div className={"grid-area" + (drag ? " dragging" : "")} ref={areaRef}>
        {g.panes.map((p, i) => {
          const r = max !== null ? (i === max ? { l: 0, t: 0, w: 1, h: 1 } : null) : layoutRects[i];
          const shown = !!r;
          const style: React.CSSProperties = r
            ? { left: `calc(${pct(r.l)} + ${r.l > 0 ? GAP / 2 : 0}px)`, top: `calc(${pct(r.t)} + ${r.t > 0 ? GAP / 2 : 0}px)`,
                width: `calc(${pct(r.w)} - ${(r.l > 0 ? GAP / 2 : 0) + (r.l + r.w < 0.999 ? GAP / 2 : 0)}px)`,
                height: `calc(${pct(r.h)} - ${(r.t > 0 ? GAP / 2 : 0) + (r.t + r.h < 0.999 ? GAP / 2 : 0)}px)` }
            : { left: 0, top: 0, width: "100%", height: "100%" };
          return (
            <div key={i} className={"cell" + (shown ? "" : " off") + (g.focus === i ? " focused" : "")} style={style}>
              {p ? (
                <TerminalView key={p.sid} sid={p.sid} hostId={p.hostId} visible={visible && shown}
                  onClose={() => setPaneHost(tab.id, i, null)}
                  pane={{
                    focused: g.focus === i, maximized: max === i,
                    onFocus: () => patchGrid(tab.id, { focus: i }),
                    onToggleMax: () => patchGrid(tab.id, { max: max === i ? null : i, focus: i }),
                  }} />
              ) : shown ? (
                <PanePicker onPick={(hostId) => setPaneHost(tab.id, i, hostId)} onFocus={() => patchGrid(tab.id, { focus: i })} n={i + 1} />
              ) : null}
            </div>
          );
        })}
        {max === null && (g.layout === "4" || g.layout === "2v") && (
          <div className="splitter col" style={{ left: `calc(${pct(g.colSplit)} - 4px)` }} onPointerDown={startDrag("col")} />
        )}
        {max === null && (g.layout === "4" || g.layout === "2h") && (
          <div className="splitter row" style={{ top: `calc(${pct(g.rowSplit)} - 4px)` }} onPointerDown={startDrag("row")} />
        )}
      </div>
    </div>
  );
}

function PanePicker({ onPick, onFocus, n }: { onPick: (hostId: string) => void; onFocus: () => void; n: number }) {
  const t = useT();
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const sorted = [...hosts].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt || a.label.localeCompare(b.label));
    return s ? sorted.filter((h) => [h.label, h.hostname, h.username, h.environment, ...h.tags].some((x) => x.toLowerCase().includes(s))) : sorted;
  }, [hosts, q]);
  return (
    <div className="pane-picker" onMouseDown={onFocus}>
      <div className="pp-head"><span className="pp-n">{n}</span>{t("ws.pickHost")}</div>
      <div className="search pp-search">
        <Search size={14} />
        <input className="input" value={q} placeholder={t("hosts.search")} onChange={(e) => setQ(e.target.value)} spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter" && list[0]) onPick(list[0].id); }} />
      </div>
      <div className="pp-list">
        {list.length === 0 && <div className="pp-empty">{hosts.length ? t("hosts.noresults") : t("hosts.empty.title")}</div>}
        {list.slice(0, 50).map((h) => (
          <button key={h.id} className="pp-item" onClick={() => onPick(h.id)}>
            <Server size={14} style={{ color: hostColor(h.color) }} />
            <span className="pp-label">{h.label}</span>
            <span className="pp-sub">{h.username}@{h.hostname}</span>
            {h.environment && <EnvBadge env={h.environment} />}
          </button>
        ))}
      </div>
    </div>
  );
}
