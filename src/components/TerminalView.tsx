import { useEffect, useRef, useState } from "react";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowUp, Check, CircleAlert, FolderOpen, History, KeyRound, Maximize2, Minimize2, RefreshCw, Search, TerminalSquare, X, Braces } from "lucide-react";
import { loadHistory, remember, suggest, type Suggestion } from "../lib/autocomplete";
import { stop as stopAi, useAi } from "../lib/ai/agent";
import "@xterm/xterm/css/xterm.css";
import { api, Channel, errText, events, type LogEvent, type Settings } from "../lib/api";
import { LOCAL_HOST, termHandles, useStore, type SessionInfo } from "../lib/store";
import { terminalTheme } from "../lib/themes";
import { useResolvedDark } from "../lib/theme";
import { useT } from "../lib/i18n";
import { isMac, isMod } from "../lib/util";
import { ContextMenu } from "./ui";
import { EnvBadge } from "./HostsView";
import { OsIcon } from "../lib/os";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]/g;

/** Is the terminal sitting at a password prompt? "sudo" prompts may be answered automatically. */
export function detectPrompt(tail: string): "sudo" | "password" | null {
  const line = (tail.replace(ANSI, "").split(/\r\n|\n|\r/).pop() ?? "").replace(/\s+$/, " ");
  if (line.length > 140) return null;
  if (/^\[sudo\][^:]*:\s*$/.test(line) || /^doas \([^)]*\) password:\s*$/.test(line)) return "sudo";
  // "user@other-host's password:" belongs to a different server: never offer this host's password
  if (/'s password:\s*$/.test(line)) return null;
  if (/^\s*(password|passwort|kata sandi|mot de passe|contraseña)( for [^\s:]+)?\s*:\s*$/i.test(line)) return "password";
  return null;
}

