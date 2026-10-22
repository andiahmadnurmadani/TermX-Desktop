import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Activity, ArrowUp, BookMarked, Box, Check, ChevronRight, CircleAlert, CircleHelp, Clock, Code, Copy, CornerDownLeft, Download, Eye, FileText, Gauge, Globe, HardDrive, KeyRound, Layers, ListTree, Loader2, Network, Plus, ScrollText, Search, Server, Shield, ShieldAlert, Sparkles, Square, SquareTerminal, TerminalSquare, Trash2, X, Zap, Braces, Minimize2 } from "lucide-react";
import { api, errText, uid, type AiMsg, type AiPart, type AiTemplate } from "../lib/api";
import { LOCAL_HOST, useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { activeSid, answerApproval, insertIntoTerminal, send, stop, useAi } from "../lib/ai/agent";
import { PROVIDERS, providerById, resolveProvider } from "../lib/ai/providers";
import { isMac } from "../lib/util";
import { confirmDialog } from "../lib/dialogs";
import { TEMPLATES, TEMPLATE_CATS, fillTemplate, tplText, type PromptTemplate } from "../lib/ai/templates";
import { PasswordInput } from "./ui";
import { ContextMeter, fmtTokens } from "./AiContext";
import { SessionsMenu } from "./AiSessions";
import { initSessions, newSession } from "../lib/ai/sessions";
import { summaryOf, withoutSummary } from "../lib/ai/context";

/* ------------------------------------------------------------------ markdown (small, safe subset) */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|(?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*])|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (s.startsWith("`")) out.push(<code key={key + i++}>{s.slice(1, -1)}</code>);
    else if (s.startsWith("**")) out.push(<b key={key + i++}>{inline(s.slice(2, -2), key + i + "b")}</b>);
    else if (s.startsWith("~~")) out.push(<s key={key + i++}>{s.slice(2, -2)}</s>);
    else if (s.startsWith("*")) out.push(<em key={key + i++}>{s.slice(1, -1)}</em>);
    else {
      const lm = /^\[([^\]]+)\]\((.+)\)$/.exec(s)!;
      out.push(<a key={key + i++} href={lm[2]} onClick={(e) => { e.preventDefault(); openUrl(lm[2]).catch(() => {}); }}>{lm[1]}</a>);
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** GFM table pieces: a separator row like |---|:--:|--:| and the cells of a row. */
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function MdTable({ head, align, rows, k }: { head: string[]; align: ("left" | "center" | "right" | undefined)[]; rows: string[][]; k: string }) {
  return (
    <div className="md-table">
      <table>
        <thead><tr>{head.map((c, i) => <th key={i} style={{ textAlign: align[i] }}>{inline(c, `${k}h${i}-`)}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, ci) => <td key={ci} style={{ textAlign: align[ci] }}>{inline(r[ci] ?? "", `${k}r${ri}c${ci}-`)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
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
        let quote: string[] = [];
        const flushQuote = () => { if (quote.length) { out.push(<blockquote key={out.length}>{inline(quote.join(" "), `q${out.length}-`)}</blockquote>); quote = []; } };
        for (let li_ = 0; li_ < lines.length; li_++) {
          const ln = lines[li_];
          // table: a row with pipes followed by a separator row
          if (ln.includes("|") && li_ + 1 < lines.length && TABLE_SEP.test(lines[li_ + 1]) && lines[li_ + 1].includes("-")) {
            flushPara(); flushList(); flushQuote();
            const head = tableCells(ln);
            const align = tableCells(lines[li_ + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined) as "left" | "center" | "right" | undefined);
            const rows: string[][] = [];
            let j = li_ + 2;
            while (j < lines.length && lines[j].trim() && lines[j].includes("|")) rows.push(tableCells(lines[j++]));
            out.push(<MdTable key={out.length} k={`t${out.length}`} head={head} align={align} rows={rows} />);
            li_ = j - 1;
            continue;
          }
          const q = /^\s*>\s?(.*)$/.exec(ln);
          if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
          flushQuote();
          if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { flushPara(); flushList(); out.push(<hr key={out.length} />); continue; }
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
        flushPara(); flushList(); flushQuote();
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
  host_overview: Server, read_file: FileText, recent_sessions: ListTree, save_snippet: Braces,
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
          <label className="ai-check"><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />{t("ai.trustChat")}</label>
          <div className="ai-approve-row">
            {approval!.kind !== "snippet" && <button className="btn sm ghost" title={t("ai.alwaysHint")} onClick={async () => {
              if (!(await confirmDialog(t("ai.alwaysConfirm")))) return;
              const st = useStore.getState();
              await st.saveSettings({ ai: { ...st.vault!.settings.ai, approval: "always" } });
              answerApproval(true, edit ?? undefined, undefined, true);
            }}>{t("ai.alwaysAllow")}</button>}
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

/** Text blocks stay as they are; consecutive tool calls become one step list. */
function groupParts(parts: AiPart[]): ({ kind: "text"; text: string } | { kind: "steps"; uses: ToolUse[] })[] {
  const out: ({ kind: "text"; text: string } | { kind: "steps"; uses: ToolUse[] })[] = [];
  for (const p of parts) {
    if (p.type === "text") { if (p.text.trim()) out.push({ kind: "text", text: p.text }); }
    else if (p.type === "tool_use") {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.uses.push(p); else out.push({ kind: "steps", uses: [p] });
    }
  }
  return out;
}

/** The folded-away start of a long chat, kept as notes the model still sees. */
function SummaryCard({ text }: { text: string }) {
  const t = useT();
  return (
    <details className="ai-summary">
      <summary><Minimize2 size={13} />{t("ai.ctx.summary")}</summary>
      <div className="ai-summary-body"><Markdown text={text} /></div>
    </details>
  );
}

function Messages({ history }: { history: AiMsg[] }) {
  const results = new Map<string, ToolResult>();
  for (const m of history) for (const p of m.content) if (p.type === "tool_result") results.set(p.toolUseId, p);
  return (
    <>
      {history.map((m, i) => {
        if (m.role === "user") {
          const summary = summaryOf(m);
          const text = withoutSummary(m).content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
          return (
            <Fragment key={i}>
              {summary && <SummaryCard text={summary} />}
              {text ? <div className="ai-msg user"><div className="bubble">{text}</div></div> : null}
            </Fragment>
          );
        }
        return (
          <div key={i} className="ai-msg assistant">
            {groupParts(m.content).map((g, j) => g.kind === "text"
              ? <Markdown key={j} text={g.text} />
              : <div key={j} className="ai-steps">{g.uses.map((u) => <ToolCard key={u.id} use={u} result={results.get(u.id)} />)}</div>)}
          </div>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ prompt templates */

const TPL_ICON: Record<string, typeof Sparkles> = {
  activity: Activity, gauge: Gauge, "hard-drive": HardDrive, scroll: ScrollText, server: Server, shield: Shield, key: KeyRound,
  box: Box, layers: Layers, globe: Globe, network: Network, download: Download, clock: Clock, servers: ListTree, help: CircleHelp, code: Code,
};

type Pick = { name: string; prompt: string };

/** Pop-over above the composer: built-in templates by category, plus the user's own. */
function TemplateMenu({ draft, host, onPick, onClose }: { draft: string; host: string | null; onPick: (p: Pick) => void; onClose: () => void }) {
  const t = useT();
  const { vault, saveSettings } = useStore();
  const ai = vault!.settings.ai;
  const lang = vault!.settings.language;
  const mine = ai.templates ?? [];
  const [q, setQ] = useState("");
  const [naming, setNaming] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest(".ai-tpl-btn")) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", h);
    window.addEventListener("keydown", k, true);
    return () => { document.removeEventListener("mousedown", h); window.removeEventListener("keydown", k, true); };
  }, [onClose]);
  const ql = q.trim().toLowerCase();
  const match = (x: Pick) => !ql || x.name.toLowerCase().includes(ql) || x.prompt.toLowerCase().includes(ql);
  const mineShown = mine.filter(match);
  const groups = (Object.keys(TEMPLATE_CATS) as PromptTemplate["cat"][])
    .map((c) => ({ c, items: TEMPLATES.filter((x) => x.cat === c && match(tplText(x, lang))) }))
    .filter((g) => g.items.length);
  const saveMine = (name: string) => {
    const tpl: AiTemplate = { id: uid(), name: name.trim(), prompt: draft.trim() };
    saveSettings({ ai: { ...ai, templates: [...mine, tpl] } });
    setNaming(null);
  };
  return (
    <div className="ai-tpl" ref={ref}>
      <div className="ai-tpl-search"><Search size={13} /><input autoFocus placeholder={t("ai.tpl.search")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="ai-tpl-list">
        {(mineShown.length > 0) && <div className="ai-tpl-cat">{t("ai.tpl.mine")}</div>}
        {mineShown.map((m) => (
          <div key={m.id} className="ai-tpl-item mine" onClick={() => onPick(m)}>
            <BookMarked size={14} /><div><b>{m.name}</b><small>{m.prompt}</small></div>
            <button className="icon-btn" title={t("common.delete")} onClick={(e) => { e.stopPropagation(); saveSettings({ ai: { ...ai, templates: mine.filter((x) => x.id !== m.id) } }); }}><Trash2 size={13} /></button>
          </div>
        ))}
        {groups.map((g) => (
          <Fragment key={g.c}>
            <div className="ai-tpl-cat">{TEMPLATE_CATS[g.c][lang === "id" ? "id" : "en"]}</div>
            {g.items.map((x) => {
              const tx = tplText(x, lang);
              const Icon = TPL_ICON[x.icon] ?? Sparkles;
              return (
                <div key={x.id} className="ai-tpl-item" onClick={() => onPick(tx)}>
                  <Icon size={14} /><div><b>{tx.name}</b><small>{tx.prompt.replace(/\{host\}/g, host ?? "…")}</small></div>
                </div>
              );
            })}
          </Fragment>
        ))}
        {!groups.length && !mineShown.length && <div className="ai-tpl-empty">{t("ai.tpl.none")}</div>}
      </div>
      <div className="ai-tpl-foot">
        {naming === null
          ? <button className="btn sm ghost" disabled={!draft.trim()} title={draft.trim() ? "" : t("ai.tpl.saveHint")} onClick={() => setNaming("")}><Plus size={13} />{t("ai.tpl.save")}</button>
          : <form className="ai-tpl-name" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) saveMine(naming); }}>
              <input className="input" autoFocus placeholder={t("ai.tpl.name")} value={naming} onChange={(e) => setNaming(e.target.value)} />
              <button className="btn sm primary" disabled={!naming.trim()}>{t("common.save")}</button>
            </form>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ panel width */

const W_KEY = "termx.aiWidth";
/** The header (title, model, buttons, window controls) and the composer row only fit from about 420px. */
const MIN_W = 420;
const clampW = (w: number) => Math.round(Math.max(MIN_W, Math.min(w, Math.min(960, window.innerWidth - 400))));
function loadW() { try { const v = Number(localStorage.getItem(W_KEY)); return v > 0 ? v : 460; } catch { return 460; } }

export function AiPanel() {
  const t = useT();
  const { open, setOpen, history, busy, stream, error, compacting, ctxEvent } = useAi();
  const ai = useStore((s) => s.vault!.settings.ai);
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.active);
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const sessions = useStore((s) => s.sessions);
  const [input, setInput] = useState("");
  const [keys, setKeys] = useState<string[] | null>(null);
  const [setup, setSetup] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [width, setWidth] = useState(() => clampW(loadW()));
  const lang = useStore((s) => s.vault!.settings.language);
  useEffect(() => { const h = () => setWidth((w) => clampW(w)); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  const startResize = (e: { preventDefault(): void; clientX: number }) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    let w = w0;
    document.body.classList.add("resizing-x");
    const move = (ev: PointerEvent) => { w = clampW(w0 + (x0 - ev.clientX)); setWidth(w); };
    const up = () => {
      document.body.classList.remove("resizing-x");
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      try { localStorage.setItem(W_KEY, String(w)); } catch { /* ignore */ }
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const scroller = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const { preset, model, baseUrl } = resolveProvider(ai);
  const ready = !!model && !!baseUrl && (!preset.needsKey || (keys?.includes(preset.id) ?? false));

  useEffect(() => { if (open) api.aiKeyList(PROVIDERS.map((p) => p.id)).then(setKeys).catch(() => setKeys([])); }, [open, setup, ai.provider]);
  useEffect(() => { if (open) setTimeout(() => ta.current?.focus(), 30); }, [open]);
  useEffect(() => { void initSessions(); }, []);
  useEffect(() => {
    if (!ctxEvent) return;
    useStore.getState().toast(t("ai.ctx.compacted", { a: fmtTokens(ctxEvent.before), b: fmtTokens(ctxEvent.after) }), "info");
  }, [ctxEvent?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight); }, [history.length]);
  // closing the panel unmounts the list: when it opens again, land on the newest message, not the first
  useEffect(() => {
    if (!open) return;
    const jump = () => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; };
    jump();
    const id = requestAnimationFrame(jump);
    return () => cancelAnimationFrame(id);
  }, [open, setup]);

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
  const grow = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = "auto"; el.style.height = Math.min(220, el.scrollHeight) + "px"; } };
  const applyTemplate = (p: { prompt: string }) => {
    const { text, sel } = fillTemplate(p.prompt, ctxHost?.label ?? null, lang);
    setInput(text);
    setTplOpen(false);
    requestAnimationFrame(() => { const el = ta.current; if (!el) return; grow(el); el.focus(); if (sel) el.setSelectionRange(sel[0], sel[1]); else el.setSelectionRange(text.length, text.length); });
  };
  const isProd = !!ctxHost && "environment" in ctxHost && ctxHost.environment === "production";
  const quick = (ctxHost ? ["health", "why-slow", "disk", "errors"] : ["fleet", "explain", "ssh-key", "reach"]).map((id) => TEMPLATES.find((x) => x.id === id)!).filter(Boolean);
  const submit = () => {
    if (!input.trim() || busy || !ready) return;
    const text = input;
    setInput("");
    setTplOpen(false);
    if (ta.current) ta.current.style.height = "auto";
    send(text);
  };

  return (
    <aside className="ai-panel" style={{ width }} onKeyDown={(e) => { if (e.key === "Escape" && busy) stop(); }}>
      <div className="ai-resize" onPointerDown={startResize} onDoubleClick={() => { setWidth(clampW(460)); try { localStorage.removeItem(W_KEY); } catch { /* ignore */ } }} title={t("ai.resize")} />
      <div className="ai-head" data-tauri-drag-region>
        <span className="ai-title"><Sparkles size={15} />TermX AI</span>
        <button className="ai-model" onClick={() => setSetup(!setup)} title={`${preset.name} · ${model || "—"} — ${t("ai.settings")}`}><span className="ai-model-t"><span className="mono">{model || preset.name}</span></span></button>
        <span className="sp" data-tauri-drag-region />
        <SessionsMenu />
        <button className="icon-btn" title={t("ai.newChat")} disabled={!history.length && !error} onClick={() => void newSession()}><Plus size={15} /></button>
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
              <div className="ai-intro-ico"><Sparkles size={18} /></div>
              <h3>{t("ai.hello")}</h3>
              <p>{t("ai.helloBody")}</p>
              <div className="ai-quick">
                {quick.map((x) => { const tx = tplText(x, lang); const Icon = TPL_ICON[x.icon] ?? Sparkles; return (
                  <button key={x.id} onClick={() => applyTemplate(tx)}>
                    <span className="qi"><Icon size={14} /></span>
                    <span className="qt"><b>{tx.name}</b><small>{tx.prompt.replace(/\{host\}/g, ctxHost?.label ?? "…")}</small></span>
                  </button>
                ); })}
              </div>
              <button className="ai-more" onClick={() => setTplOpen(true)}><BookMarked size={13} />{t("ai.tpl.all")}<ChevronRight size={13} /></button>
            </div>
          )}
          <Messages history={history} />
          {compacting && <div className="ai-compacting"><Loader2 size={13} className="spin" />{t("ai.ctx.working")}</div>}
          {busy && !compacting && (stream ? <div className="ai-msg assistant"><Markdown text={stream} /></div> : !useAi.getState().running && !useAi.getState().approval && <div className="ai-thinking"><span /><span /><span /></div>)}
          {error && <div className="ai-error"><CircleAlert size={14} /><span>{error}</span></div>}
        </div>
      )}

      <div className="ai-compose">
        {tplOpen && <TemplateMenu draft={input} host={ctxHost?.label ?? null} onPick={applyTemplate} onClose={() => setTplOpen(false)} />}
        <div className={"ai-box" + (busy ? " busy" : "")}>
          <textarea ref={ta} rows={1} value={input} disabled={!ready} placeholder={ready ? t("ai.placeholder") : t("ai.setupFirst")}
            onChange={(e) => { setInput(e.target.value); grow(e.target); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <div className="ai-box-bar">
            <div className="ai-chips">
            <button className={"chip-ctx ai-tpl-btn" + (tplOpen ? " on" : "")} onClick={() => setTplOpen(!tplOpen)} title={t("ai.tpl.title")}><BookMarked size={12} /><span className="ell">{t("ai.tpl.short")}</span></button>
            {ctxHost ? <span className={"chip-ctx" + (isProd ? " prod" : "")} title={isProd ? t("ai.prodCtx") : undefined}>{isProd ? <ShieldAlert size={12} /> : <TerminalSquare size={12} />}<span className="ell">{ctxHost.label}</span>{sessions[sid!]?.state && sessions[sid!]?.state !== "connected" && <em> · {sessions[sid!]?.state}</em>}</span> : <span className="chip-ctx muted"><Server size={12} />{t("ai.ctxAll", { n: hosts.length })}</span>}
            <span className={"chip-ctx " + (ai.approval === "always" ? "warn" : "muted")} title={t("ai.approvalHint")}><span className="ell">{t(("ai.approval." + ai.approval) as never)}</span></span>
            </div>
            <div className="ai-box-end">
            <ContextMeter />
            {busy
              ? <button className="ai-send stop" onClick={stop} title={t("ai.stop")}><Square size={11} /></button>
              : <button className="ai-send" onClick={submit} disabled={!input.trim() || !ready} title={`${t("ai.send")} (Enter) · Shift+Enter ↵ · ${isMac ? "⌘J" : "Ctrl+Shift+J"}`}><ArrowUp size={15} /></button>}
            </div>
          </div>
        </div>
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
