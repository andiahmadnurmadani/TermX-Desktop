import { create } from "zustand";
import { api, errText, events, uid, type AiMsg, type AiPart, type AiTool, type Host } from "../api";
import { LOCAL_HOST, termHandles, useStore, type Tab } from "../store";
import { isReadOnly, riskNote } from "./safety";
import { resolveProvider } from "./providers";

/* ------------------------------------------------------------------ state */

export interface Approval {
  toolId: string;
  kind: "command" | "keys" | "exec" | "snippet";
  command: string;
  hostLabel: string;
  production: boolean;
  risk: string | null;
}

interface AiState {
  open: boolean;
  history: AiMsg[];
  busy: boolean;
  /** Text streamed so far for the turn in progress. */
  stream: string;
  /** Tool call currently executing. */
  running: string | null;
  /** Live output of the running terminal command. */
  runningOutput: string;
  approval: Approval | null;
  /** Commands approved for the rest of this chat. */
  trustChat: boolean;
  error: string | null;
  usage: { input: number; output: number };
  /** Session the user is looking at when they send (the default target). */
  focusSid: string | null;
  setOpen: (b: boolean) => void;
  reset: () => void;
}

export const useAi = create<AiState>((set) => ({
  open: false, history: [], busy: false, stream: "", running: null, runningOutput: "", approval: null, trustChat: false,
  error: null, usage: { input: 0, output: 0 }, focusSid: null,
  setOpen: (open) => set({ open }),
  reset: () => { stop(); set({ history: [], stream: "", error: null, trustChat: false, usage: { input: 0, output: 0 }, approval: null, running: null }); },
}));

let reqId: string | null = null;
let stopped = false;
let approve: ((r: { ok: boolean; command?: string; note?: string }) => void) | null = null;

export function stop() {
  stopped = true;
  if (reqId) api.aiCancel(reqId).catch(() => {});
  approve?.({ ok: false, note: "Stopped by the user." });
}

export function answerApproval(ok: boolean, command?: string, note?: string, trust = false) {
  if (trust) useAi.setState({ trustChat: true });
  approve?.({ ok, command, note });
}

/* ------------------------------------------------------------------ helpers */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LOCAL_LABEL = "this computer (local shell)";
const labelOf = (id: string) => (id === LOCAL_HOST ? LOCAL_LABEL : hostsById().get(id)?.label ?? "?");

function hostsById() { return new Map((useStore.getState().vault?.hosts ?? []).map((h) => [h.id, h])); }

/** Every open terminal: plain tabs and workspace panes. */
export function listSessions() {
  const st = useStore.getState();
  const hosts = hostsById();
  const out: { sid: string; hostId: string; host: string; where: string; state: string; tabId: string }[] = [];
  for (const tb of st.tabs) {
    if (tb.kind === "term") out.push({ sid: tb.id, hostId: tb.hostId, host: tb.hostId === LOCAL_HOST ? LOCAL_LABEL : hosts.get(tb.hostId)?.label ?? "?", where: `tab "${tb.title}"`, state: st.sessions[tb.id]?.state ?? "connecting", tabId: tb.id });
    if (tb.kind === "grid") tb.grid?.panes.forEach((p, i) => {
      if (p) out.push({ sid: p.sid, hostId: p.hostId, host: p.hostId === LOCAL_HOST ? LOCAL_LABEL : hosts.get(p.hostId)?.label ?? "?", where: `workspace "${tb.title}" pane ${i + 1}`, state: st.sessions[p.sid]?.state ?? "connecting", tabId: tb.id });
    });
  }
  return out;
}

/** The terminal the user is looking at, if any. */
export function activeSid(): string | null {
  const st = useStore.getState();
  const tb = st.tabs.find((x) => x.id === st.active);
  if (!tb) return null;
  if (tb.kind === "term") return tb.id;
  if (tb.kind === "grid" && tb.grid) return tb.grid.panes[tb.grid.focus]?.sid ?? tb.grid.panes.find(Boolean)?.sid ?? null;
  return null;
}