const fontStack = (f: string) => `"${f}", "JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;

function applySettings(term: Terminal, s: Settings, dark: boolean) {
  term.options.fontFamily = fontStack(s.fontFamily);
  term.options.fontSize = s.fontSize;
  term.options.lineHeight = s.lineHeight;
  term.options.fontWeight = (s.fontWeight || 400) as Terminal["options"]["fontWeight"];
  term.options.fontWeightBold = (s.fontWeightBold || 700) as Terminal["options"]["fontWeightBold"];
  term.options.letterSpacing = s.letterSpacing || 0;
  term.options.cursorStyle = s.cursorStyle;
  term.options.cursorBlink = s.cursorBlink;
  term.options.scrollback = s.scrollback;
  term.options.theme = terminalTheme(s.terminalTheme, dark, s.accent);
}

interface AcState { items: Suggestion[]; sel: number; typed: string; left: number; top: number; above: boolean }

/** Extra chrome when the terminal lives in a workspace pane. */
export interface PaneChrome { focused: boolean; maximized: boolean; onFocus: () => void; onToggleMax: () => void }

export function TerminalView({ sid, hostId, visible, onClose, pane }: { sid: string; hostId: string; visible: boolean; onClose: () => void; pane?: PaneChrome }) {
  const tab = { id: sid, hostId };
  const isLocal = hostId === LOCAL_HOST;
  const [shell, setShell] = useState("");
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
  const { patchSession, openSftp, toast, saveSettings } = useStore();
  const [steps, setSteps] = useState<LogEvent[]>([]);
  const [prompt, setPrompt] = useState<"sudo" | "password" | null>(null);
  const autoBlock = useRef(false);
  const hostRef = useRef(host);
  hostRef.current = host;
  const logRef = useRef<HTMLDivElement>(null);
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
  const aiHere = useAi((a) => a.runningSid === sid);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const snippetsRef = useRef(snippets);
  snippetsRef.current = snippets;
  // autocomplete pop-up
  const [ac, setAcState] = useState<AcState | null>(null);
  const acRef = useRef<AcState | null>(null);
  const setAc = (v: AcState | null) => { acRef.current = v; setAcState(v); };
  const acceptRef = useRef<(s: Suggestion) => void>(() => {});

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
        rightClickSelectsWord: false,
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

      const outputSubs = new Set<() => void>();
      const readLines = (from: number) => {
        const buf = term.buffer.active;
        const out: string[] = [];
        for (let i = Math.max(0, from); i < buf.length; i++) {
          const line = buf.getLine(i);
          if (!line) continue;
          const text = line.translateToString(true);
          if (line.isWrapped && out.length) out[out.length - 1] += text; else out.push(text);
        }
        while (out.length && !out[out.length - 1].trim()) out.pop();
        return out.join("\n");
      };
      termHandles.set(tab.id, {
        hostId: tab.hostId,
        write: (text) => api.sshWrite(tab.id, text),
        focus: () => term.focus(),
        cursorLine: () => term.buffer.active.baseY + term.buffer.active.cursorY,
        readFrom: readLines,
        tail: (n) => { const b = term.buffer.active; return readLines(b.baseY + b.cursorY + 1 - n); },
        onOutput: (cb) => { outputSubs.add(cb); return () => outputSubs.delete(cb); },
      });

      /* ---- autocomplete: where the user's input starts, what they typed, and suggestions */
      loadHistory();
      let anchor: { m: IMarker; x: number } | null = null;
      let acPendingUntil = 0;
      let acTimer = 0;
      const dropAnchor = () => { anchor?.m.dispose(); anchor = null; };
      const typedText = (): string | null => {
        const b = term.buffer.active;
        if (b.type !== "normal" || !anchor || anchor.m.isDisposed) return null;
        const cy = b.baseY + b.cursorY, ay = anchor.m.line;
        if (ay < 0 || cy < ay || cy - ay > 8) return null;
        let out = "";
        for (let y = ay; y <= cy; y++) {
          const line = b.getLine(y);
          if (!line) return null;
          out += line.translateToString(false, y === ay ? anchor.x : 0, y === cy ? b.cursorX : term.cols);
        }
        // the cursor must be at the end of the input
        if (b.getLine(cy)?.translateToString(true, b.cursorX).trim()) return null;
        return out;
      };
      const computeAc = () => {
        if (settingsRef.current.autocomplete === false || !visibleRef.current) { if (acRef.current) setAc(null); return; }
        const typed = typedText();
        const items = typed == null ? [] : suggest(tab.hostId, typed, snippetsRef.current);
        if (!items.length || typed == null) { if (acRef.current) setAc(null); return; }
        const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
        if (!screen) return;
        const sr = screen.getBoundingClientRect(), er = el.getBoundingClientRect();
        const cw = sr.width / term.cols, chh = sr.height / term.rows;
        const b = term.buffer.active;
        const left = Math.max(4, Math.min(sr.left - er.left + b.cursorX * cw - 8, er.width - 360));
        const above = b.cursorY > term.rows * 0.55;
        const top = sr.top - er.top + (above ? b.cursorY * chh - 4 : (b.cursorY + 1) * chh + 4);
        const prev = acRef.current;
        const sel = prev && prev.typed === typed ? Math.min(prev.sel, items.length - 1) : -1;
        setAc({ items, sel, typed, left, top, above });
      };
      const scheduleAc = () => {
        acPendingUntil = Date.now() + 1500;
        window.clearTimeout(acTimer);
        acTimer = window.setTimeout(computeAc, 35);
      };
      outputSubs.add(() => { if (Date.now() < acPendingUntil) { window.clearTimeout(acTimer); acTimer = window.setTimeout(computeAc, 15); } });
      cleanups.push(() => { window.clearTimeout(acTimer); dropAnchor(); });
      acceptRef.current = (sg) => {
        const cur = acRef.current;
        setAc(null);
        if (!cur) return;
        const typed = cur.typed;
        const data = sg.text.startsWith(typed) ? sg.text.slice(typed.length) : "\x7f".repeat([...typed].length) + sg.text;
        if (data) api.sshWrite(tab.id, data).catch(() => {});
        acPendingUntil = 0;
        term.focus();
      };

      // keys: let app shortcuts bubble; Ctrl+Shift+C/V on Windows/Linux
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const cur = acRef.current;
        if (cur && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const n = cur.items.length;
          if (e.key === "ArrowDown") { e.preventDefault(); setAc({ ...cur, sel: (cur.sel + 1) % n }); return false; }
          if (e.key === "ArrowUp") {
            if (cur.sel < 0) { setAc(null); return true; }
            e.preventDefault(); setAc({ ...cur, sel: cur.sel - 1 }); return false;
          }
          if ((e.key === "Tab" || e.key === "Enter") && cur.sel >= 0) { e.preventDefault(); acceptRef.current(cur.items[cur.sel]); return false; }
          if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); acceptRef.current(cur.items[0]); return false; }
          if (e.key === "Escape") { e.preventDefault(); setAc(null); acPendingUntil = 0; return false; }
        }
        if (isMod(e, "f")) { setFind(true); setTimeout(() => findInput.current?.focus(), 0); return false; }
        if (["k", "w", "t", "j", "l", "[", "]", "enter", "1", "2", "3", "4", "5", "6", "7", "8", "9"].some((k) => isMod(e, k))) return false;
        if (!isMac && e.ctrlKey && e.shiftKey) {
          if (e.key === "C") { const sel = term.getSelection(); if (sel) navigator.clipboard.writeText(sel); return false; }
          if (e.key === "V") { navigator.clipboard.readText().then((x) => term.paste(x)).catch(() => {}); return false; }
        }
        return true;
      });

      term.onData((d) => {
        autoBlock.current = false;
        setPrompt(null);
        // autocomplete bookkeeping happens before the keystroke reaches the shell
        if (d.includes("\r")) {
          const typed = typedText();
          if (typed && term.buffer.active.type === "normal") remember(tab.hostId, typed);
          dropAnchor(); acPendingUntil = 0; if (acRef.current) setAc(null);
        } else if (d === "\x03" || d === "\x04" || d === "\x0c") {
          dropAnchor(); acPendingUntil = 0; if (acRef.current) setAc(null);
        } else if (term.buffer.active.type === "normal") {
          if (!anchor) { const b = term.buffer.active; const m = term.registerMarker(0); if (m) anchor = { m, x: b.cursorX }; }
          const printable = !d.startsWith("\x1b") && (/^[^\x00-\x1f]/.test(d) || d === "\x7f" || d === "\b");
          if (printable) scheduleAc(); else { acPendingUntil = 0; if (acRef.current) setAc(null); }
        }
        api.sshWrite(tab.id, d).catch(() => {});
      });
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
        if ((p.state === "connecting" || p.state === "reconnecting") && !p.message) setSteps([]);
        if (p.state !== "connected") setPrompt(null);
      });
      cleanups.push(un);
      const unp = await events.on<{ id: string; at: number; text: string }>("session:progress", (p) => {
        if (p.id !== tab.id) return;
        setSteps((s) => (s.length > 200 ? s : [...s, { at: p.at, text: p.text }]));
      });
      cleanups.push(unp);
      if (disposed) return;

      const ch = new Channel<ArrayBuffer>();
      // watch the end of the output for password prompts (sudo auto-fill)
      const dec = new TextDecoder();
      let tail = "";
      let check = 0;
      ch.onmessage = (buf) => {
        const bytes = new Uint8Array(buf);
        term.write(bytes, () => outputSubs.forEach((f) => f()));
        tail = (tail + dec.decode(bytes, { stream: true })).slice(-400);
        window.clearTimeout(check);
        check = window.setTimeout(() => {
          const kind = detectPrompt(tail);
          if (!kind || hostRef.current?.auth !== "password") { setPrompt(null); return; }
          if (kind === "sudo" && settingsRef.current.sudoAutofill && !autoBlock.current) {
            // once per prompt series: a wrong saved password must not be retried in a loop
            autoBlock.current = true;
            setPrompt(null);
            api.sshFillPassword(tab.id).catch(() => setPrompt(kind));
            return;
          }
          setPrompt(kind);
        }, 60);
      };
      cleanups.push(() => window.clearTimeout(check));
      try {
        if (isLocal) setShell(await api.localOpen(tab.id, term.cols, term.rows, ch));
        else await api.sshOpen(tab.id, tab.hostId, term.cols, term.rows, ch);
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
    let stale = false;
    // measure with the real font, not the fallback, or the cell grid ends up too wide/narrow
    document.fonts.load(`${settings.fontSize}px "${settings.fontFamily}"`).catch(() => {}).finally(() => {
      if (stale || termRef.current !== term) return;
      applySettings(term, settings, dark);
      requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* ignore */ } });
    });
    return () => { stale = true; };
  }, [settings, dark]);

  // refit + focus when shown
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* ignore */ } if (focusedRef.current) termRef.current?.focus(); });
    return () => cancelAnimationFrame(id);
  }, [visible, pane?.maximized]);

  useEffect(() => { if (!visible && acRef.current) setAc(null); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const fillPassword = () => {
    setPrompt(null);
    api.sshFillPassword(tab.id).then(() => termRef.current?.focus()).catch((e) => toast(errText(e), "error"));
  };
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [steps]);

  const state = session.state;
  const overlay = state === "failed" || state === "ended" || (state === "connecting" && !everConnected);

  return (
    <div className={"tpane" + (aiHere ? " ai-live" : "") + (visible ? "" : " hidden") + (pane ? " in-pane" : "") + (pane?.focused ? " focused" : "")} style={{ ["--term-bg" as string]: bg }}
      onMouseDownCapture={pane ? () => { if (!pane.focused) pane.onFocus(); } : undefined}>
      <div className="tbar" onDoubleClick={pane ? (e) => { if ((e.target as HTMLElement).closest("button")) return; pane.onToggleMax(); } : undefined}>
        <div className="who"><span className={"dot " + state} />{isLocal && <><b className="pane-name">{t("term.local")}</b><span className="addr">{shell.split(/[\\/]/).pop()}</span></>}{pane && host ? <b className="pane-name">{host.label}</b> : null}{host?.environment && <EnvBadge env={host.environment} />}<span className="addr">{host ? `${host.username}@${host.hostname}` : ""}</span>{host?.tmux && <span className="tag">tmux</span>}</div>
        <div className="sp" />
        {aiHere && <span className="ai-typing" title={t("ai.typingHint")}><i />{t("ai.typing")}<button onClick={() => stopAi()}>{t("ai.stopShort")}</button></span>}
        <div style={{ position: "relative" }}>
          <button className="btn ghost sm" onClick={() => setSnipOpen(!snipOpen)}><Braces size={14} /><span className="lbl">{t("term.snippets")}</span></button>
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
        {!isLocal && <button className="icon-btn" title={t("term.sftp")} onClick={() => openSftp(tab.hostId)}><FolderOpen size={15} /></button>}
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
        {ac && !overlay && (
          <div className={"ac-pop" + (ac.above ? " above" : "")} style={{ left: ac.left, top: ac.top }} onMouseDown={(e) => e.preventDefault()}>
            {ac.items.map((it, i) => (
              <div key={it.text} className={"ac-item" + (i === ac.sel ? " on" : "")} onMouseEnter={() => setAc({ ...ac, sel: i })} onClick={() => acceptRef.current(it)}>
                <span className={"ac-ic " + it.kind}>{it.kind === "history" ? <History size={12} /> : it.kind === "snippet" ? <Braces size={12} /> : <TerminalSquare size={12} />}</span>
                <span className="ac-t">{(() => { const n = it.text.startsWith(ac.typed.trimStart()) ? ac.typed.trimStart().length : 0; return <><b>{it.text.slice(0, n)}</b>{it.text.slice(n)}</>; })()}</span>
                {it.label && <span className="ac-l">{it.label}</span>}
              </div>
            ))}
            <div className="ac-foot">{t("ac.hint")}</div>
          </div>
        )}
        {state === "reconnecting" && (
          <div className="findbar" style={{ top: 8, left: "50%", right: "auto", transform: "translateX(-50%)", padding: "7px 14px", gap: 10 }}>
            <div className="spinner" style={{ width: 14, height: 14 }} />{t("term.reconnecting")}
          </div>
        )}
        {prompt && !overlay && (
          <div className="sudo-bar" role="status">
            <KeyRound size={15} className="ic" />
            <span className="txt">{t(prompt === "sudo" ? "term.sudoAsk" : "term.pwAsk")}</span>
            <button className="btn primary sm" onClick={fillPassword}>{t("term.fillPw")}</button>
            {prompt === "sudo" && (
              <label className="chk" title={t("set.sudoAutofillHint")}>
                <input type="checkbox" checked={!!settings.sudoAutofill} onChange={(e) => saveSettings({ sudoAutofill: e.target.checked })} />{t("term.autoFill")}
              </label>
            )}
            <button className="icon-btn" title={t("common.close")} onClick={() => { setPrompt(null); termRef.current?.focus(); }}><X size={14} /></button>
          </div>
        )}
        {overlay && (
          <div className="overlay-msg">
            <div className={"overlay-card conn" + (state === "ended" ? " compact" : "")}>
              {host && (
                <div className="conn-head">
                  <OsIcon host={host} size={36} />
                  <div className="conn-who"><b>{host.label}</b><small>{host.username}@{host.hostname}{host.port !== 22 ? `:${host.port}` : ""}</small></div>
                </div>
              )}
              <div className={"conn-status " + state}>
                {state === "connecting" ? <span className="mini-spin" /> : state === "ended" ? <TerminalSquare size={16} /> : <CircleAlert size={16} />}
                <span>{t(state === "connecting" ? "term.connecting" : state === "ended" ? "term.ended" : "term.failed")}</span>
              </div>
              {state === "connecting" && <div className="conn-progress"><i style={{ width: `${Math.min(94, 6 + steps.length * 6.5)}%` }} /></div>}
              {session.message && state !== "connecting" && <div className="msg">{session.message}</div>}
              {state !== "ended" && steps.length > 0 && (
                <div className="conn-log" ref={logRef} aria-label={t("term.connLog")}>
                  {steps.map((st, i) => {
                    const err = st.text.startsWith("Error") || st.text.includes(" failed") || st.text.includes("rejected");
                    const last = i === steps.length - 1 && state === "connecting";
                    return (
                      <div key={i} className={"step" + (err ? " err" : "") + (last ? " cur" : "")}>
                        <span className="ts">{((st.at - steps[0].at) / 1000).toFixed(2)}s</span>
                        <span className="si">{last ? <span className="mini-spin" /> : err ? <X size={12} /> : <Check size={12} />}</span>
                        <span className="tx">{st.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {state !== "connecting" && (
                <div className="conn-acts">
                  {isLocal
                    ? <button className="btn primary" onClick={() => { useStore.getState().openLocal(); onClose(); }}><RefreshCw size={14} />{t("term.restart")}</button>
                    : <button className="btn primary" onClick={() => { setSteps([]); patchSession(tab.id, { state: "connecting" }); api.sshReconnect(tab.id).catch((e) => toast(errText(e), "error")); }}><RefreshCw size={14} />{t("term.reconnect")}</button>}
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
