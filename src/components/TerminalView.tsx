import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowUp, FolderOpen, Maximize2, Minimize2, RefreshCw, Search, TerminalSquare, X, Zap } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { api, Channel, errText, events, type Settings } from "../lib/api";
import { termHandles, useStore, type SessionInfo } from "../lib/store";
import { terminalTheme } from "../lib/themes";
import { useResolvedDark } from "../lib/theme";
import { useT } from "../lib/i18n";
import { isMac, isMod } from "../lib/util";
import { ContextMenu } from "./ui";
import { EnvBadge } from "./HostsView";

const fontStack = (f: string) => `"${f}", "JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;

function applySettings(term: Terminal, s: Settings, dark: boolean) {
  term.options.fontFamily = fontStack(s.fontFamily);
  term.options.fontSize = s.fontSize;
  term.options.lineHeight = s.lineHeight;
  term.options.cursorStyle = s.cursorStyle;
  term.options.cursorBlink = s.cursorBlink;
  term.options.scrollback = s.scrollback;
  term.options.theme = terminalTheme(s.terminalTheme, dark, s.accent);
}

/** Extra chrome when the terminal lives in a workspace pane. */
export interface PaneChrome { focused: boolean; maximized: boolean; onFocus: () => void; onToggleMax: () => void }

export function TerminalView({ sid, hostId, visible, onClose, pane }: { sid: string; hostId: string; visible: boolean; onClose: () => void; pane?: PaneChrome }) {
  const tab = { id: sid, hostId };
  const t = useT();
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const settings = useStore((s) => s.vault!.settings);
  const host = useStore((s) => s.vault?.hosts.find((h) => h.id === tab.hostId));
  const snippets = useStore((s) => s.vault?.snippets ?? []);
  const session: SessionInfo = useStore((s) => s.sessions[sid]) ?? { state: "connecting" };
  const { patchSession, openSftp, toast } = useStore();
  const focusedRef = useRef(pane?.focused ?? true);
  focusedRef.current = pane?.focused ?? true;
  const dark = useResolvedDark();
  const [find, setFind] = useState(false);
  const [q, setQ] = useState("");
  const [snipOpen, setSnipOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [everConnected, setEverConnected] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // create terminal + session once
  useEffect(() => {
    const el = mountRef.current!;
    let disposed = false;
    const cleanups: (() => void)[] = [];

    (async () => {
      const s = settingsRef.current;
      try { await document.fonts.load(`${s.fontSize}px "${s.fontFamily}"`); } catch { /* fall back to stack */ }
      if (disposed) return;

      const term = new Terminal({
        allowProposedApi: true, macOptionIsMeta: false, scrollOnUserInput: true, smoothScrollDuration: 0,
        fontWeight: "400", fontWeightBold: "700", letterSpacing: 0, rightClickSelectsWord: false,
        cursorInactiveStyle: "outline", drawBoldTextInBrightColors: true,
      });
      applySettings(term, s, darkRef.current);
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new WebLinksAddon((_e, uri) => { openUrl(uri).catch(() => {}); }));
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.open(el);
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch { /* canvas/DOM renderer fallback */ }
      termRef.current = term; fitRef.current = fit; searchRef.current = search;
      fit.fit();

      termHandles.set(tab.id, { write: (text) => api.sshWrite(tab.id, text), focus: () => term.focus() });

      // keys: let app shortcuts bubble; Ctrl+Shift+C/V on Windows/Linux
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        if (isMod(e, "f")) { setFind(true); setTimeout(() => findInput.current?.focus(), 0); return false; }
        if (["k", "w", "t", "[", "]", "enter", "1", "2", "3", "4", "5", "6", "7", "8", "9"].some((k) => isMod(e, k))) return false;
        if (!isMac && e.ctrlKey && e.shiftKey) {
          if (e.key === "C") { const sel = term.getSelection(); if (sel) navigator.clipboard.writeText(sel); return false; }
          if (e.key === "V") { navigator.clipboard.readText().then((x) => term.paste(x)).catch(() => {}); return false; }
        }
        return true;
      });

      term.onData((d) => { api.sshWrite(tab.id, d).catch(() => {}); });
      term.onResize(({ cols, rows }) => { api.sshResize(tab.id, cols, rows).catch(() => {}); });

      let selTimer: number | undefined;
      term.onSelectionChange(() => {
        if (!settingsRef.current.copyOnSelect) return;
        window.clearTimeout(selTimer);
        selTimer = window.setTimeout(() => { const sel = term.getSelection(); if (sel) navigator.clipboard.writeText(sel).catch(() => {}); }, 180);
      });

      let raf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { if (visibleRef.current && el.clientWidth > 20) { try { fit.fit(); } catch { /* ignore */ } } });
      });
      ro.observe(el);
      cleanups.push(() => { ro.disconnect(); cancelAnimationFrame(raf); });

      const un = await events.on<{ id: string; state: SessionInfo["state"]; message?: string }>("session:state", (p) => {
        if (p.id !== tab.id) return;
        patchSession(tab.id, { state: p.state, message: p.message ?? undefined });
        if (p.state === "connected") setEverConnected(true);
      });
      cleanups.push(un);
      if (disposed) return;

      const ch = new Channel<ArrayBuffer>();
      ch.onmessage = (buf) => term.write(new Uint8Array(buf));
      try {
        await api.sshOpen(tab.id, tab.hostId, term.cols, term.rows, ch);
      } catch (e) {
        patchSession(tab.id, { state: "failed", message: errText(e) });
      }
      if (visibleRef.current && focusedRef.current) term.focus();
    })();

    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
      termHandles.delete(tab.id);
      api.sshClose(tab.id).catch(() => {});
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // live settings
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    applySettings(term, settings, dark);
    requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* ignore */ } });
  }, [settings, dark]);

  // refit + focus when shown
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* ignore */ } if (focusedRef.current) termRef.current?.focus(); });
    return () => cancelAnimationFrame(id);
  }, [visible, pane?.maximized]);

  // focus follows the selected pane
  useEffect(() => { if (pane?.focused && visible) termRef.current?.focus(); }, [pane?.focused, visible]);

  const bg = terminalTheme(settings.terminalTheme, dark, settings.accent).background ?? "#0e0f12";
  const runSnippet = (cmd: string, auto: boolean) => { setSnipOpen(false); api.sshWrite(tab.id, cmd + (auto ? "\r" : "")); termRef.current?.focus(); };
  const closeFind = () => { setFind(false); searchRef.current?.clearDecorations(); termRef.current?.focus(); };
  const doFind = (dir: "next" | "prev", text = q) => {
    if (!text) return;
    const opts = { decorations: { matchOverviewRuler: "#888", activeMatchColorOverviewRuler: "#3ddc97", matchBackground: "#ffd33d55", activeMatchBackground: "#3ddc9788" } };
    if (dir === "next") searchRef.current?.findNext(text, opts); else searchRef.current?.findPrevious(text, opts);
  };

  const state = session.state;
  const overlay = state === "failed" || state === "ended" || (state === "connecting" && !everConnected);

  return (
    <div className={"tpane" + (visible ? "" : " hidden") + (pane ? " in-pane" : "") + (pane?.focused ? " focused" : "")} style={{ ["--term-bg" as string]: bg }}
      onMouseDownCapture={pane ? () => { if (!pane.focused) pane.onFocus(); } : undefined}>
      <div className="tbar" onDoubleClick={pane ? (e) => { if ((e.target as HTMLElement).closest("button")) return; pane.onToggleMax(); } : undefined}>
        <div className="who"><span className={"dot " + state} />{pane && host ? <b className="pane-name">{host.label}</b> : null}{host?.environment && <EnvBadge env={host.environment} />}<span className="addr">{host ? `${host.username}@${host.hostname}` : ""}</span>{host?.tmux && <span className="tag">tmux</span>}</div>
        <div className="sp" />
        <div style={{ position: "relative" }}>
          <button className="btn ghost sm" onClick={() => setSnipOpen(!snipOpen)}><Zap size={14} /><span className="lbl">{t("term.snippets")}</span></button>
          {snipOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onMouseDown={() => setSnipOpen(false)} />
              <div className="pop" style={{ right: 0, top: 32 }}>
                {snippets.length === 0 && <div style={{ padding: 12, color: "var(--text-3)" }}>{t("term.noSnippets")}</div>}
                {snippets.map((s) => <button key={s.id} onClick={() => runSnippet(s.command, s.autoRun)}><div className="n">{s.name}</div><div className="c">{s.command}</div></button>)}
              </div>
            </>
          )}
        </div>
        <button className="icon-btn" title={t("term.search")} onClick={() => { setFind(!find); setTimeout(() => findInput.current?.focus(), 0); }}><Search size={15} /></button>
        <button className="icon-btn" title={t("term.sftp")} onClick={() => openSftp(tab.hostId)}><FolderOpen size={15} /></button>
        {pane && <button className="icon-btn" title={t(pane.maximized ? "ws.restore" : "ws.maximize")} onClick={pane.onToggleMax}>{pane.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>}
        {pane && <button className="icon-btn" title={t("ws.closePane")} onClick={onClose}><X size={15} /></button>}
      </div>

      {find && (
        <div className="findbar">
          <input ref={findInput} value={q} placeholder={t("term.search")} spellCheck={false}
            onChange={(e) => { setQ(e.target.value); doFind("next", e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter") doFind(e.shiftKey ? "prev" : "next"); if (e.key === "Escape") closeFind(); }} />
          <button className="icon-btn" onClick={() => doFind("prev")}><ArrowUp size={14} /></button>
          <button className="icon-btn" onClick={() => doFind("next")}><ArrowDown size={14} /></button>
          <button className="icon-btn" onClick={closeFind}><X size={14} /></button>
        </div>
      )}

      <div className="tmount" ref={mountRef} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
        {state === "reconnecting" && (
          <div className="findbar" style={{ top: 8, left: "50%", right: "auto", transform: "translateX(-50%)", padding: "7px 14px", gap: 10 }}>
            <div className="spinner" style={{ width: 14, height: 14 }} />{t("term.reconnecting")}
          </div>
        )}
        {overlay && (
          <div className="overlay-msg">
            <div className="overlay-card">
              {state === "connecting" ? <div className="spinner" /> : <TerminalSquare size={26} color="var(--danger)" />}
              <div style={{ fontWeight: 600 }}>{t(state === "connecting" ? "term.connecting" : state === "ended" ? "term.ended" : "term.failed")}</div>
              {session.message && state !== "connecting" && <div className="msg">{session.message}</div>}
              {state !== "connecting" && (
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button className="btn primary" onClick={() => { patchSession(tab.id, { state: "connecting" }); api.sshReconnect(tab.id).catch((e) => toast(errText(e), "error")); }}><RefreshCw size={14} />{t("term.reconnect")}</button>
                  <button className="btn" onClick={onClose}>{t(pane ? "ws.closePane" : "term.closeTab")}</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: t("term.copy"), onClick: () => { const s = termRef.current?.getSelection(); if (s) navigator.clipboard.writeText(s); } },
          { label: t("term.paste"), onClick: () => navigator.clipboard.readText().then((x) => termRef.current?.paste(x)).catch(() => {}) },
          { sep: true, label: "", onClick: () => {} },
          { label: t("term.search"), onClick: () => { setFind(true); setTimeout(() => findInput.current?.focus(), 0); } },
          { label: t("term.clear"), onClick: () => termRef.current?.clear() },
        ]} />
      )}
    </div>
  );
}
