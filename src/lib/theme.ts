import { useEffect, useState } from "react";
import { useStore } from "./store";
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
