import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errText } from "./api";

export const DOWNLOAD_PAGE = "https://termx.kroombox.com/#download";

type Status = "idle" | "checking" | "none" | "available" | "downloading" | "installing" | "error";
interface U {
  status: Status;
  update: Update | null;
  done: number;
  total: number;
  error: string;
  /** the floating card was closed; the sidebar badge stays */
  dismissed: boolean;
  check: (manual?: boolean) => Promise<Status>;
  install: () => Promise<void>;
  dismiss: () => void;
  open: () => void;
}

export const useUpdater = create<U>((set, get) => ({
  status: "idle", update: null, done: 0, total: 0, error: "", dismissed: false,

  check: async (manual = false) => {
    const st = get().status;
    if (st === "checking" || st === "downloading" || st === "installing") return st;
    set({ status: "checking", error: "" });
    try {
      const u = await check({ timeout: 20000 });
      if (u) {
        set({ status: "available", update: u, dismissed: false });
        return "available";
      }
      set({ status: "none" });
      return "none";
    } catch (e) {
      // offline / no release yet: stay quiet unless the user asked
      set({ status: manual ? "error" : "idle", error: errText(e) });
      return manual ? "error" : "idle";
    }
  },

  install: async () => {
    const u = get().update;
    if (!u) return;
    set({ status: "downloading", done: 0, total: 0, error: "", dismissed: false });
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") set({ total: ev.data.contentLength ?? 0, done: 0 });
        else if (ev.event === "Progress") set((s) => ({ done: s.done + ev.data.chunkLength }));
        else if (ev.event === "Finished") set({ status: "installing" });
      });
      set({ status: "installing" });
      await relaunch();
    } catch (e) {
      set({ status: "error", error: errText(e) });
    }
  },
  dismiss: () => set({ dismissed: true }),
  open: () => set({ dismissed: false }),
}));
