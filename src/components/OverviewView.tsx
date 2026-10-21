import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Pause, Play, RefreshCw } from "lucide-react";
import { create } from "zustand";
import { api, errText, type Overview } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { OsIcon } from "../lib/os";
import { EmptyState, Seg } from "./ui";
import { EnvBadge } from "./HostsView";

interface Row { loading: boolean; data?: Overview; error?: string; at?: number; cpu: number[]; mem: number[] }
const HISTORY = 40;
const EMPTY: Row = { loading: false, cpu: [], mem: [] };
/** Kept outside the component so results (and sparkline history) survive switching views. */
const useOverview = create<{ rows: Record<string, Row>; patch: (id: string, r: Partial<Row>) => void }>((set) => ({
  rows: {},
  patch: (id, r) => set((s) => ({ rows: { ...s.rows, [id]: { ...EMPTY, ...s.rows[id], ...r } } })),
}));

const fmtKb = (kb: number) => {
  const gb = kb / 1024 / 1024;
  return gb >= 1 ? `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB` : `${(kb / 1024).toFixed(0)} MB`;
};
const fmtUp = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const memPct = (d: Overview) => (d.memTotalKb && d.memAvailKb != null ? (100 * (d.memTotalKb - d.memAvailKb)) / d.memTotalKb : null);

function Meter({ p, title }: { p: number; title?: string }) {
  const v = Math.max(0, Math.min(100, p));
  return (
    <div className="meter" title={title}>
      <div className="bar"><i style={{ width: `${v}%` }} className={v > 90 ? "hot" : v > 75 ? "warm" : ""} /></div>
      <span>{Math.round(v)}%</span>
    </div>
  );
}

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const w = 64, h = 18;
  const pts = data.map((v, i) => `${((i / (HISTORY - 1)) * w).toFixed(1)},${(h - (Math.max(0, Math.min(100, v)) / 100) * (h - 2) - 1).toFixed(1)}`);
  const off = ((HISTORY - data.length) / (HISTORY - 1)) * w;
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <g transform={`translate(${off.toFixed(1)} 0)`}>
        <polyline points={`0,${h} ${pts.join(" ")} ${pts[pts.length - 1].split(",")[0]},${h}`} className="fill" />
        <polyline points={pts.join(" ")} className="line" />
      </g>
    </svg>
  );
}

const ago = (t: number | undefined, now: number) => {
  if (!t) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};

