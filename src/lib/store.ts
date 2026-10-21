import { create } from "zustand";
import { api, errText, uid, type AppInfo, type Layout, type SessionLog, type SessionState, type Settings, type Vault, type Workspace } from "./api";

export type View = "hosts" | "workspaces" | "workflows" | "overview" | "logs" | "keys" | "snippets" | "settings";

/** A terminal pane inside a grid tab. `sid` is the SSH session id. */
export interface PaneRef { sid: string; hostId: string }
export interface Grid {
  name: string; workspaceId: string | null; layout: Layout; colSplit: number; rowSplit: number;
  /** Always four slots. */
  panes: (PaneRef | null)[];
  focus: number; max: number | null;
}
export interface Tab {
  id: string; kind: "term" | "sftp" | "grid" | "run" | "log"; title: string;
  /** term/sftp */
  hostId: string;
  grid?: Grid;
  /** run tabs: workflow run id */
  runId?: string;
  /** log tabs: the recorded session */
  log?: SessionLog;
}
export interface SessionInfo { state: SessionState; message?: string }
export interface Toast { id: string; text: string; kind: "info" | "error" | "ok" }

interface S {
  vault: Vault | null;
  info: AppInfo | null;
  view: View;
  tabs: Tab[];
  active: string | null;
  /** live state of every SSH shell, by session id (term tab id or pane sid) */
  sessions: Record<string, SessionInfo>;
  toasts: Toast[];
  hostDialog: { hostId: string | null } | null;
  palette: boolean;
  load: () => Promise<void>;
  setView: (v: View) => void;
  setActive: (id: string | null) => void;
  openTerm: (hostId: string) => void;
  openSftp: (hostId: string) => void;
  openGrid: (opts?: Partial<Workspace>) => void;
  openHostInGrid: (hostId: string) => void;
  patchGrid: (tabId: string, p: Partial<Grid>) => void;
  setPaneHost: (tabId: string, idx: number, hostId: string | null) => void;
  saveGrid: (tabId: string, name: string) => Promise<void>;
  openRun: (runId: string, title: string) => void;
  openLog: (log: SessionLog) => void;
  closeTab: (id: string) => void;
  patchSession: (sid: string, p: SessionInfo) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: string) => void;
  openHostDialog: (hostId: string | null) => void;
  closeHostDialog: () => void;
  setPalette: (b: boolean) => void;
  saveSettings: (p: Partial<Settings>) => Promise<void>;
  run: <T>(p: Promise<T>, okMsg?: string) => Promise<T | undefined>;
}

const visibleSlots = (layout: Layout) => (layout === "1" ? 1 : layout === "4" ? 4 : 2);