/** Bring a session on screen so the user can watch the AI type. */
function reveal(sid: string) {
  const st = useStore.getState();
  const tab: Tab | undefined = st.tabs.find((x) => x.id === sid || x.grid?.panes.some((p) => p?.sid === sid));
  if (!tab) return;
  if (st.active !== tab.id) st.setActive(tab.id);
  if (tab.grid) {
    const i = tab.grid.panes.findIndex((p) => p?.sid === sid);
    if (i >= 0 && tab.grid.focus !== i) st.patchGrid(tab.id, { focus: i });
  }
}

const clip = (s: string, max = 12000) => (s.length <= max ? s : s.slice(0, max * 0.3) + `\n… [${s.length - max} characters cut] …\n` + s.slice(-max * 0.7));

const PROMPT_END = /[$#%>❯➜»λ]\s*$/;

function hostOf(id: string): Host | undefined { return hostsById().get(id); }

/* ------------------------------------------------------------------ context */

function line(...xs: (string | number | null | undefined | false)[]) { return xs.filter((x) => x !== "" && x != null && x !== false).join(" | "); }

export function buildSystem(): string {
  const st = useStore.getState();
  const v = st.vault!;
  const s = v.settings;
  const groups = new Map(v.groups.map((g) => [g.id, g.name]));
  const hosts = hostsById();
  const sessions = listSessions();
  const act = activeSid();
  const parts: string[] = [];

  parts.push(`You are TermX AI, the assistant built into TermX ${st.info?.version ?? ""}, a desktop SSH client (hosts, terminals, SFTP, workspaces, workflows, snippets, live overview, session logs). The user runs it on ${st.info?.os ?? "a desktop"}. Today is ${new Date().toISOString().slice(0, 10)}.

You operate the user's servers by typing commands into their real terminal sessions with the tools below; the user watches every keystroke and can stop you at any time.

How to work:
- Investigate before changing anything. Prefer small, read-only commands, one step at a time, and read the output before the next step.
- host_id "${LOCAL_HOST}" is the user's own computer (a local shell on ${st.info?.os ?? "their desktop"}); use it for local tasks such as ssh-keygen, ping or curl from the user's network.
- Use the user's open terminal when it is on the right host (the "active" session); otherwise open one with open_terminal. Use exec_command for quick background checks that do not need a terminal.
- Make commands non-interactive: add --no-pager to systemctl/journalctl/git, use -n/--lines limits, never start editors (vim, nano) or pagers, never use watch/top without batch mode, avoid commands that never end (tail -f, ping without -c). If something interactive is running, use send_keys (e.g. "<ctrl-c>", "q").
- Before anything destructive or that causes downtime (deleting data, restarts, firewall, package removal, reboots), explain what it will do and why, then run it; the user approves each command. Be extra careful on hosts marked production.
- sudo may prompt for a password; TermX can fill the host's saved password. If a prompt waits for input you cannot give, say so and stop.
- Never print or ask for secrets (passwords, private keys, tokens). TermX never shows you saved passwords.
- Answer in the user's language (the app is set to ${s.language === "id" ? "Indonesian" : "English"}). Be concise; use Markdown, put commands in code blocks. Summarise findings at the end.`);

  parts.push(`## Hosts (${v.hosts.length})\nid | name | user@address:port | group | environment | tags | OS | jump host | auth | notes`);
  for (const h of v.hosts) {
    parts.push(line(h.id, h.label, `${h.username}@${h.hostname}:${h.port}`, h.groupId ? groups.get(h.groupId) : "", h.environment || "", h.tags.length ? h.tags.join(",") : "",
      h.osName || h.osId || "", h.jumpHostId ? `via ${hosts.get(h.jumpHostId)?.label ?? h.jumpHostId}` : "", h.auth + (h.auth === "password" ? (h.hasPassword ? " (saved)" : " (asks)") : ""),
      h.tmux ? "tmux" : "", h.startupCommand ? `startup: ${h.startupCommand}` : "", h.notes ? `notes: ${h.notes.replace(/\s+/g, " ").slice(0, 200)}` : ""));
  }
  if (v.groups.length) parts.push(`## Groups\n${v.groups.map((g) => `${g.name} (${v.hosts.filter((h) => h.groupId === g.id).length} hosts)`).join(", ")}`);

  parts.push(`## Open terminal sessions (${sessions.length})`);
  if (!sessions.length) parts.push("none");
  for (const x of sessions) parts.push(line(x.sid, x.host, x.where, x.state, x.sid === act ? "ACTIVE (the user is looking at this one)" : ""));
  const other = st.tabs.filter((tb) => tb.kind === "sftp" || tb.kind === "run" || tb.kind === "log");
  if (other.length) parts.push(`Other tabs: ${other.map((tb) => `${tb.kind} "${tb.title}"`).join(", ")}`);
  if (!st.active) parts.push(`The user is on the "${st.view}" page of the app.`);

  if (act && s.ai?.shareScreen !== false) {
    const h = termHandles.get(act);
    const screen = h?.tail(40);
    if (screen) parts.push(`## Active terminal screen (last lines, ${labelOf(h!.hostId)})\n\`\`\`\n${clip(screen, 4000)}\n\`\`\``);
  }

  if (v.snippets.length) {
    parts.push(`## Snippets (saved commands)`);
    for (const sn of v.snippets) parts.push(`- ${sn.name}: \`${sn.command.replace(/\n/g, "; ")}\`${sn.description ? ` (${sn.description})` : ""}`);
  }
  if (v.workflows.length) {
    parts.push(`## Workflows (multi-host runbooks; the user runs them from the Workflows page)`);
    for (const w of v.workflows) {
      parts.push(`- ${w.name}${w.description ? `: ${w.description}` : ""}; hosts: ${w.hostIds.map((id) => hosts.get(id)?.label ?? id).join(", ") || "chosen at run time"}; steps: ${w.steps.map((x) => `${x.name} \`${x.command.replace(/\n/g, "; ")}\``).join(" → ")}`);
    }
  }
  if (v.workspaces.length) {
    parts.push(`## Saved workspaces (split terminal layouts)\n${v.workspaces.map((w) => `- ${w.name}: ${w.panes.filter(Boolean).map((id) => hosts.get(id!)?.label ?? id).join(", ")}`).join("\n")}`);
  }
  if (v.keys.length) parts.push(`## SSH keys\n${v.keys.map((k) => `- ${k.name} (${k.kind}, ${k.fingerprint})${k.installedOn.length ? `, installed on ${k.installedOn.map((id) => hosts.get(id)?.label ?? id).join(", ")}` : ""}`).join("\n")}`);
  parts.push(`## App settings\nlanguage ${s.language}; theme ${s.appearance}; sudo auto-fill ${s.sudoAutofill ? "on" : "off"}; session logs ${s.sessionLogs ? "on" : "off"}; vault ${v.status.mode}; command approval: ${s.ai?.approval ?? "ask"}.`);
  return parts.join("\n");
}

/* ------------------------------------------------------------------ tools */

const str = { type: "string" } as const;
export const TOOLS: AiTool[] = [
  { name: "run_command", description: "Type a shell command into a terminal session and press Enter, then wait for it to finish and return what appeared on screen. The user sees it typed live. Give session_id (from the open sessions list) or host_id (uses an open terminal on that host, or opens one).",
    parameters: { type: "object", properties: { command: str, session_id: str, host_id: str, timeout_sec: { type: "number", description: "How long to wait for the command to finish (default 30, max 600)." } }, required: ["command"] } },
  { name: "send_keys", description: "Send keystrokes to a terminal without pressing Enter, e.g. to answer a prompt or stop a program. Special keys: <enter> <ctrl-c> <ctrl-d> <ctrl-z> <esc> <tab> <up> <down> <left> <right> <space>. Returns the screen afterwards.",
    parameters: { type: "object", properties: { session_id: str, keys: str }, required: ["session_id", "keys"] } },
  { name: "read_terminal", description: "Read the last lines currently shown in a terminal session (to check on a long-running command).",
    parameters: { type: "object", properties: { session_id: str, lines: { type: "number" } }, required: ["session_id"] } },
  { name: "open_terminal", description: "Open a new terminal tab connected to a host and return its session id and first screen.",
    parameters: { type: "object", properties: { host_id: str }, required: ["host_id"] } },
  { name: "exec_command", description: "Run a non-interactive command on a host in the background (no terminal, 30 s limit) and return stdout, stderr and the exit code.",
    parameters: { type: "object", properties: { host_id: str, command: str }, required: ["host_id", "command"] } },
  { name: "host_overview", description: "Get a quick health summary of a host: OS, kernel, uptime, load, CPU, memory, disk, failed systemd units.",
    parameters: { type: "object", properties: { host_id: str }, required: ["host_id"] } },
  { name: "read_file", description: "Read a text file on a host over SFTP (first 64 KB).",
    parameters: { type: "object", properties: { host_id: str, path: str }, required: ["host_id", "path"] } },
  { name: "recent_sessions", description: "List recent connection history from TermX's logs (host, time, status, errors).",
    parameters: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "save_snippet", description: "Save a command as a TermX snippet so the user can reuse it.",
    parameters: { type: "object", properties: { name: str, command: str, description: str }, required: ["name", "command"] } },
];

const KEYS: Record<string, string> = {
  enter: "\r", "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-z": "\x1a", "ctrl-l": "\x0c", "ctrl-u": "\x15", esc: "\x1b", tab: "\t", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", backspace: "\x7f",
};
const parseKeys = (k: string) => k.replace(/<([a-z-]+)>/gi, (m, name) => KEYS[name.toLowerCase()] ?? m);

/** Approval policy: does this command need the user's OK? */
function needsApproval(kind: Approval["kind"], command: string, host: Host | undefined): boolean {
  const policy = useStore.getState().vault?.settings.ai?.approval ?? "ask";
  if (kind === "snippet") return true;
  if (kind === "keys" && /^(<ctrl-c>|q|<esc>)$/i.test(command.trim())) return false;
  const ro = kind !== "keys" && isReadOnly(command);
  if (useAi.getState().trustChat && !(host?.environment === "production" && !ro)) return false;
  if (policy === "auto") return host?.environment === "production" && !ro;
  if (policy === "safe") return !ro;
  return true;
}

async function ask(a: Approval): Promise<{ ok: boolean; command?: string; note?: string }> {
  useAi.setState({ approval: a });
  const r = await new Promise<{ ok: boolean; command?: string; note?: string }>((res) => { approve = res; });
  approve = null;
  useAi.setState({ approval: null });
  return r;
}

async function waitConnected(sid: string, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stopped) throw new Error("Stopped by the user.");
    const state = useStore.getState().sessions[sid]?.state;
    if (state === "connected" && termHandles.get(sid)) return;
    if (state === "failed" || state === "ended") throw new Error(`The connection ${state}: ${useStore.getState().sessions[sid]?.message ?? ""}`);
    await sleep(200);
  }
  throw new Error("Timed out waiting for the connection.");
}

