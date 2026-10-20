import { useEffect, useMemo, useRef, useState } from "react";
import { Square } from "lucide-react";
import { api, errText, events, type StepRun, type WfEvent, type WorkflowRun } from "../lib/api";
import { useStore, type Tab } from "../lib/store";
import { useT } from "../lib/i18n";
import { StatusPill } from "./WorkflowsView";

const key = (hostId: string, idx: number) => `${hostId}#${idx}`;

/** Live (or historical) view of one workflow run: hosts × steps, output per cell. */
export function RunView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const outRef = useRef<HTMLPreElement>(null);
  const runId = tab.runId!;

  useEffect(() => {
    let alive = true;
    const fetchRun = () => api.workflowRunGet(runId).then((r) => {
      if (!alive || !r) return;
      setRun((prev) => {
        if (!prev) return r;
        // keep live output that is longer than what was stored so far
        const live = new Map(prev.steps.map((s) => [key(s.hostId, s.idx), s]));
        return { ...r, steps: r.steps.map((s) => { const l = live.get(key(s.hostId, s.idx)); return l && s.status === l.status && l.stdout.length > s.stdout.length ? { ...s, stdout: l.stdout, stderr: l.stderr } : s; }) };
      });
    }).catch((e) => toast(errText(e), "error"));
    const un = events.on<WfEvent>("workflow:event", (ev) => {
      if (ev.runId !== runId) return;
      if (ev.kind === "run") { fetchRun(); return; }
      setRun((r) => {
        if (!r) return r;
        const steps = r.steps.map((s): StepRun => {
          if (s.hostId !== ev.hostId || s.idx !== ev.idx) return s;
          if (ev.kind === "output") return ev.stream === "err" ? { ...s, stderr: s.stderr + ev.chunk } : { ...s, stdout: s.stdout + ev.chunk };
          return { ...s, status: ev.status as StepRun["status"], error: ev.chunk || s.error, exitCode: ev.exitCode ?? s.exitCode,
            startedAt: ev.status === "running" ? Date.now() : s.startedAt, finishedAt: ev.status === "running" ? 0 : Date.now() };
        });
        return { ...r, steps };
      });
    });
    fetchRun();
    return () => { alive = false; un.then((u) => u()); };
  }, [runId, toast]);

  const hosts = useMemo(() => {
    const m = new Map<string, { id: string; label: string; steps: StepRun[] }>();
    for (const s of run?.steps ?? []) {
      if (!m.has(s.hostId)) m.set(s.hostId, { id: s.hostId, label: s.hostLabel, steps: [] });
      m.get(s.hostId)!.steps.push(s);
    }
    for (const h of m.values()) h.steps.sort((a, b) => a.idx - b.idx);
    return [...m.values()];
  }, [run]);

  // default selection: first running/failed cell, else the first
  const cur = useMemo(() => {
    const all = run?.steps ?? [];
    return all.find((s) => key(s.hostId, s.idx) === sel) ?? all.find((s) => s.status === "running") ?? all.find((s) => s.status === "failed" || s.status === "timeout") ?? all[0];
  }, [run, sel]);

  useEffect(() => { const el = outRef.current; if (el && cur?.status === "running") el.scrollTop = el.scrollHeight; }, [cur?.stdout, cur?.stderr, cur?.status]);

  if (!run) return <div className={"run-view" + (visible ? "" : " hidden")}><div className="spinner" style={{ margin: 40 }} /></div>;
  const stepCount = Math.max(0, ...hosts.map((h) => h.steps.length));
  const hostStatus = (steps: StepRun[]) =>
    steps.some((s) => s.status === "running") ? "running" : steps.some((s) => s.status === "failed" || s.status === "timeout") ? "failed"
      : steps.some((s) => s.status === "cancelled") ? "cancelled" : steps.every((s) => s.status === "ok") ? "ok" : steps.some((s) => s.status === "pending") ? "pending" : "skipped";

  return (
    <div className={"run-view" + (visible ? "" : " hidden")}>
      <div className="run-head">
        <StatusPill status={run.status} />
        <h2>{run.workflowName}</h2>
        <span className="sub">{new Date(run.startedAt).toLocaleString()}</span>
        {run.params.length > 0 && <span className="sub mono">{run.params.map(([k, v]) => `${k}=${v}`).join("  ")}</span>}
        <div className="sp" />
        {run.status === "running" && <button className="btn danger" onClick={() => api.workflowCancel(run.id)}><Square size={13} />{t("wf.stop")}</button>}
      </div>
      <div className="run-body">
        <div className="run-matrix">
          <table>
            <thead><tr><th>{t("wf.host")}</th>{Array.from({ length: stepCount }).map((_, i) => <th key={i} title={hosts[0]?.steps[i]?.name}>{i + 1}. {hosts[0]?.steps[i]?.name}</th>)}</tr></thead>
            <tbody>
              {hosts.map((h) => (
                <tr key={h.id}>
                  <td className="hcell"><span className={"sdot st-" + hostStatus(h.steps)} />{h.label}</td>
                  {h.steps.map((s) => (
                    <td key={s.idx}>
                      <button className={"cell-btn st-" + s.status + (cur && key(cur.hostId, cur.idx) === key(s.hostId, s.idx) ? " sel" : "")} onClick={() => setSel(key(s.hostId, s.idx))}>
                        {s.status === "running" ? <span className="mini-spin" /> : <span className={"sdot st-" + s.status} />}
                        {t(("st." + s.status) as never)}{s.exitCode !== null && s.status !== "ok" ? ` (${s.exitCode})` : ""}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cur && (
          <div className="run-out">
            <div className="run-out-head">
              <b>{cur.hostLabel}</b><span className="sub">›</span><span>{cur.idx + 1}. {cur.name}</span>
              <StatusPill status={cur.status} />
              {cur.finishedAt > 0 && cur.startedAt > 0 && <span className="sub">{((cur.finishedAt - cur.startedAt) / 1000).toFixed(2)}s</span>}
            </div>
            <code className="cmd">$ {cur.command}</code>
            {cur.error && <div className="risk">{cur.error}</div>}
            <pre ref={outRef} className="out">{cur.stdout}{cur.stderr && <span className="err">{cur.stderr}</span>}{!cur.stdout && !cur.stderr && <span className="muted">{cur.status === "pending" ? t("wf.waiting") : t("wf.noOutput")}</span>}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
