import { create } from "zustand";

interface D {
  confirm: { text: string; danger: boolean; resolve: (b: boolean) => void } | null;
  prompt: { title: string; initial: string; label?: string; resolve: (s: string | null) => void } | null;
}
export const useDialogs = create<D>(() => ({ confirm: null, prompt: null }));

export const confirmDialog = (text: string, danger = true) =>
  new Promise<boolean>((resolve) => useDialogs.setState({ confirm: { text, danger, resolve } }));
export const promptDialog = (title: string, initial = "", label?: string) =>
  new Promise<string | null>((resolve) => useDialogs.setState({ prompt: { title, initial, label, resolve } }));