/** Wait until output has been quiet for `quietMs`. */
async function settle(sid: string, quietMs: number, maxMs: number) {
  const h = termHandles.get(sid);
  if (!h) return;
  let last = Date.now();
  const un = h.onOutput(() => { last = Date.now(); });
  const end = Date.now() + maxMs;
  try { while (Date.now() - last < quietMs && Date.now() < end) await sleep(100); } finally { un(); }
}

async function pickSession(input: Record<string, unknown>): Promise<string> {
  const sid = input.session_id as string | undefined;
  if (sid) {
    if (!termHandles.get(sid)) throw new Error(`No open terminal session ${sid}. Check the session list or use host_id.`);
    return sid;
  }
  const hostId = input.host_id as string | undefined;
  const focus = useAi.getState().focusSid;
  if (!hostId) {
    if (focus && termHandles.get(focus)) return focus;
    throw new Error("No session_id or host_id given and no terminal is active.");
  }
  if (hostId !== LOCAL_HOST && !hostOf(hostId)) throw new Error(`Unknown host_id ${hostId}.`);
  const open = listSessions().filter((x) => x.hostId === hostId && x.state === "connected");
  const pick = open.find((x) => x.sid === focus) ?? open[0];
  if (pick) return pick.sid;
  return openTerminal(hostId);
}

