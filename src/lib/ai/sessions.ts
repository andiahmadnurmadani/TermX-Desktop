import { create } from "zustand";
import { api, type AiMsg } from "../api";
import { stop, useAi } from "./agent";
import { summaryOf } from "./context";

/** A saved AI conversation. The live one is mirrored from `useAi` and written to the encrypted vault. */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  history: AiMsg[];
  usage: { input: number; output: number };
}

interface SessionsState {
  sessions: ChatSession[];
  /** The session the panel is showing; null while a new chat has no messages yet. */
  activeId: string | null;
  loaded: boolean;
}

const MAX_SESSIONS = 40;
/** Tool output is the bulk of a saved chat; keep enough to read it back, not all of it. */
const KEEP_OUTPUT = 6000;

export const useSessions = create<SessionsState>(() => ({ sessions: [], activeId: null, loaded: false }));

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** First thing the user asked, as a one-line title. */
export function titleOf(history: AiMsg[]): string {
  for (const m of history) {
    if (m.role !== "user") continue;
    const text = m.content.filter((p) => p.type === "text" && p.text !== summaryOf(m)).map((p) => (p as { text: string }).text).join(" ").replace(/\s+/g, " ").trim();
    if (text) return text.length > 56 ? text.slice(0, 55).trimEnd() + "…" : text;
  }
  return "";
}

function slim(h: AiMsg[]): AiMsg[] {
  return h.map((m) => ({
    ...m,
    content: m.content.map((p) => (p.type === "tool_result" && p.content.length > KEEP_OUTPUT ? { ...p, content: p.content.slice(0, KEEP_OUTPUT) + "\n… (output cut when the chat was saved)" } : p)),
  }));
}

let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const list = useSessions.getState().sessions;
    const data = list.length ? JSON.stringify(list.map((s) => ({ ...s, history: slim(s.history) }))) : "";
    api.aiSessionsSave(data).catch(() => {});
  }, 700);
}

/** Mirror the live conversation into its session (creating it on the first message). */
function sync() {
  const { history, usage } = useAi.getState();
  if (!history.length) return;
  const st = useSessions.getState();
  const cur = st.sessions.find((s) => s.id === st.activeId);
  if (cur && cur.history === history) return;
  const now = Date.now();
  if (!cur) {
    const s: ChatSession = { id: uid(), title: titleOf(history) || "…", createdAt: now, updatedAt: now, history, usage };
    useSessions.setState({ activeId: s.id, sessions: [s, ...st.sessions].slice(0, MAX_SESSIONS) });
  } else {
    useSessions.setState({
      sessions: st.sessions.map((s) => (s.id === cur.id ? { ...s, history, usage, updatedAt: now, title: s.title === "…" ? titleOf(history) || "…" : s.title } : s)),
    });
  }
  persist();
}

let started = false;

/** Load the saved chats once, reopen the newest, and keep saving as the conversation changes. */
export async function initSessions() {
  if (started) return;
  started = true;
  let list: ChatSession[] = [];
  try {
    const raw = await api.aiSessionsLoad();
    if (raw) list = (JSON.parse(raw) as ChatSession[]).filter((s) => s && Array.isArray(s.history) && s.history.length);
  } catch { /* nothing saved, or unreadable: start empty */ }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  useSessions.setState({ sessions: list, loaded: true });
  // the newest chat comes back as it was, unless the user already started something while this loaded
  if (list.length && !useAi.getState().history.length) {
    useSessions.setState({ activeId: list[0].id });
    useAi.setState({ history: list[0].history, usage: list[0].usage ?? { input: 0, output: 0 } });
  }
  useAi.subscribe((s, prev) => { if (s.history !== prev.history) sync(); });
  sync();
}

/** Stop a turn in progress and wait for it to wind down, so its last messages cannot land in another chat. */
async function settle() {
  if (!useAi.getState().busy) return;
  stop();
  for (let i = 0; i < 60 && useAi.getState().busy; i++) await new Promise((r) => setTimeout(r, 50));
}

/** Start an empty chat. The current one stays in the list. */
export async function newSession() {
  await settle();
  useSessions.setState({ activeId: null });
  useAi.getState().reset();
}

export async function switchTo(id: string) {
  await settle();
  const s = useSessions.getState().sessions.find((x) => x.id === id);
  if (!s) return;
  useAi.getState().reset();
  useSessions.setState({ activeId: id });
  useAi.setState({ history: s.history, usage: s.usage ?? { input: 0, output: 0 } });
}

export function renameSession(id: string, title: string) {
  const t = title.trim();
  if (!t) return;
  useSessions.setState((st) => ({ sessions: st.sessions.map((s) => (s.id === id ? { ...s, title: t.slice(0, 80) } : s)) }));
  persist();
}

export async function removeSession(id: string) {
  if (useSessions.getState().activeId === id) await newSession();
  useSessions.setState((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
  persist();
}

export async function clearSessions() {
  await newSession();
  useSessions.setState({ sessions: [] });
  persist();
}
