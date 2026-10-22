import { create } from "zustand";
import { api, errText, events, uid, type AiMsg, type AiPart, type AiTool, type Host } from "../api";
import { LOCAL_HOST, termHandles, useStore, type Tab } from "../store";
import { isCatastrophic, isHeavy, isReadOnly, riskNote } from "./safety";
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
  /** Terminal session the assistant is typing into right now. */
  runningSid: string | null;
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
  open: false, history: [], busy: false, stream: "", running: null, runningOutput: "", runningSid: null, approval: null, trustChat: false,
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
  const background = s.ai?.runMode === "background";
  const groups = new Map(v.groups.map((g) => [g.id, g.name]));
  const hosts = hostsById();
  const sessions = listSessions();
  const act = activeSid();
  const parts: string[] = [];

  const lang = s.language === "id" ? "Indonesian (Bahasa Indonesia)" : "English";
  parts.push(`You are TermX AI, a senior Linux / DevOps engineer built into TermX ${st.info?.version ?? ""}, a desktop SSH client (hosts, terminals, SFTP, workspaces, workflows, snippets, live overview, session logs). The user runs it on ${st.info?.os ?? "a desktop"}. Today is ${new Date().toISOString().slice(0, 10)}.

You operate the user's machines by typing commands into their real terminal sessions with the tools below. The user watches every keystroke and can stop you at any time. Your job is to get the task done correctly and safely, with as few steps as needed, and to explain the result clearly.

# How to work
1. Understand the goal. If the request is ambiguous in a way that matters (which host? delete or just list?), ask one short question instead of guessing. Otherwise act.
2. Pick the target. Use the ACTIVE session when it is on the right host. Otherwise use the host the user named (match names, tags, groups and environments from the host list; "the NAS", "prod db", "all staging" are fine) and open_terminal if no session exists. host_id "${LOCAL_HOST}" is the user's own computer (${st.info?.os ?? "their desktop"}); use it for local tasks such as ssh-keygen, ping, dig or curl from the user's network.
3. Investigate first, read-only. One focused command at a time; read the output before deciding the next step. Combine related checks in one command when it keeps things clear (e.g. \`uptime; free -h; df -hT -x tmpfs\`).
4. Adapt to the system. Check the OS from the host list or with \`cat /etc/os-release\` / \`uname -a\` before using distro-specific tools (apt vs dnf vs apk vs pacman, systemd vs OpenRC). NAS and appliances (Synology DSM, QNAP, TrueNAS, Unraid, Proxmox, ESXi, pfSense/OPNsense, routers) often have BusyBox, a different PATH, no systemd, or need sudo -i; check with \`command -v\` before relying on a tool. On Windows hosts use PowerShell.
5. Change things only when asked, and only after explaining in one sentence what the command does and its impact. Back up config files before editing (cp file file.bak.$(date +%F)). Prefer reversible, minimal changes. Never chain a destructive command after other commands.
6. Verify. After a change, check that it worked (service active, config test passes, port answers, disk freed).
7. Report. End with a short summary.

# Commands
- Non-interactive only: --no-pager for systemctl/journalctl/git, -n / --lines / head limits, -b for top, -c for ping, DEBIAN_FRONTEND=noninteractive and -y only when the user approved an install. Never open editors (vim, nano, less) or pagers. Edit files with sed -i, tee or a heredoc, after a backup.
- Keep output small: filter with grep/awk/sort/head, use human-readable flags (-h). Avoid scanning whole filesystems (find / or du / without limits); start from likely places (/var/log, /var/lib/docker, /home, /opt, /srv) with -xdev and --max-depth.
- If a command fails, read the error and fix the cause (missing tool, wrong path, permission). Do not repeat the same failing command. If sudo is needed, use sudo -n first to see whether it needs a password; TermX can fill the saved password in a terminal.
- If something interactive is running (a pager, a prompt, a TUI), use send_keys ("q", "<ctrl-c>") to get back to the shell. If a prompt asks for input you cannot provide (passwords, passphrases, 2FA), stop and tell the user.
${background ? "- Commands run in the background over SSH: they are NOT typed into the user's terminal; the user sees each command and its output only in this chat. Use run_command as usual (one non-interactive command per call, no TTY, so no sudo password prompts and no pagers). Use open_terminal and send_keys only when something really needs an interactive terminal. To read a file, use cat, sed -n or tail (limit the lines)." : "- Everything you do must be visible: run every command with run_command so it is typed into the user's terminal and they can watch it. To read a file, use run_command with cat, sed -n or tail (limit the lines). Use host_overview only for a quick multi-host summary."}

# Safety
- Hosts marked PRODUCTION follow the production rules below. The user approves each command that changes something.
- Never print, ask for or store secrets (passwords, private keys, tokens, .env values). Mask them if they appear in output. TermX never shows you saved passwords.
- Never run commands that download and execute remote scripts, disable security controls, or delete data without an explicit request.

# Production hosts
Hosts whose environment is PRODUCTION serve real users and real data. Mistakes there cost money and trust, so on them:
- Read-only first, always. Gather evidence and explain what you found before proposing any change.
- Before any change, state in one or two lines: what the command does, the expected impact (downtime, users or data affected), and how to roll it back. Then run it so the user can approve it.
- Prefer the gentlest option: reload over restart, graceful over forced, one service or one node at a time. Test configuration before applying it (nginx -t, apachectl configtest, sshd -t, haproxy -c, named-checkconf, docker compose config, visudo -c).
- Back up before editing: cp -a file file.bak.$(date +%Y%m%d-%H%M%S). Before touching a database, ask whether a recent backup or snapshot exists.
- Check that it is a safe moment: active users and connections, running jobs or deploys, replication and cluster state, free disk space for what you are about to do.
- Never run, unless the user asked for that exact action in this chat (and even then show the exact command first): rm -rf or bulk deletes, truncating or deleting logs in use, DROP / DELETE / TRUNCATE / ALTER on databases, kill -9 on processes you have not identified, reboot / shutdown, firewall or SSH changes that could lock the user out, package upgrades or removals, docker system/volume prune, chmod/chown -R, mkfs/dd/partitioning.
- Keep the load light: no unbounded find / du / grep over whole filesystems or huge logs; scope paths, add limits, and use nice -n 19 / ionice -c3 for heavier reads.
- Never work on several production hosts in one go. Do one, verify it is healthy, report, then continue with the next only if the user agrees.
- If anything is unclear or the output is surprising, stop and ask instead of guessing.

# Answers
- Reply in ${lang} unless the user writes in another language; then use theirs.
- Be concise and concrete. Use Markdown: short paragraphs, bullet lists, tables for comparisons or per-host results, and fenced code blocks (\`\`\`bash) for commands the user may want to run.
- Lead with the answer or the finding, then the evidence (the relevant output lines, trimmed), then the recommendation. Quote numbers exactly as the system printed them.
- When you did something, say what changed. When you recommend something you did not run, give the exact command.
- Do not narrate every step while working; one short line before a tool call is enough.`);
  if (s.ai?.approval === "always") parts.push(`# Approval mode: ALWAYS (no confirmations)
The user turned off command approval: every command you send runs immediately, on every host, production included. Nobody reviews it before it runs, so you are the last check. Before each command that changes something, re-read it and make sure it is exactly what the user asked for, scoped to the right host and path, and reversible or backed up. On production, still follow the production rules: read-only first, smallest change, verify after. If a step is risky or the request is unclear, ask in chat instead of running it.`);
  if (s.ai?.instructions?.trim()) parts.push(`# The user's own instructions (follow them unless they conflict with safety)\n${s.ai.instructions.trim()}`);

  parts.push(`## Hosts (${v.hosts.length})\nid | name | user@address:port | group | environment | tags | OS | jump host | auth | notes`);
  for (const h of v.hosts) {
    parts.push(line(h.id, h.label, `${h.username}@${h.hostname}:${h.port}`, h.groupId ? groups.get(h.groupId) : "", h.environment === "production" ? "PRODUCTION" : h.environment || "", h.tags.length ? h.tags.join(",") : "",
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

  const actHost = act ? hostOf(termHandles.get(act)?.hostId ?? "") : undefined;
  if (actHost?.environment === "production") parts.push(`## ⚠ The ACTIVE session is on PRODUCTION host "${actHost.label}". Apply the production rules to every command there.`);
  const prodHosts = v.hosts.filter((h) => h.environment === "production");
  if (prodHosts.length) parts.push(`Production hosts: ${prodHosts.map((h) => h.label).join(", ")}.`);
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
  { name: "host_overview", description: "Get a quick health summary of a host: OS, kernel, uptime, load, CPU, memory, disk, failed systemd units.",
    parameters: { type: "object", properties: { host_id: str }, required: ["host_id"] } },
  { name: "recent_sessions", description: "List recent connection history from TermX's logs (host, time, status, errors).",
    parameters: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "save_snippet", description: "Save a command as a TermX snippet so the user can reuse it.",
    parameters: { type: "object", properties: { name: str, command: str, description: str }, required: ["name", "command"] } },
];

const runMode = (): "terminal" | "background" => (useStore.getState().vault?.settings.ai?.runMode === "background" ? "background" : "terminal");

/** The tool list for the current run mode: in the background mode run_command no longer types into a terminal. */
function activeTools(): AiTool[] {
  if (runMode() !== "background") return TOOLS;
  return TOOLS.map((t) => t.name !== "run_command" ? t : {
    ...t,
    description: "Run one non-interactive shell command on a host over SSH, in the background (it is not typed into the terminal; the user sees the command and its output in the chat). Returns stdout, stderr and the exit code. Give host_id (or session_id to use that session's host). For anything interactive use open_terminal and send_keys.",
  });
}

const KEYS: Record<string, string> = {
  enter: "\r", "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-z": "\x1a", "ctrl-l": "\x0c", "ctrl-u": "\x15", esc: "\x1b", tab: "\t", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", backspace: "\x7f",
};
const parseKeys = (k: string) => k.replace(/<([a-z-]+)>/gi, (m, name) => KEYS[name.toLowerCase()] ?? m);

/** Approval policy: does this command need the user's OK? */
function needsApproval(kind: Approval["kind"], command: string, host: Host | undefined): boolean {
  const policy = useStore.getState().vault?.settings.ai?.approval ?? "ask";
  // "always": the user chose full automation; only commands that could wreck the machine still stop
  if (policy === "always") return kind !== "keys" && kind !== "snippet" && isCatastrophic(command);
  if (kind === "snippet") return true;
  if (kind === "keys" && /^(<ctrl-c>|q|<esc>)$/i.test(command.trim())) return false;
  const ro = kind !== "keys" && isReadOnly(command) && !(host?.environment === "production" && isHeavy(command));
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
  useAi.setState({ runningSid: sid });
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
    useAi.setState({ runningSid: null });
  }
}

/** Reminder on every result from a production host, so caution survives a long conversation. */
const prodNote = (h: Host | undefined) => (h?.environment === "production" ? `[PRODUCTION host "${h.label}": production rules apply. Verify before and after any change.]\n` : "");

/** The SSH host a background command should run on, or null when it has to go through a terminal (local shell). */
function backgroundHost(input: Record<string, unknown>): string | null {
  const sid = input.session_id ? String(input.session_id) : null;
  const hid = (sid ? termHandles.get(sid)?.hostId : null) ?? (input.host_id ? String(input.host_id) : null) ?? (useAi.getState().focusSid ? termHandles.get(useAi.getState().focusSid!)?.hostId : null) ?? null;
  return hid && hid !== LOCAL_HOST && hostOf(hid) ? hid : null;
}

/** Run a command over a hidden SSH exec channel: same approval rules, but nothing is typed into a terminal. */
async function execHidden(hostId: string, input: Record<string, unknown>, toolId: string): Promise<{ content: string; isError: boolean }> {
  const host = hostOf(hostId);
  let command = String(input.command ?? "").trim();
  if (!command) throw new Error("Empty command.");
  if (needsApproval("command", command, host)) {
    const r = await ask({ toolId, kind: "command", command, hostLabel: labelOf(hostId), production: host?.environment === "production", risk: riskNote(command) });
    if (!r.ok) return { content: `The user declined to run this.${r.note ? ` They said: ${r.note}` : ""}`, isError: true };
    if (r.command && r.command !== command) command = r.command;
  }
  useAi.setState({ running: toolId, runningOutput: "" });
  const secs = Math.min(600, Math.max(1, Number(input.timeout_sec) || 30));
  let timer: number | undefined;
  try {
    const out = await Promise.race([
      api.sshExec(hostId, command),
      new Promise<never>((_, rej) => { timer = window.setTimeout(() => rej(new Error(`Timed out after ${secs}s. The command may still be running on the host.`)), secs * 1000); }),
    ]);
    const body = [out.stdout.trimEnd(), out.stderr.trim() && `[stderr]\n${out.stderr.trimEnd()}`].filter(Boolean).join("\n");
    const edited = command !== String(input.command ?? "").trim() ? `(The user edited the command to: ${command})\n` : "";
    return { content: `${prodNote(host)}${edited}$ ${command}\n${clip(body || "(no output)", 6000)}\n[exit ${out.exit ?? "?"}]`, isError: false };
  } finally {
    window.clearTimeout(timer);
  }
}

async function execTool(name: string, input: Record<string, unknown>, toolId: string): Promise<{ content: string; isError: boolean; label?: string }> {
  const ok = (content: string) => ({ content, isError: false });
  switch (name) {
    case "run_command":
    case "send_keys": {
      if (name === "run_command" && runMode() === "background") {
        const hid = backgroundHost(input);
        if (hid) return execHidden(hid, input, toolId);
      }
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
      return ok(prodNote(host) + edited + (await runCommand(sid, command, Number(input.timeout_sec) || 30)));
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
    case "exec_command":
    case "read_file": {
      // older chats may still call these: run them visibly in a terminal like everything else
      const command = name === "read_file" ? `head -c 65536 -- '${String(input.path ?? "").replace(/'/g, "'\\''")}'` : String(input.command ?? "");
      return execTool("run_command", { command, host_id: input.host_id }, toolId);
    }
    case "host_overview": {
      useAi.setState({ running: toolId });
      return ok(JSON.stringify(await api.hostOverview(String(input.host_id))));
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
        api: preset.api, baseUrl, model, system: buildSystem(), messages: useAi.getState().history, tools: activeTools(),
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