export function OverviewView() {
  const t = useT();
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const settings = useStore((s) => s.vault!.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const { rows, patch } = useOverview();
  const [busy, setBusy] = useState(false);
  const [envFilter, setEnvFilter] = useState<string>("all");
  const [now, setNow] = useState(Date.now());
  const list = useMemo(() => hosts.filter((h) => envFilter === "all" || h.environment === envFilter), [hosts, envFilter]);
  const live = settings.overviewLive;
  const interval = Math.max(3, settings.overviewInterval || 10);

  const inflight = useRef(new Set<string>());
  const refresh = useCallback(async (id: string) => {
    if (inflight.current.has(id)) return;
    inflight.current.add(id);
    patch(id, { loading: true });
    try {
      const data = await api.hostOverview(id);
      const prev = useOverview.getState().rows[id];
      const cpu = data.cpuPct != null ? [...(prev?.cpu ?? []), data.cpuPct].slice(-HISTORY) : prev?.cpu ?? [];
      const m = memPct(data);
      const mem = m != null ? [...(prev?.mem ?? []), m].slice(-HISTORY) : prev?.mem ?? [];
      patch(id, { loading: false, data, error: undefined, at: Date.now(), cpu, mem });
    } catch (e) {
      patch(id, { loading: false, error: errText(e), at: Date.now() });
    } finally {
      inflight.current.delete(id);
    }
  }, [patch]);

  const refreshMany = useCallback(async (ids: string[]) => {
    const queue = [...ids];
    const worker = async () => { for (let id = queue.shift(); id; id = queue.shift()) await refresh(id); };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }, [refresh]);

  const refreshAll = async () => { setBusy(true); await refreshMany(list.map((h) => h.id)); setBusy(false); };

  // Live: poll on an interval while this page is open and the window is visible. Hosts that failed
  // are left alone (no repeated password prompts / timeouts) until refreshed by hand.
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      if (stop || document.visibilityState === "hidden") return;
      const st = useOverview.getState().rows;
      await refreshMany(listRef.current.filter((h) => !st[h.id]?.error).map((h) => h.id));
    };
    tick();
    const iv = window.setInterval(tick, interval * 1000);
    return () => { stop = true; clearInterval(iv); };
  }, [live, interval, refreshMany]);

  // "updated Xs ago" labels
  useEffect(() => { const iv = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(iv); }, []);

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <div className="title"><h1>{t("ov.title")}</h1>{live && <span className="live-dot">{t("ov.live")}</span>}</div>
        <div className="sp" />
        <div className="acts">
          <button className={"btn" + (live ? " on-live" : "")} onClick={() => saveSettings({ overviewLive: !live })} title={t("ov.liveHint")}>
            {live ? <Pause size={14} /> : <Play size={14} />}{live ? t("ov.pause") : t("ov.goLive")}
          </button>
          {live && (
            <Seg value={String(interval)} onChange={(v) => saveSettings({ overviewInterval: Number(v) })}
              options={[{ v: "5", label: "5s" }, { v: "10", label: "10s" }, { v: "30", label: "30s" }, { v: "60", label: "1m" }]} />
          )}
          <button className="btn primary" disabled={busy || !list.length} onClick={refreshAll}><RefreshCw size={14} className={busy ? "spin" : ""} /><span className="lbl">{t("ov.refreshAll")}</span></button>
        </div>
      </div>
      <div className="toolbar">
        <div className="chips">
          {["all", "production", "staging", "development"].map((e) => (
            <button key={e} className={"chip" + (envFilter === e ? " on" : "")} onClick={() => setEnvFilter(e)}>{e === "all" ? t("hosts.all") : t(("env." + e) as never)}</button>
          ))}
        </div>
        <div className="sp" />
        <span className="muted small">{live ? t("ov.liveNote", { n: interval }) : t("ov.lede")}</span>
      </div>
      {hosts.length === 0 ? (
        <EmptyState icon={<Activity size={26} />} title={t("hosts.empty.title")} body={t("hosts.empty.body")} />
      ) : (
        <div className="panel ov-table">
          <div className="ov-row ov-headrow">
            <span>{t("wf.host")}</span><span>{t("ov.uptime")}</span><span>CPU</span><span>{t("ov.load")}</span><span>{t("ov.memory")}</span><span>{t("ov.disk")}</span><span>{t("ov.services")}</span><span />
          </div>
          {list.map((h) => {
            const r = rows[h.id];
            const d = r?.data;
            const m = d ? memPct(d) : null;
            return (
              <div key={h.id} className={"ov-row" + (r?.loading && d ? " busy" : "")}>
                <span className="ov-host">
                  <OsIcon host={{ osId: h.osId, osName: d?.os ?? h.osName }} size={30} />
                  <span className="ov-hmeta">
                    <span className="ov-hname"><b>{h.label}</b><EnvBadge env={h.environment} /></span>
                    <small>{d?.os ? `${d.os} · ${d.kernel ?? ""}` : `${h.username}@${h.hostname}`}</small>
                  </span>
                </span>
                {r?.error ? <span className="ov-err" title={r.error}>{r.error}</span> : !d ? <span className="muted ov-span">{r?.loading ? t("ov.loading") : t("ov.notLoaded")}</span> : (
                  <>
                    <span className="num">{d.uptimeSec != null ? fmtUp(d.uptimeSec) : "—"}</span>
                    <span className="ov-cpu">{d.cpuPct != null ? <><Meter p={d.cpuPct} /><Spark data={r.cpu} /></> : "—"}</span>
                    <span className="mono num">{d.load ? d.load.map((x) => x.toFixed(2)).join(" ") : "—"}{d.cpus ? <small> / {d.cpus} cpu</small> : null}</span>
                    <span>{m != null ? <Meter p={m} title={`${fmtKb(d.memTotalKb! - d.memAvailKb!)} / ${fmtKb(d.memTotalKb!)}`} /> : "—"}</span>
                    <span>{d.diskTotalKb && d.diskUsedKb != null ? <Meter p={(100 * d.diskUsedKb) / d.diskTotalKb} title={`${fmtKb(d.diskUsedKb)} / ${fmtKb(d.diskTotalKb)}`} /> : "—"}</span>
                    <span>{d.failedUnits == null ? <span className="muted">n/a</span> : d.failedUnits === 0 ? <span className="ok-text">{t("ov.allOk")}</span> : <span className="bad-text">{t("ov.failed", { n: d.failedUnits })}</span>}</span>
                  </>
                )}
                <span className="ov-act">
                  {r?.at && !r.loading ? <small className="ago" title={new Date(r.at).toLocaleTimeString()}>{ago(r.at, now)}</small> : null}
                  <button className="icon-btn" title={t("common.refresh")} disabled={r?.loading} onClick={() => refresh(h.id)}>{r?.loading ? <span className="mini-spin" /> : <RefreshCw size={14} />}</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div></div>
  );
}