export const useStore = create<S>((set, get) => ({
  vault: null,
  info: null,
  view: "hosts",
  tabs: [],
  active: null,
  sessions: {},
  toasts: [],
  hostDialog: null,
  palette: false,

  load: async () => {
    const [vault, info] = await Promise.all([api.vault(), get().info ? Promise.resolve(get().info!) : api.appInfo()]);
    set({ vault, info });
  },
  setView: (view) => set({ view, active: null }),
  setActive: (active) => set({ active }),

  openTerm: (hostId) => {
    const host = get().vault?.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const n = get().tabs.filter((t) => t.hostId === hostId && t.kind === "term").length;
    const tab: Tab = { id: uid(), kind: "term", hostId, title: n ? `${host.label} (${n + 1})` : host.label };
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id, sessions: { ...s.sessions, [tab.id]: { state: "connecting" } } }));
    // refresh "last connected" shortly after the connection is made
    setTimeout(() => get().load().catch(() => {}), 2500);
  },
  openSftp: (hostId) => {
    const host = get().vault?.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const existing = get().tabs.find((t) => t.kind === "sftp" && t.hostId === hostId);
    if (existing) return set({ active: existing.id });
    const tab: Tab = { id: uid(), kind: "sftp", hostId, title: `${host.label} · SFTP` };
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id }));
  },

  openGrid: (opts) => {
    const hosts = get().vault?.hosts ?? [];
    const panes: (PaneRef | null)[] = [0, 1, 2, 3].map((i) => {
      const h = opts?.panes?.[i];
      return h && hosts.some((x) => x.id === h) ? { sid: uid(), hostId: h } : null;
    });
    const n = get().tabs.filter((t) => t.kind === "grid").length;
    const grid: Grid = {
      name: opts?.name || (n ? `Workspace ${n + 1}` : "Workspace"),
      workspaceId: opts?.id ?? null,
      layout: opts?.layout ?? "4",
      colSplit: opts?.colSplit ?? 0.5,
      rowSplit: opts?.rowSplit ?? 0.5,
      panes, focus: 0, max: null,
    };
    const sessions = { ...get().sessions };
    for (const p of panes) if (p) sessions[p.sid] = { state: "connecting" };
    const tab: Tab = { id: uid(), kind: "grid", hostId: "", title: grid.name, grid };
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id, sessions }));
    if (panes.some(Boolean)) setTimeout(() => get().load().catch(() => {}), 2500);
  },
  openHostInGrid: (hostId) => {
    const st = get();
    const cur = st.tabs.find((t) => t.id === st.active && t.kind === "grid") ?? [...st.tabs].reverse().find((t) => t.kind === "grid");
    const free = cur?.grid ? cur.grid.panes.findIndex((p, i) => !p && i < visibleSlots(cur.grid!.layout)) : -1;
    if (cur && free >= 0) { st.setPaneHost(cur.id, free, hostId); set({ active: cur.id }); return; }
    st.openGrid({ panes: [hostId, null, null, null] });
  },
  patchGrid: (tabId, p) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.grid ? { ...t, grid: { ...t.grid, ...p }, title: p.name ?? t.title } : t)) })),
  setPaneHost: (tabId, idx, hostId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.grid) return;
    const panes = [...tab.grid.panes];
    const sessions = { ...get().sessions };
    const old = panes[idx];
    if (old) delete sessions[old.sid];
    panes[idx] = hostId ? { sid: uid(), hostId } : null;
    if (panes[idx]) sessions[panes[idx]!.sid] = { state: "connecting" };
    let max = tab.grid.max;
    if (!hostId && max === idx) max = null;
    set((s) => ({ sessions, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, grid: { ...t.grid!, panes, focus: idx, max } } : t)) }));
  },
  saveGrid: async (tabId, name) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.grid) return;
    const g = tab.grid;
    const ws: Workspace = {
      id: g.workspaceId ?? crypto.randomUUID(), name, layout: g.layout, colSplit: g.colSplit, rowSplit: g.rowSplit,
      panes: g.panes.map((p) => p?.hostId ?? null), createdAt: Date.now(),
    };
    try {
      await api.workspaceSave(ws);
      await get().load();
      get().patchGrid(tabId, { workspaceId: ws.id, name });
      get().toast(name, "ok");
    } catch (e) {
      get().toast(errText(e), "error");
    }
  },
  openRun: (runId, title) => {
    const existing = get().tabs.find((t) => t.kind === "run" && t.runId === runId);
    if (existing) return set({ active: existing.id });
    const tab: Tab = { id: uid(), kind: "run", hostId: "", title, runId };
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id }));
  },

  openLog: (log) => {
    const existing = get().tabs.find((t) => t.kind === "log" && t.log?.id === log.id);
    if (existing) return set({ active: existing.id });
    const time = new Date(log.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const tab: Tab = { id: uid(), kind: "log", hostId: log.hostId, title: `${log.hostLabel} · ${time}`, log };
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id }));
  },

  closeTab: (id) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      if (i < 0) return s;
      const closing = s.tabs[i];
      const tabs = s.tabs.filter((t) => t.id !== id);
      let active = s.active;
      if (active === id) active = tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null;
      const sessions = { ...s.sessions };
      delete sessions[id];
      for (const p of closing.grid?.panes ?? []) if (p) delete sessions[p.sid];
      return { tabs, active, sessions };
    }),
  patchSession: (sid, p) => set((s) => ({ sessions: { ...s.sessions, [sid]: p } })),

  toast: (text, kind = "info") => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openHostDialog: (hostId) => set({ hostDialog: { hostId } }),
  closeHostDialog: () => set({ hostDialog: null }),
  setPalette: (palette) => set({ palette }),

  saveSettings: async (p) => {
    const cur = get().vault?.settings;
    if (!cur) return;
    const next = { ...cur, ...p };
    set((s) => ({ vault: s.vault ? { ...s.vault, settings: next } : s.vault }));
    try {
      await api.settingsSave(next);
    } catch (e) {
      get().toast(errText(e), "error");
    }
  },

  /** Run a backend call, reload the vault afterwards, surface errors as toasts. */
  run: async (p, okMsg) => {
    try {
      const r = await p;
      await get().load();
      if (okMsg) get().toast(okMsg, "ok");
      return r;
    } catch (e) {
      get().toast(errText(e), "error");
      return undefined;
    }
  },
}));

/** Aggregate state for a tab's status dot. */
export function tabState(tab: Tab, sessions: Record<string, SessionInfo>): SessionState | "idle" {
  if (tab.kind === "term") return sessions[tab.id]?.state ?? "connecting";
  if (tab.kind === "grid") {
    const st = (tab.grid?.panes ?? []).filter(Boolean).map((p) => sessions[p!.sid]?.state ?? "connecting");
    if (!st.length) return "idle";
    for (const k of ["failed", "reconnecting", "connecting", "ended"] as const) if (st.includes(k)) return k;
    return "connected";
  }
  return "idle";
}

/** Handles registered by mounted terminals so other UI (snippets, palette) can talk to them. */
export const termHandles = new Map<string, { write: (text: string) => void; focus: () => void }>();
