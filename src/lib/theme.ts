import { useEffect, useState } from "react";
import { useStore } from "./store";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hexLuma } from "./util";

export function useResolvedDark(): boolean {
  const appearance = useStore((s) => s.vault?.settings.appearance ?? "system");
  const [sys, setSys] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => setSys(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return appearance === "system" ? sys : appearance === "dark";
}

/** Applies appearance + accent to <html>. */
export function useApplyTheme() {
  const dark = useResolvedDark();
  const accent = useStore((s) => s.vault?.settings.accent ?? "#3ddc97");
  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = dark ? "dark" : "light";
    r.style.setProperty("--accent", accent);
    r.style.setProperty("--accent-fg", hexLuma(accent) > 0.6 ? "#0a1410" : "#ffffff");
    r.style.setProperty("--c1", accent);
  }, [dark, accent]);
}

const UI_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Ubuntu, Cantarell, sans-serif`;
export const uiFontStack = (f: string) =>
  f === "system" ? UI_STACK : f === "inter" || !f.trim() ? `"Inter Variable", ${UI_STACK}` : `"${f.replace(/"/g, "")}", "Inter Variable", ${UI_STACK}`;

/** Interface font + zoom. Zoom goes through the webview so terminals stay pixel-exact. */
export function useApplyUi() {
  const font = useStore((s) => s.vault?.settings.uiFont ?? "inter");
  const scale = useStore((s) => s.vault?.settings.uiScale ?? 100);
  useEffect(() => { document.documentElement.style.setProperty("--font-ui", uiFontStack(font)); }, [font]);
  useEffect(() => {
    const z = Math.min(150, Math.max(75, scale || 100)) / 100;
    getCurrentWebview().setZoom(z).catch(() => {});
  }, [scale]);
}

/** True while the window is in (macOS) full screen: the traffic lights are gone, so is their padding. */
export function useFullscreen(): boolean {
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    let un: (() => void) | undefined;
    const check = () => w.isFullscreen().then(setFs).catch(() => {});
    check();
    w.onResized(check).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, []);
  return fs;
}
