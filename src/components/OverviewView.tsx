import { useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { create } from "zustand";
import { api, errText, type Overview } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { EmptyState } from "./ui";
import { EnvBadge } from "./HostsView";

interface Row { loading: boolean; data?: Overview; error?: string; at?: number }
/** Kept outside the component so results survive switching views. */
const useOverview = create<{ rows: Record<string, Row>; set: (id: string, r: Row) => void }>((set) => ({
  rows: {},
  set: (id, r) => set((s) => ({ rows: { ...s.rows, [id]: r } })),
}));

const fmtKb = (kb: number) => {
  const gb = kb / 1024 / 1024;
  return gb >= 1 ? `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB` : `${(kb / 1024).toFixed(0)} MB`;
};
const fmtUp = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

function Meter({ used, total }: { used: number; total: number }) {
  const p = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <div className="meter" title={`${fmtKb(used)} / ${fmtKb(total)}`}>
      <div className="bar"><i style={{ width: `${p * 100}%` }} className={p > 0.9 ? "hot" : p > 0.75 ? "warm" : ""} /></div>
      <span>{Math.round(p * 100)}%</span>
    </div>
  );
}

export function OverviewView() {
  const t = useT();
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const { rows, set } = useOverview();
  const [busy, setBusy] = useState(false);
  const [envFilter, setEnvFilter] = useState<string>("all");
  const list = useMemo(() => hosts.filter((h) => envFilter === "all" || h.environment === envFilter), [hosts, envFilter]);

  const refresh = async (id: string) => {
    set(id, { ...useOverview.getState().rows[id], loading: true });
    try { set(id, { loading: false, data: await api.hostOverview(id), at: Date.now() }); }
    catch (e) { set(id, { loading: false, error: errText(e), at: Date.now() }); }
  };
  const refreshAll = async () => {
    setBusy(true);
    const queue = list.map((h) => h.id);
    const worker = async () => { for (let id = queue.shift(); id; id = queue.shift()) await refresh(id); };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setBusy(false);
  };

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <h1>{t("ov.title")}</h1>
        <div className="chips">
          {["all", "production", "staging", "development"].map((e) => (
            <button key={e} className={"chip" + (envFilter === e ? " on" : "")} onClick={() => setEnvFilter(e)}>{e === "all" ? t("hosts.all") : t(("env." + e) as never)}</button>
          ))}
        </div>
        <div className="sp" />
        <button className="btn primary" disabled={busy || !list.length} onClick={refreshAll}><RefreshCw size={14} className={busy ? "spin" : ""} />{t("ov.refreshAll")}</button>
      </div>
      <p className="lede">{t("ov.lede")}</p>
      {hosts.length === 0 ? (
        <EmptyState icon={<Activity size={26} />} title={t("hosts.empty.title")} body={t("hosts.empty.body")} />
      ) : (
        <div className="panel ov-table">
          <div className="ov-row ov-headrow">
            <span>{t("wf.host")}</span><span>{t("ov.uptime")}</span><span>{t("ov.load")}</span><span>{t("ov.memory")}</span><span>{t("ov.disk")}</span><span>{t("ov.services")}</span><span />
          </div>
          {list.map((h) => {
            const r = rows[h.id];
            const d = r?.data;
            return (
              <div key={h.id} className="ov-row">
                <span className="ov-host"><b>{h.label}</b><EnvBadge env={h.environment} /><small>{d?.os ? `${d.os} ${d.kernel ?? ""}` : `${h.username}@${h.hostname}`}</small></span>
                {r?.error ? <span className="ov-err" title={r.error}>{r.error}</span> : !d ? <span className="muted ov-span">{r?.loading ? t("ov.loading") : t("ov.notLoaded")}</span> : (
                  <>
                    <span>{d.uptimeSec != null ? fmtUp(d.uptimeSec) : "—"}</span>
                    <span className="mono">{d.load ? d.load.map((x) => x.toFixed(2)).join(" ") : "—"}{d.cpus ? <small> / {d.cpus} cpu</small> : null}</span>
                    <span>{d.memTotalKb && d.memAvailKb != null ? <Meter used={d.memTotalKb - d.memAvailKb} total={d.memTotalKb} /> : "—"}</span>
                    <span>{d.diskTotalKb && d.diskUsedKb != null ? <Meter used={d.diskUsedKb} total={d.diskTotalKb} /> : "—"}</span>
                    <span>{d.failedUnits == null ? <span className="muted">n/a</span> : d.failedUnits === 0 ? <span className="ok-text">{t("ov.allOk")}</span> : <span className="bad-text">{t("ov.failed", { n: d.failedUnits })}</span>}</span>
                  </>
                )}
                <span className="ov-act"><button className="icon-btn" title={t("common.refresh")} disabled={r?.loading} onClick={() => refresh(h.id)}>{r?.loading ? <span className="mini-spin" /> : <RefreshCw size={14} />}</button></span>
              </div>
            );
          })}
        </div>
      )}
    </div></div>
  );
}