async function openTerminal(hostId: string): Promise<string> {
  const st = useStore.getState();
  let id: string;
  if (hostId === LOCAL_HOST) id = st.openLocal();
  else { st.openTerm(hostId); id = useStore.getState().tabs.filter((t) => t.kind === "term" && t.hostId === hostId).pop()!.id; }
  await waitConnected(id);
  await settle(id, 700, 5000);
  return id;
}

async function runCommand(sid: string, command: string, timeoutSec: number): Promise<string> {
  const h = termHandles.get(sid)!;
  const state = useStore.getState().sessions[sid]?.state;
  if (state !== "connected") throw new Error(`Session is ${state ?? "not connected"}.`);
  reveal(sid);
  // the prompt as it looks before typing, to recognise it again afterwards
  const promptLine = h.tail(1).trimEnd();
  const promptEnd = promptLine.slice(-1);
  const start = h.cursorLine();
  let last = Date.now();
  let lastLive = 0;
  const un = h.onOutput(() => {
    last = Date.now();
    if (last - lastLive > 150) { lastLive = last; useAi.setState({ runningOutput: clip(h.readFrom(start), 3000) }); }
  });
  try {
    // Ctrl-U clears anything half-typed on the line first
    await h.write("\x15" + command.replace(/\r?\n/g, "\r") + "\r");
    const began = Date.now();
    const limit = Math.min(600, Math.max(2, timeoutSec || 30)) * 1000;
    let status = "finished";
    for (;;) {
      await sleep(120);
      if (stopped) { status = "stopped by the user (the command may still be running; send <ctrl-c> to interrupt it)"; break; }
      const idle = Date.now() - last;
      const out = h.readFrom(start);
      const lines = out.split("\n");
      const tail = lines[lines.length - 1] ?? "";
      const echoed = lines.length > 1;
      if (echoed && idle > 350 && (tail.trimEnd() === promptLine || (promptEnd && tail.trimEnd().endsWith(promptEnd) && PROMPT_END.test(tail)) || PROMPT_END.test(tail) && idle > 900)) break;
      if (echoed && idle > 1500 && /(password|passphrase)[^:]*:\s*$|\[y\/n\]\s*$|\(y\/n\)\??\s*$|\[Y\/n\]\s*$|\[y\/N\]\s*$|continue\?\s*$/i.test(tail)) {
        status = "waiting for input at a prompt (answer with send_keys, or <ctrl-c> to cancel)"; break;
      }
      if (Date.now() - began > limit) { status = `still running after ${Math.round(limit / 1000)} s (use read_terminal to check later, or send_keys <ctrl-c> to stop it)`; break; }
    }
    const out = h.readFrom(start).split("\n");
    // drop the echoed command line and the fresh prompt at the end
    const body = out.slice(1, status === "finished" ? -1 : undefined).join("\n");
    return `[${status}]\n${clip(body) || "(no output)"}`;
  } finally {
    un();
  }
}

