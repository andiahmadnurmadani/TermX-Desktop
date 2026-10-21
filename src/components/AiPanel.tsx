import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUp, Check, ChevronRight, CircleAlert, Copy, CornerDownLeft, Eye, FileText, KeyRound, ListTree, Loader2, Plus, Server, Sparkles, Square, SquareTerminal, TerminalSquare, X, Zap } from "lucide-react";
import { api, errText, type AiMsg, type AiPart } from "../lib/api";
import { LOCAL_HOST, useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { activeSid, answerApproval, insertIntoTerminal, send, stop, useAi } from "../lib/ai/agent";
import { PROVIDERS, providerById, resolveProvider } from "../lib/ai/providers";
import { isMac } from "../lib/util";
import { PasswordInput } from "./ui";

/* ------------------------------------------------------------------ markdown (small, safe subset) */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (s.startsWith("`")) out.push(<code key={key + i++}>{s.slice(1, -1)}</code>);
    else if (s.startsWith("**")) out.push(<b key={key + i++}>{s.slice(2, -2)}</b>);
    else {
      const lm = /^\[([^\]]+)\]\((.+)\)$/.exec(s)!;
      out.push(<a key={key + i++} href={lm[2]} onClick={(e) => { e.preventDefault(); openUrl(lm[2]).catch(() => {}); }}>{lm[1]}</a>);
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const shell = !lang || /^(sh|bash|zsh|shell|console|fish|ps|powershell)$/i.test(lang);
  return (
    <div className="ai-code">
      <div className="ai-code-bar">
        <span>{lang || "shell"}</span>
        <span className="sp" />
        {shell && <button onClick={() => insertIntoTerminal(code)} title={t("ai.insertHint")}><SquareTerminal size={12} />{t("ai.insert")}</button>}
        <button onClick={() => { navigator.clipboard.writeText(code).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
          {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: ReactNode[] = [];
    const parts = text.split(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g);
    for (let i = 0; i < parts.length; i += 3) {
      const prose = parts[i];
      if (prose?.trim()) {
        const lines = prose.replace(/^\n+|\n+$/g, "").split("\n");
        let list: { ordered: boolean; items: string[] } | null = null;
        let para: string[] = [];
        const flushPara = () => { if (para.length) { out.push(<p key={out.length}>{inline(para.join(" "), `p${out.length}-`)}</p>); para = []; } };
        const flushList = () => {
          if (!list) return;
          const items = list.items.map((it, j) => <li key={j}>{inline(it, `l${out.length}-${j}-`)}</li>);
          out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
          list = null;
        };
        for (const ln of lines) {
          const h = /^(#{1,4})\s+(.*)$/.exec(ln);
          const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(ln);
          if (h) { flushPara(); flushList(); out.push(<h4 key={out.length}>{inline(h[2], `h${out.length}-`)}</h4>); }
          else if (li) {
            flushPara();
            const ordered = /\d/.test(li[1]);
            if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
            list.items.push(li[2]);
          } else if (!ln.trim()) { flushPara(); flushList(); }
          else { flushList(); para.push(ln.trim()); }
        }
        flushPara(); flushList();
      }
      if (i + 2 < parts.length + 1 && parts[i + 2] !== undefined) {
        const code = parts[i + 2].replace(/\n$/, "");
        if (code.trim()) out.push(<CodeBlock key={out.length} code={code} lang={(parts[i + 1] ?? "").trim()} />);
      }
    }
    return out;
  }, [text]);
  return <div className="md">{blocks}</div>;
}

/* ------------------------------------------------------------------ setup (shared with Settings) */

export function AiSetup({ compact }: { compact?: boolean }) {
  const t = useT();
  const ai = useStore((s) => s.vault!.settings.ai);
  const saveSettings = useStore((s) => s.saveSettings);
  const toast = useStore((s) => s.toast);
  const { preset, baseUrl, model } = resolveProvider(ai);
  const [keys, setKeys] = useState<string[]>([]);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState<"" | "busy" | "ok">("");
  const hasKey = keys.includes(preset.id);

  useEffect(() => { api.aiKeyList(PROVIDERS.map((p) => p.id)).then(setKeys).catch(() => {}); }, []);
  useEffect(() => { setModels([]); setKey(""); setTesting(""); }, [preset.id]);

  const patch = (p: Partial<typeof ai>) => saveSettings({ ai: { ...ai, ...p } });
  const saveKey = async () => {
    try {
      await api.aiKeySet(preset.id, key.trim() || null);
      setKey("");
      setKeys(await api.aiKeyList(PROVIDERS.map((p) => p.id)));
      toast(t("ai.keySaved"), "ok");
    } catch (e) { toast(errText(e), "error"); }
  };
  const removeKey = async () => { await api.aiKeySet(preset.id, null).catch(() => {}); setKeys(await api.aiKeyList(PROVIDERS.map((p) => p.id))); };
  const loadModels = async () => {
    setLoading(true);
    try { const m = await api.aiModels(preset.id, preset.api, baseUrl); setModels(m); if (!m.length) toast(t("ai.noModels")); }
    catch (e) { toast(errText(e), "error"); }
    setLoading(false);
  };
  const test = async () => {
    setTesting("busy");
    try {
      await api.aiChat("test-" + Date.now(), preset.id, { api: preset.api, baseUrl, model, system: "Reply with the single word OK.", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [], maxTokens: 16 });
      setTesting("ok");
    } catch (e) { setTesting(""); toast(errText(e), "error"); }
  };
  const options = Array.from(new Set([model, ...preset.models, ...models].filter(Boolean)));

  return (
    <div className={"ai-setup" + (compact ? " compact" : "")}>
      <label className="ai-field">
        <span>{t("ai.provider")}</span>
        <select className="select" value={preset.id} onChange={(e) => patch({ provider: e.target.value })}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}{p.local ? ` · ${t("ai.local")}` : ""}{keys.includes(p.id) ? " ✓" : ""}</option>)}
        </select>
      </label>
      {(preset.needsKey || preset.customUrl || hasKey) && (
        <div className="ai-field">
          <span>{t("ai.apiKey")}{!preset.needsKey && <small> · {t("ai.optional")}</small>}</span>
          {hasKey && !key ? (
            <div className="ai-keyrow"><span className="ai-keyok"><KeyRound size={13} />{t("ai.keyStored")}</span><button className="btn sm" onClick={() => setKey(" ")}>{t("ai.replace")}</button><button className="btn sm ghost" onClick={removeKey}>{t("common.delete")}</button></div>
          ) : (
            <div className="ai-keyrow">
              <PasswordInput value={key.trimStart()} onChange={setKey} placeholder={preset.id === "anthropic" ? "sk-ant-…" : "sk-…"} />
              <button className="btn primary sm" disabled={!key.trim()} onClick={saveKey}>{t("common.save")}</button>
            </div>
          )}
          {preset.keyUrl && <small className="muted">{t("ai.getKey")} <a href={preset.keyUrl} onClick={(e) => { e.preventDefault(); openUrl(preset.keyUrl!).catch(() => {}); }}>{preset.keyUrl.replace(/^https:\/\//, "").split("/")[0]}</a></small>}
        </div>
      )}
      {(preset.customUrl || preset.local || !compact) && (
        <label className="ai-field">
          <span>{t("ai.baseUrl")}</span>
          <input className="input mono" spellCheck={false} placeholder={preset.baseUrl || "https://…/v1"} value={ai.baseUrls?.[preset.id] ?? ""}
            onChange={(e) => patch({ baseUrls: { ...ai.baseUrls, [preset.id]: e.target.value } })} />
        </label>
      )}
      <div className="ai-field">
        <span>{t("ai.model")}</span>
        <div className="ai-keyrow">
          <input className="input mono" list={`ai-models-${preset.id}`} spellCheck={false} placeholder={preset.model || "model-id"} value={ai.models?.[preset.id] ?? ""}
            onChange={(e) => patch({ models: { ...ai.models, [preset.id]: e.target.value } })} />
          <datalist id={`ai-models-${preset.id}`}>{options.map((m) => <option key={m} value={m} />)}</datalist>
          <button className="btn sm" onClick={loadModels} disabled={loading || (preset.needsKey && !hasKey) || !baseUrl} title={t("ai.loadModels")}>{loading ? <Loader2 size={13} className="spin" /> : <ListTree size={13} />}{!compact && t("ai.loadModels")}</button>
        </div>
        {models.length > 0 && <small className="muted">{t("ai.modelsFound", { n: models.length })}</small>}
      </div>
      <div className="ai-test">
        <button className="btn sm" onClick={test} disabled={testing === "busy" || !model || !baseUrl || (preset.needsKey && !hasKey)}>
          {testing === "busy" ? <Loader2 size={13} className="spin" /> : testing === "ok" ? <Check size={13} /> : <Zap size={13} />}{testing === "ok" ? t("ai.testOk") : t("ai.test")}
        </button>
        <small className="muted">{t("ai.keyNote")}</small>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ chat */

type ToolUse = Extract<AiPart, { type: "tool_use" }>;
type ToolResult = Extract<AiPart, { type: "tool_result" }>;

const TOOL_ICON: Record<string, typeof TerminalSquare> = {
  run_command: TerminalSquare, send_keys: CornerDownLeft, read_terminal: Eye, open_terminal: Plus, exec_command: Server,
  host_overview: Server, read_file: FileText, recent_sessions: ListTree, save_snippet: Zap,
};

function ToolCard({ use, result }: { use: ToolUse; result?: ToolResult }) {
  const t = useT();
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const { running, runningOutput, approval, busy } = useAi();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [trust, setTrust] = useState(false);
  const inp = use.input as Record<string, string>;
  const host = inp.host_id === LOCAL_HOST ? t("term.local") : hosts.find((h) => h.id === inp.host_id)?.label;
  const Icon = TOOL_ICON[use.name] ?? Sparkles;
  const cmd = inp.command ?? inp.keys ?? inp.path ?? "";
  const pending = approval?.toolId === use.id;
  const isRunning = running === use.id;
  const state = pending ? "ask" : isRunning ? "run" : result ? (result.isError ? "err" : "ok") : busy ? "wait" : "err";
  const title = t(("ai.tool." + use.name) as never) || use.name;
  const declined = result?.isError && /declined|stopped/i.test(result.content);

  useEffect(() => { if (pending) setEdit(approval!.command); }, [pending, approval]);
  // grow the command box with its (wrapped) content
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = box.current; if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; } }, [edit, pending]);

  return (
    <div className={"ai-tool " + state + (pending ? " pending" : "")}>
      <button className="ai-tool-head" onClick={() => !pending && setOpen(!open)}>
        <span className="ai-tool-ico">{state === "run" ? <Loader2 size={13} className="spin" /> : state === "ok" ? <Icon size={13} /> : state === "err" ? <CircleAlert size={13} /> : <Icon size={13} />}</span>
        <span className="ai-tool-title">{title}{host ? <em> · {host}</em> : pending ? <em> · {approval!.hostLabel}</em> : null}</span>
        {declined && <span className="ai-tool-tag">{t("ai.skipped")}</span>}
        {!pending && (result || isRunning) && <ChevronRight size={13} className={"chev" + (open || isRunning ? " open" : "")} />}
      </button>
      {cmd && !pending && <pre className="ai-tool-cmd">{use.name === "run_command" || use.name === "exec_command" ? "$ " : ""}{cmd}</pre>}
      {pending && (
        <div className="ai-approve">
          {approval!.production && <div className="ai-warn prod"><CircleAlert size={13} />{t("ai.prodWarn")}</div>}
          {approval!.risk && <div className="ai-warn"><CircleAlert size={13} />{approval!.risk}</div>}
          <textarea ref={box} className="input mono" rows={1} value={edit ?? ""} spellCheck={false}
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); answerApproval(true, edit ?? undefined, undefined, trust); } if (e.key === "Escape") answerApproval(false); }} autoFocus />
          <div className="ai-approve-row">
            <label className="ai-check"><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />{t("ai.trustChat")}</label>
            <span className="sp" />
            <button className="btn sm" onClick={() => answerApproval(false)}>{t("ai.skip")}</button>
            <button className="btn sm primary" onClick={() => answerApproval(true, edit ?? undefined, undefined, trust)}>{approval!.kind === "snippet" ? t("common.save") : t("ai.run")}<span className="kbd">↵</span></button>
          </div>
        </div>
      )}
      {isRunning && runningOutput && <pre className="ai-tool-out live">{runningOutput}</pre>}
      {open && result && !isRunning && <pre className="ai-tool-out">{result.content}</pre>}
    </div>
  );
}

