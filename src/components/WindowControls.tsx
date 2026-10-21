import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/util";

/** Minimize / maximize / close for the custom title bar on Windows and Linux. */
export function WindowControls() {
  const t = useT();
  const [max, setMax] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => { w.isMaximized().then(setMax).catch(() => {}); };
    sync();
    const un = w.onResized(sync);
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);
  const w = () => getCurrentWindow();
  return (
    <div className={"winctl " + (isWindows ? "win" : "gtk")}>
      <button title={t("win.min")} onClick={() => w().minimize().catch(() => {})}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button title={max ? t("win.restore") : t("win.max")} onClick={() => w().toggleMaximize().catch(() => {})}>
        {max
          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="2.5" width="7" height="7" /><path d="M2.5 2.5v-2h7v7h-2" /></svg>
          : <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9" /></svg>}
      </button>
      <button className="close" title={t("common.close")} onClick={() => w().close().catch(() => {})}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.1"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  );
}
