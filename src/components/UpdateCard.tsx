import { useEffect } from "react";
import { ArrowUpCircle, ExternalLink, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { DOWNLOAD_PAGE, useUpdater } from "../lib/updater";
import { fmtBytes } from "./LogsView";

/** Checks on start (and every 6 hours) when enabled in Settings. */
export function useUpdateCheck() {
  const enabled = useStore((s) => s.vault?.settings.checkUpdates ?? false);
  useEffect(() => {
    if (!enabled) return;
    const first = window.setTimeout(() => useUpdater.getState().check(false), 4000);
    const iv = window.setInterval(() => useUpdater.getState().check(false), 6 * 3600 * 1000);
    return () => { clearTimeout(first); clearInterval(iv); };
  }, [enabled]);
}

/** Floating card (bottom-right) shown when a new version is available or being installed. */
export function UpdateCard() {
  const t = useT();
  const version = useStore((s) => s.info?.version ?? "");
  const { status, update, done, total, error, dismissed, install, dismiss } = useUpdater();
  const busy = status === "downloading" || status === "installing";
  const show = update && !dismissed && (status === "available" || busy || (status === "error" && !!error));
  if (!show) return null;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const notes = (update.body ?? "").trim().split("\n").filter(Boolean).slice(0, 4).join("\n");
  return (
    <div className="update-card" role="dialog" aria-live="polite">
      <div className="uc-head">
        <ArrowUpCircle size={18} className="uc-ico" />
        <div className="uc-title">
          <b>{t("upd.available", { v: update.version })}</b>
          <small>{t("upd.current", { v: version })}</small>
        </div>
        {!busy && <button className="icon-btn" title={t("upd.later")} onClick={dismiss}><X size={14} /></button>}
      </div>
      {notes && status === "available" && <pre className="uc-notes">{notes}</pre>}
      {busy && (
        <div className="uc-progress">
          <div className="bar"><i style={{ width: status === "installing" ? "100%" : `${pct}%` }} className={total ? "" : "indeterminate"} /></div>
          <small>{status === "installing" ? t("upd.installing") : t("upd.downloading", { p: total ? `${pct}% · ${fmtBytes(done)} / ${fmtBytes(total)}` : fmtBytes(done) })}</small>
        </div>
      )}
      {status === "error" && <div className="uc-err">{t("upd.failed", { e: error })}</div>}
      {!busy && (
        <>
          <small className="uc-note">{t("upd.restartNote")}</small>
          <div className="uc-acts">
            {status === "error"
              ? <button className="btn sm" onClick={() => openUrl(DOWNLOAD_PAGE).catch(() => {})}><ExternalLink size={13} />{t("upd.manual")}</button>
              : <button className="btn sm ghost" onClick={dismiss}>{t("upd.later")}</button>}
            <button className="btn sm primary" onClick={install}><ArrowUpCircle size={13} />{t("upd.now")}</button>
          </div>
        </>
      )}
    </div>
  );
}