async function execTool(name: string, input: Record<string, unknown>, toolId: string): Promise<{ content: string; isError: boolean; label?: string }> {
  const ok = (content: string) => ({ content, isError: false });
  switch (name) {
    case "run_command":
    case "send_keys": {
      const sid = await pickSession(input);
      const h = termHandles.get(sid)!;
      const host = hostOf(h.hostId);
      const isKeys = name === "send_keys";
      let command = String(isKeys ? input.keys ?? "" : input.command ?? "").trim();
      if (!command && !isKeys) throw new Error("Empty command.");
      if (needsApproval(isKeys ? "keys" : "command", command, host)) {
        reveal(sid);
        const r = await ask({ toolId, kind: isKeys ? "keys" : "command", command, hostLabel: labelOf(h.hostId), production: host?.environment === "production", risk: isKeys ? null : riskNote(command) });
        if (!r.ok) return { content: `The user declined to run this.${r.note ? ` They said: ${r.note}` : ""}`, isError: true };
        if (r.command && r.command !== command) command = r.command;
      }
      useAi.setState({ running: toolId, runningOutput: "" });
      if (isKeys) {
        reveal(sid);
        await h.write(parseKeys(String(input.keys ?? "")));
        await settle(sid, 500, 4000);
        return ok(`Screen now:\n${clip(h.tail(30), 4000)}`);
      }
      const edited = command !== String(input.command ?? "").trim() ? `(The user edited the command to: ${command})\n` : "";
      return ok(edited + (await runCommand(sid, command, Number(input.timeout_sec) || 30)));
    }
    case "read_terminal": {
      const h = termHandles.get(String(input.session_id));
      if (!h) throw new Error("No such session.");
      return ok(clip(h.tail(Math.min(400, Number(input.lines) || 60)) || "(empty screen)"));
    }
    case "open_terminal": {
      const hid = String(input.host_id);
      if (hid !== LOCAL_HOST && !hostOf(hid)) throw new Error(`Unknown host_id ${input.host_id}.`);
      useAi.setState({ running: toolId });
      const sid = await openTerminal(hid);
      return ok(`session_id: ${sid}\nScreen:\n${clip(termHandles.get(sid)!.tail(30), 4000)}`);
    }
    case "exec_command": {
      const host = hostOf(String(input.host_id));
      if (!host) throw new Error(`Unknown host_id ${input.host_id}.`);
      let command = String(input.command ?? "").trim();
      if (needsApproval("exec", command, host)) {
        const r = await ask({ toolId, kind: "exec", command, hostLabel: host.label, production: host.environment === "production", risk: riskNote(command) });
        if (!r.ok) return { content: `The user declined to run this.${r.note ? ` They said: ${r.note}` : ""}`, isError: true };
        if (r.command) command = r.command;
      }
      useAi.setState({ running: toolId });
      const r = await api.sshExec(host.id, command);
      return ok(`exit code: ${r.exit ?? "unknown"}\nstdout:\n${clip(r.stdout, 10000) || "(empty)"}${r.stderr.trim() ? `\nstderr:\n${clip(r.stderr, 4000)}` : ""}`);
    }
    case "host_overview": {
      useAi.setState({ running: toolId });
      return ok(JSON.stringify(await api.hostOverview(String(input.host_id))));
    }
    case "read_file": {
      useAi.setState({ running: toolId });
      const text = await api.sftpReadText(String(input.host_id), String(input.path));
      return ok(text.length > 65536 ? text.slice(0, 65536) + "\n… [truncated]" : text || "(empty file)");
    }
    case "recent_sessions": {
      const logs = (await api.logsList()).slice(0, Math.min(50, Number(input.limit) || 15));
      return ok(logs.map((l) => line(new Date(l.startedAt).toISOString().slice(0, 16).replace("T", " "), l.hostLabel, `${l.username}@${l.hostname}`, l.status, l.message)).join("\n") || "No sessions recorded.");
    }
    case "save_snippet": {
      const command = String(input.command ?? "");
      const r = await ask({ toolId, kind: "snippet", command, hostLabel: String(input.name ?? ""), production: false, risk: null });
      if (!r.ok) return { content: "The user did not save the snippet.", isError: true };
      await api.snippetSave({ id: crypto.randomUUID(), name: String(input.name ?? "Snippet"), command: r.command || command, description: String(input.description ?? ""), autoRun: false });
      await useStore.getState().load();
      return ok("Saved.");
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}

/* ------------------------------------------------------------------ loop */

const MAX_STEPS = 40;

export async function send(prompt: string) {
  const st = useAi.getState();
  if (st.busy || !prompt.trim()) return;
  const settings = useStore.getState().vault!.settings;
  const { preset, baseUrl, model } = resolveProvider(settings.ai ?? { provider: "anthropic", models: {}, baseUrls: {} });
  stopped = false;
  const history: AiMsg[] = [...st.history, { role: "user", content: [{ type: "text", text: prompt.trim() }] }];
  useAi.setState({ history, busy: true, error: null, stream: "", focusSid: activeSid() });

  const unlisten = await events.on<{ reqId: string; text: string }>("ai:delta", (p) => {
    if (p.reqId === reqId) useAi.setState((s) => ({ stream: s.stream + p.text }));
  });
  try {
    for (let step = 0; step < MAX_STEPS && !stopped; step++) {
      reqId = uid();
      useAi.setState({ stream: "" });
      const resp = await api.aiChat(reqId, preset.id, {
        api: preset.api, baseUrl, model, system: buildSystem(), messages: useAi.getState().history, tools: TOOLS,
      });
      const content = resp.content.length ? resp.content : [{ type: "text", text: "" } as AiPart];
      useAi.setState((s) => ({
        history: [...s.history, { role: "assistant", content }], stream: "",
        usage: { input: s.usage.input + resp.inputTokens, output: s.usage.output + resp.outputTokens },
      }));
      const calls = content.filter((p): p is Extract<AiPart, { type: "tool_use" }> => p.type === "tool_use");
      if (!calls.length) break;
      const results: AiPart[] = [];
      for (const c of calls) {
        if (stopped) { results.push({ type: "tool_result", toolUseId: c.id, content: "Stopped by the user.", isError: true }); continue; }
        try {
          const r = await execTool(c.name, c.input ?? {}, c.id);
          results.push({ type: "tool_result", toolUseId: c.id, content: r.content, isError: r.isError });
        } catch (e) {
          results.push({ type: "tool_result", toolUseId: c.id, content: errText(e), isError: true });
        } finally {
          useAi.setState({ running: null, runningOutput: "" });
        }
      }
      useAi.setState((s) => ({ history: [...s.history, { role: "user", content: results }] }));
    }
  } catch (e) {
    const msg = errText(e);
    if (!/cancelled/i.test(msg)) useAi.setState({ error: msg });
  } finally {
    try { unlisten(); } catch { /* listener already gone */ }
    reqId = null;
    // a stopped turn may end with unanswered tool calls: the next request must not include them dangling
    useAi.setState((s) => {
      const h = [...s.history];
      const lastMsg = h[h.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg.content.some((p) => p.type === "tool_use")) {
        h.push({ role: "user", content: lastMsg.content.filter((p) => p.type === "tool_use").map((p) => ({ type: "tool_result", toolUseId: (p as { id: string }).id, content: "Stopped by the user.", isError: true }) as AiPart) });
      }
      return { busy: false, running: null, approval: null, stream: "", history: h };
    });
  }
}

/** Type text into the active terminal without running it (for "Insert" on code blocks). */
export function insertIntoTerminal(text: string) {
  const sid = activeSid() ?? useAi.getState().focusSid;
  const h = sid ? termHandles.get(sid) : undefined;
  if (!h) return false;
  reveal(sid!);
  h.write(text.replace(/\r?\n$/, "").replace(/\r?\n/g, "\r"));
  h.focus();
  return true;
}
