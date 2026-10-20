import { create } from "zustand";
import { api, errText, uid, type AppInfo, type SessionState, type Settings, type Vault } from "./api";

export type View = "hosts" | "keys" | "snippets" | "settings";
export interface Tab { id: string; kind: "term" | "sftp"; hostId: string; title: string; state: SessionState; message?: string }
export interface Toast { id: string; text: string; kind: "info" | "error" | "ok" }

interface S {
  vault: Vault | null;
  info: AppInfo | null;
  view: View;
  tabs: Tab[];
  active: string | null;
  toasts: Toast[];
  hostDialog: { hostId: string | null } | null;
  palette: boolean;
  load: () => Promise<void>;
  setView: (v: View) => void;
  setActive: (id: string | null) => void;
  openTerm: (hostId: string) => void;
  openSftp: (hostId: string) => void;
  closeTab: (id: string) => void;
  patchTab: (id: string, p: Partial<Tab>) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: string) => void;
  openHostDialog: (hostId: string | null) => void;
  closeHostDialog: () => void;
  setPalette: (b: boolean) => void;
  saveSettings: (p: Partial<Settings>) => Promise<void>;
  run: <T>(p: Promise<T>, okMsg?: string) => Promise<T | undefined>;
}

export const useStore = create<S>((set, get) => ({
  vault: null,
  info: null,
  view: "hosts",
  tabs: [],
  active: null,
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
    const tab: Tab = { id: uid(), kind: "term", hostId, title: n ? `${host.label} (${n + 1})` : host.label, state: "connecting" };
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id }));
    // refresh "last connected" shortly after the connection is made
    setTimeout(() => get().load().catch(() => {}), 2500);
  },
  openSftp: (hostId) => {
    const host = get().vault?.hosts.find((h) => h.id === hostId);
    if (!host) return;
    const existing = get().tabs.find((t) => t.kind === "sftp" && t.hostId === hostId);
    if (existing) return set({ active: existing.id });
    const tab: Tab = { id: uid(), kind: "sftp", hostId, title: `${host.label} · SFTP`, state: "connected" };
    set((s) => ({ tabs: [...s.tabs, tab], active: tab.id }));
  },
  closeTab: (id) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      if (i < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let active = s.active;
      if (active === id) active = tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null;
      return { tabs, active };
    }),
  patchTab: (id, p) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) })),

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

/** Handles registered by mounted terminals so other UI (snippets, palette) can talk to them. */
export const termHandles = new Map<string, { write: (text: string) => void; focus: () => void }>();
