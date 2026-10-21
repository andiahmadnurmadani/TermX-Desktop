import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, Check, Download, FileText, ListTree, RefreshCw, ScrollText, Search, Terminal as TermIcon, Trash2, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { api, errText, type SessionLog } from "../lib/api";
import { useStore, type Tab } from "../lib/store";
import { useT } from "../lib/i18n";
import { OsIcon } from "../lib/os";
import { terminalTheme } from "../lib/themes";
import { useResolvedDark } from "../lib/theme";
import { confirmDialog } from "../lib/dialogs";
import { EmptyState, Switch } from "./ui";

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
};
const isOpen = (l: SessionLog) => l.status === "connecting" || l.status === "connected" || l.status === "reconnecting";
const dayKey = (t: number) => new Date(t).toDateString();

async function exportLog(l: SessionLog, plain: boolean, toast: (m: string, k?: "info" | "error" | "ok") => void, okMsg: string) {
  const stamp = new Date(l.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const name = `${l.hostLabel.replace(/[^\w.-]+/g, "_")}-${stamp}.${plain ? "txt" : "log"}`;
  const p = await saveDialog({ defaultPath: name, filters: [{ name: plain ? "Text" : "Terminal log", extensions: [plain ? "txt" : "log"] }] });
  if (!p) return;
  try { await api.logExport(l.id, p, plain); toast(okMsg, "ok"); } catch (e) { toast(errText(e), "error"); }
}

export function LogsView() {
  const t = useT();
  const { vault, saveSettings, openLog, openTerm, toast } = useStore();
  const hosts = vault?.hosts ?? [];
  const [logs, setLogs] = useState<SessionLog[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "failed">("all");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => api.logsList().then(setLogs).catch((e) => toast(errText(e), "error")), [toast]);
  useEffect(() => {
    load();
    const iv = window.setInterval(() => { setNow(Date.now()); if (document.visibilityState !== "hidden") load(); }, 4000);
    return () => clearInterval(iv);
  }, [load]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (logs ?? []).filter((l) => {
      if (filter === "open" && !isOpen(l)) return false;
      if (filter === "failed" && l.status !== "failed") return false;
      return !s || [l.hostLabel, l.hostname, l.username, l.message, l.status].some((x) => x.toLowerCase().includes(s));
    });
  }, [logs, q, filter]);

  const days = useMemo(() => {
    const out: { key: string; label: string; items: SessionLog[] }[] = [];
    const today = new Date().toDateString(), yest = new Date(Date.now() - 86400000).toDateString();
    for (const l of list) {
      const k = dayKey(l.startedAt);
      if (!out.length || out[out.length - 1].key !== k)
        out.push({ key: k, label: k === today ? t("logs.today") : k === yest ? t("logs.yesterday") : new Date(l.startedAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), items: [] });
      out[out.length - 1].items.push(l);
    }
    return out;
  }, [list, t]);

  const clearAll = async () => {
    if (!(await confirmDialog(t("logs.clearConfirm")))) return;
    try { await api.logsDelete(null); load(); } catch (e) { toast(errText(e), "error"); }
  };
  const del = async (id: string) => { try { await api.logsDelete(id); load(); } catch (e) { toast(errText(e), "error"); } };

  const openCount = (logs ?? []).filter(isOpen).length;
  const failCount = (logs ?? []).filter((l) => l.status === "failed").length;

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <div className="title"><h1>{t("logs.title")}</h1><span className="count-sub">{t("logs.count", { n: logs?.length ?? 0 })}</span></div>
        <div className="sp" />
        <div className="acts">
          <label className="inline-toggle" title={t("logs.recordHint")}>
            <Switch on={vault!.settings.sessionLogs} onChange={(b) => saveSettings({ sessionLogs: b })} />{t("logs.record")}
          </label>
          <button className="btn danger" disabled={!logs?.length} onClick={clearAll}><Trash2 size={14} /><span className="lbl">{t("logs.clear")}</span></button>
        </div>
      </div>
      {logs && logs.length > 0 && (
        <div className="toolbar">
          <div className="search">
            <Search size={15} />
            <input className="input" placeholder={t("logs.search")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            {q && <button className="icon-btn clear" title={t("common.clear")} onClick={() => setQ("")}><X size={13} /></button>}
          </div>
          <div className="chips">
            <button className={"chip" + (filter === "all" ? " on" : "")} onClick={() => setFilter("all")}>{t("hosts.all")}</button>
            <button className={"chip" + (filter === "open" ? " on" : "")} onClick={() => setFilter("open")}><span className="dot connected" />{t("logs.active")} {openCount ? <b>{openCount}</b> : null}</button>
            <button className={"chip" + (filter === "failed" ? " on" : "")} onClick={() => setFilter("failed")}><span className="dot failed" />{t("logs.failed")} {failCount ? <b>{failCount}</b> : null}</button>
          </div>
        </div>
      )}

      {logs === null ? <div className="spinner" style={{ margin: 40 }} /> : logs.length === 0 ? (
        <EmptyState icon={<ScrollText size={26} />} title={t("logs.empty.title")} body={t("logs.empty.body")} />
      ) : list.length === 0 ? (
        <EmptyState icon={<Search size={24} />} title={t("hosts.noresults")} body="" />
      ) : days.map((d) => (
        <div key={d.key}>
          <div className="group-title">{d.label}<span className="line" /></div>
          <div className="panel log-list">
            {d.items.map((l) => {
              const host = hosts.find((h) => h.id === l.hostId);
              const end = l.endedAt || (isOpen(l) ? now : l.startedAt);
              const from = l.connectedAt || l.startedAt;
              return (
                <div key={l.id} className={"log-row" + (l.transcript || l.events?.length ? " clickable" : "")} onClick={() => (l.transcript || l.events?.length) && openLog(l)}>
                  <OsIcon host={{ osId: host?.osId ?? null, osName: host?.osName ?? null }} size={32} />
                  <div className="log-main">
                    <div className="log-name"><b>{l.hostLabel}</b><span className="mono sub">{l.username}@{l.hostname}{l.port !== 22 ? `:${l.port}` : ""}</span></div>
                    <div className="log-meta">
                      <span className={"pill st-" + l.status}><span className={"dot " + l.status} />{t(("logs.st." + l.status) as never)}</span>
                      <span>{new Date(l.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      {l.connectedAt > 0 && <span>· {fmtDur(end - from)}</span>}
                      {l.bytes > 0 && <span>· {fmtBytes(l.bytes)}</span>}
                      {l.reconnects > 0 && <span>· {t("logs.reconnects", { n: l.reconnects })}</span>}
                      {l.message && l.status !== "connected" && <span className={"msg" + (l.status === "failed" ? " bad-text" : "")} title={l.message}>· {l.message}</span>}
                    </div>
                  </div>
                  <div className="log-acts" onClick={(e) => e.stopPropagation()}>
                    {l.transcript ? <button className="btn sm" onClick={() => openLog(l)}><FileText size={13} />{t("logs.view")}</button>
                      : l.events?.length ? <button className="btn sm" onClick={() => openLog(l)}><ListTree size={13} />{t("logs.connLog")}</button> : null}
                    {l.transcript && <button className="icon-btn" title={t("logs.export")} onClick={() => exportLog(l, true, toast, t("logs.exported"))}><Download size={14} /></button>}
                    {host && <button className="icon-btn" title={t("hosts.connect")} onClick={() => openTerm(host.id)}><TermIcon size={14} /></button>}
                    {!isOpen(l) && <button className="icon-btn danger" title={t("common.delete")} onClick={() => del(l.id)}><Trash2 size={14} /></button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div></div>
  );
}

/** Read-only replay of a recorded session in a tab. */
export function LogTabView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.vault!.settings);
  const dark = useResolvedDark();
  const log = tab.log!;
  const mount = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(true);
  const [size, setSize] = useState(0);
  const events = log.events ?? [];
  const [showSteps, setShowSteps] = useState(!log.transcript || log.status === "failed");

  const load = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    if (!log.transcript) { setBusy(false); return; }
    setBusy(true);
    try {
      const buf = new Uint8Array(await api.logTranscript(log.id));
      setSize(buf.length);
      term.reset();
      term.write(buf, () => term.scrollToBottom());
    } catch (e) { toast(errText(e), "error"); }
    setBusy(false);
  }, [log.id, log.transcript, toast]);

  useEffect(() => {
    const s = useStore.getState().vault!.settings;
    const term = new Terminal({
      disableStdin: true, cursorBlink: false, cursorStyle: "bar", cursorInactiveStyle: "none", scrollback: 200000, allowProposedApi: true,
      fontFamily: `"${s.fontFamily}", "JetBrains Mono", Menlo, Consolas, monospace`, fontSize: s.fontSize, lineHeight: s.lineHeight,
      convertEol: false, smoothScrollDuration: 0,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit); term.loadAddon(search);
    term.open(mount.current!);
    termRef.current = term; fitRef.current = fit; searchRef.current = search;
    try { fit.fit(); } catch { /* hidden */ }
    load();
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
    ro.observe(mount.current!);
    return () => { ro.disconnect(); term.dispose(); termRef.current = null; };
  }, [load]);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = terminalTheme(settings.terminalTheme, dark, settings.accent); }, [settings.terminalTheme, settings.accent, dark]);
  useEffect(() => { if (visible) requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* */ } }); }, [visible]);

  const find = (back: boolean) => q && (back ? searchRef.current?.findPrevious(q) : searchRef.current?.findNext(q));
  const bg = terminalTheme(settings.terminalTheme, dark, settings.accent).background;

  return (
    <div className={"log-view" + (visible ? "" : " hidden")}>
      <div className="run-head">
        <span className={"pill st-" + log.status}><span className={"dot " + log.status} />{t(("logs.st." + log.status) as never)}</span>
        <h2>{log.hostLabel}</h2>
        <span className="sub mono">{log.username}@{log.hostname}</span>
        <span className="sub">{new Date(log.startedAt).toLocaleString()}{size ? ` · ${fmtBytes(size)}` : ""}</span>
        <div className="sp" />
        <div className="search sm">
          <Search size={13} />
          <input className="input" placeholder={t("term.search")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find(e.shiftKey)} spellCheck={false} />
        </div>
        <button className="icon-btn" title={t("logs.prev")} onClick={() => find(true)}><ArrowUp size={14} /></button>
        <button className="icon-btn" title={t("logs.next")} onClick={() => find(false)}><ArrowDown size={14} /></button>
        {events.length > 0 && <button className={"btn sm" + (showSteps ? " on" : "")} onClick={() => setShowSteps(!showSteps)}><ListTree size={13} />{t("logs.connLog")}</button>}
        <button className="icon-btn" title={t("common.refresh")} onClick={load}>{busy ? <span className="mini-spin" /> : <RefreshCw size={14} />}</button>
        <button className="btn sm" onClick={() => exportLog(log, true, toast, t("logs.exported"))}><Download size={13} />.txt</button>
        <button className="btn sm" onClick={() => exportLog(log, false, toast, t("logs.exported"))}><Download size={13} />.log</button>
      </div>
      {showSteps && events.length > 0 && (
        <div className="conn-log log-steps">
          {events.map((st, i) => {
            const err = st.text.startsWith("Error") || st.text.includes(" failed") || st.text.includes("rejected");
            return (
              <div key={i} className={"step" + (err ? " err" : "")}>
                <span className="ts">{new Date(st.at).toLocaleTimeString()}</span>
                <span className="si">{err ? <X size={12} /> : <Check size={12} />}</span>
                <span className="tx">{st.text}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="log-term" style={{ background: bg, display: log.transcript ? undefined : "none" }}><div ref={mount} className="log-mount" /></div>
    </div>
  );
}