function Messages({ history }: { history: AiMsg[] }) {
  const results = new Map<string, ToolResult>();
  for (const m of history) for (const p of m.content) if (p.type === "tool_result") results.set(p.toolUseId, p);
  return (
    <>
      {history.map((m, i) => {
        if (m.role === "user") {
          const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
          return text ? <div key={i} className="ai-msg user"><div className="bubble">{text}</div></div> : null;
        }
        return (
          <div key={i} className="ai-msg assistant">
            {m.content.map((p, j) => (
              <Fragment key={j}>
                {p.type === "text" && p.text.trim() && <Markdown text={p.text} />}
                {p.type === "tool_use" && <ToolCard use={p} result={results.get(p.id)} />}
              </Fragment>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function AiPanel() {
  const t = useT();
  const { open, setOpen, history, busy, stream, error, reset, usage } = useAi();
  const ai = useStore((s) => s.vault!.settings.ai);
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.active);
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const sessions = useStore((s) => s.sessions);
  const [input, setInput] = useState("");
  const [keys, setKeys] = useState<string[] | null>(null);
  const [setup, setSetup] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const { preset, model, baseUrl } = resolveProvider(ai);
  const ready = !!model && !!baseUrl && (!preset.needsKey || (keys?.includes(preset.id) ?? false));

  useEffect(() => { if (open) api.aiKeyList(PROVIDERS.map((p) => p.id)).then(setKeys).catch(() => setKeys([])); }, [open, setup, ai.provider]);
  useEffect(() => { if (open) setTimeout(() => ta.current?.focus(), 30); }, [open]);
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight); }, [history.length]);

  // what the AI will look at by default
  const sid = useMemo(() => activeSid(), [tabs, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctxHost = useMemo(() => {
    if (!sid) return null;
    const tab = tabs.find((x) => x.id === sid) ?? tabs.find((x) => x.grid?.panes.some((p) => p?.sid === sid));
    const hostId = tab?.kind === "term" ? tab.hostId : tab?.grid?.panes.find((p) => p?.sid === sid)?.hostId;
    if (hostId === LOCAL_HOST) return { id: LOCAL_HOST, label: t("term.local") };
    return hosts.find((h) => h.id === hostId) ?? null;
  }, [sid, tabs, hosts, t]);

  if (!open) return null;
  const submit = () => {
    if (!input.trim() || busy || !ready) return;
    const text = input;
    setInput("");
    send(text);
  };
  const suggestions = ctxHost
    ? [t("ai.sug.health", { h: ctxHost.label }), t("ai.sug.disk"), t("ai.sug.logs"), t("ai.sug.services")]
    : [t("ai.sug.hosts"), t("ai.sug.fleet"), t("ai.sug.explain")];

  return (
    <aside className="ai-panel" onKeyDown={(e) => { if (e.key === "Escape" && busy) stop(); }}>
      <div className="ai-head" data-tauri-drag-region>
        <span className="ai-title"><Sparkles size={15} />TermX AI</span>
        <button className="ai-model" onClick={() => setSetup(!setup)} title={t("ai.settings")}>{preset.name} · <span className="mono">{model || "—"}</span></button>
        <span className="sp" data-tauri-drag-region />
        <button className="icon-btn" title={t("ai.newChat")} disabled={!history.length && !error} onClick={reset}><Plus size={15} /></button>
        <button className="icon-btn" title={t("common.close")} onClick={() => setOpen(false)}><X size={15} /></button>
      </div>

      {(setup || (keys && !ready)) ? (
        <div className="ai-body">
          <div className="ai-intro">
            <div className="ai-intro-ico"><Sparkles size={20} /></div>
            <h3>{ready ? t("ai.settings") : t("ai.setupTitle")}</h3>
            {!ready && <p>{t("ai.setupBody")}</p>}
          </div>
          <AiSetup compact />
          {ready && <button className="btn primary ai-done" onClick={() => setSetup(false)}>{t("ai.startChat")}</button>}
        </div>
      ) : (
        <div className="ai-body" ref={scroller}>
          {!history.length && !busy && (
            <div className="ai-intro">
              <div className="ai-intro-ico"><Sparkles size={20} /></div>
              <h3>{t("ai.hello")}</h3>
              <p>{t("ai.helloBody")}</p>
              <div className="ai-sugs">{suggestions.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>
            </div>
          )}
          <Messages history={history} />
          {busy && (stream ? <div className="ai-msg assistant"><Markdown text={stream} /></div> : !useAi.getState().running && !useAi.getState().approval && <div className="ai-thinking"><span /><span /><span /></div>)}
          {error && <div className="ai-error"><CircleAlert size={14} /><span>{error}</span></div>}
        </div>
      )}

      <div className="ai-compose">
        <div className="ai-ctx">
          {ctxHost ? <span className="chip-ctx"><TerminalSquare size={12} />{ctxHost.label}{sessions[sid!]?.state !== "connected" && <em> · {sessions[sid!]?.state}</em>}</span> : <span className="chip-ctx muted"><Server size={12} />{t("ai.ctxAll", { n: hosts.length })}</span>}
          <span className="chip-ctx muted" title={t("ai.approvalHint")}>{t(("ai.approval." + ai.approval) as never)}</span>
          {usage.input + usage.output > 0 && <span className="ai-usage">{Math.round((usage.input + usage.output) / 100) / 10}k tok</span>}
        </div>
        <div className="ai-input">
          <textarea ref={ta} rows={1} value={input} disabled={!ready} placeholder={ready ? t("ai.placeholder") : t("ai.setupFirst")}
            onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(160, e.target.scrollHeight) + "px"; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          {busy
            ? <button className="ai-send stop" onClick={stop} title={t("ai.stop")}><Square size={12} /></button>
            : <button className="ai-send" onClick={submit} disabled={!input.trim() || !ready} title={t("ai.send")}><ArrowUp size={15} /></button>}
        </div>
        <div className="ai-foot muted">{t("ai.foot", { k: isMac ? "⌘J" : "Ctrl+Shift+J" })}</div>
      </div>
    </aside>
  );
}

/** Tab-bar button. */
export function AiButton() {
  const t = useT();
  const { open, setOpen, busy } = useAi();
  return (
    <button className={"ai-btn" + (open ? " on" : "") + (busy ? " busy" : "")} onClick={() => setOpen(!open)} title={`${t("ai.title")} (${isMac ? "⌘J" : "Ctrl+Shift+J"})`}>
      <Sparkles size={14} /><span>AI</span>
    </button>
  );
}

export { providerById };
