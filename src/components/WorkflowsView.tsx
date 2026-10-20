import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, History, Pencil, Play, Plus, ShieldAlert, Trash2, Workflow as WorkflowIcon, X } from "lucide-react";
import { api, errText, type Preview, type WorkflowDef, type WorkflowRun, type WorkflowStep } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { ago } from "../lib/util";
import { confirmDialog } from "../lib/dialogs";
import { Drawer, EmptyState, Field, Modal, Switch } from "./ui";
import { EnvBadge } from "./HostsView";

const blankStep = (): WorkflowStep => ({ id: crypto.randomUUID(), name: "", command: "", timeoutSec: 60, okExit: [], expectOutput: "", continueOnError: false });
const blankWf = (): WorkflowDef => ({ id: crypto.randomUUID(), name: "", description: "", hostIds: [], params: [], steps: [blankStep()], parallel: 4, createdAt: Date.now() });

export function StatusPill({ status }: { status: string }) {
  const t = useT();
  return <span className={"pill st-" + status}>{t(("st." + status) as never)}</span>;
}

export function WorkflowsView() {
  const t = useT();
  const { vault, run } = useStore();
  const list = vault?.workflows ?? [];
  const [sel, setSel] = useState<string | null>(list[0]?.id ?? null);
  const [edit, setEdit] = useState<WorkflowDef | null>(null);
  const [runOf, setRunOf] = useState<WorkflowDef | null>(null);
  const cur = list.find((w) => w.id === sel) ?? list[0];

  return (
    <div className="page"><div className="page-inner">
      <div className="page-head">
        <h1>{t("wf.title")}</h1>
        <div className="sp" />
        <button className="btn primary" onClick={() => setEdit(blankWf())}><Plus size={15} />{t("wf.new")}</button>
      </div>
      <p className="lede">{t("wf.lede")}</p>
      {list.length === 0 ? (
        <EmptyState icon={<WorkflowIcon size={26} />} title={t("wf.empty.title")} body={t("wf.empty.body")}
          action={<button className="btn primary" onClick={() => setEdit(blankWf())}><Plus size={15} />{t("wf.new")}</button>} />
      ) : (
        <div className="wf-layout">
          <div className="panel list wf-list">
            {list.map((w) => (
              <button key={w.id} className={"li wf-item" + (cur?.id === w.id ? " on" : "")} onClick={() => setSel(w.id)}>
                <div className="grow">
                  <div className="ttl">{w.name}</div>
                  <div className="sub">{t("wf.nSteps", { n: w.steps.length })}{w.description ? ` · ${w.description}` : ""}</div>
                </div>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          {cur && <WorkflowDetail key={cur.id} wf={cur} onEdit={() => setEdit(structuredClone(cur))} onRun={() => setRunOf(cur)}
            onDelete={async () => { if (await confirmDialog(t("wf.deleteConfirm"))) { await run(api.workflowDelete(cur.id)); setSel(null); } }} />}
        </div>
      )}
      {edit && <WorkflowEditor initial={edit} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); setSel(id); }} />}
      {runOf && <RunDialog wf={runOf} onClose={() => setRunOf(null)} />}
    </div></div>
  );
}

function WorkflowDetail({ wf, onEdit, onRun, onDelete }: { wf: WorkflowDef; onEdit: () => void; onRun: () => void; onDelete: () => void }) {
  const t = useT();
  const { openRun, toast } = useStore();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const refresh = () => api.workflowRuns(wf.id).then(setRuns).catch((e) => toast(errText(e), "error"));
  useEffect(() => { refresh(); const iv = setInterval(refresh, 4000); return () => clearInterval(iv); /* eslint-disable-next-line */ }, [wf.id]);

  return (
    <div className="wf-detail">
      <div className="panel wf-card">
        <div className="wf-head">
          <div className="grow">
            <h2>{wf.name}</h2>
            {wf.description && <p className="sub">{wf.description}</p>}
          </div>
          <button className="icon-btn" title={t("common.edit")} onClick={onEdit}><Pencil size={15} /></button>
          <button className="icon-btn danger" title={t("common.delete")} onClick={onDelete}><Trash2 size={15} /></button>
          <button className="btn primary" onClick={onRun}><Play size={14} />{t("wf.run")}</button>
        </div>
        <ol className="wf-steps">
          {wf.steps.map((s, i) => (
            <li key={s.id}>
              <span className="n">{i + 1}</span>
              <div className="grow">
                <div className="ttl">{s.name || t("wf.step")}</div>
                <code className="cmd">{s.command}</code>
                <div className="sub">{t("wf.timeoutShort", { n: s.timeoutSec })}{s.okExit.length ? ` · exit ${s.okExit.join(",")}` : ""}{s.expectOutput ? ` · “${s.expectOutput}”` : ""}{s.continueOnError ? ` · ${t("wf.continues")}` : ""}</div>
              </div>
            </li>
          ))}
        </ol>
        {wf.params.length > 0 && <div className="sub" style={{ padding: "0 16px 14px" }}>{t("wf.params")}: {wf.params.map((p) => `{{${p.name}}}`).join(" ")}</div>}
      </div>

      <div className="section" style={{ marginTop: 22 }}>
        <div className="row" style={{ alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}><History size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{t("wf.history")}</h2>
          <div className="sp" style={{ flex: 1 }} />
          {runs.length > 0 && <button className="btn ghost sm" style={{ flex: "0 0 auto" }} onClick={async () => { if (await confirmDialog(t("wf.clearConfirm"))) { await api.workflowRunsClear(wf.id); refresh(); } }}>{t("wf.clear")}</button>}
        </div>
        <div className="panel list">
          {runs.length === 0 && <div className="li" style={{ color: "var(--text-3)" }}>{t("wf.noRuns")}</div>}
          {runs.map((r) => (
            <button key={r.id} className="li wf-item" onClick={() => openRun(r.id, r.workflowName)}>
              <StatusPill status={r.status} />
              <div className="grow">
                <div className="ttl">{new Date(r.startedAt).toLocaleString()}</div>
                <div className="sub">{t("wf.nHosts", { n: r.hostIds.length })}{r.finishedAt ? ` · ${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s` : ""}</div>
              </div>
              <span className="sub">{ago(r.startedAt, "")}</span>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ editor

function WorkflowEditor({ initial, onClose, onSaved }: { initial: WorkflowDef; onClose: () => void; onSaved: (id: string) => void }) {
  const t = useT();
  const { run } = useStore();
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const [w, setW] = useState<WorkflowDef>(initial);
  const [open, setOpen] = useState<string | null>(initial.steps[0]?.id ?? null);
  const setStep = (i: number, p: Partial<WorkflowStep>) => setW({ ...w, steps: w.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= w.steps.length) return;
    const steps = [...w.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setW({ ...w, steps });
  };
  const save = async () => {
    const clean: WorkflowDef = {
      ...w, name: w.name.trim(),
      steps: w.steps.filter((s) => s.command.trim()).map((s, i) => ({ ...s, name: s.name.trim() || `${t("wf.step")} ${i + 1}` })),
      params: w.params.filter((p) => p.name.trim()).map((p) => ({ ...p, name: p.name.trim() })),
    };
    const ok = await run(api.workflowSave(clean).then(() => true));
    if (ok) onSaved(clean.id);
  };

  return (
    <Drawer title={initial.name ? t("wf.edit") : t("wf.new")} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn primary" disabled={!w.name.trim() || !w.steps.some((s) => s.command.trim())} onClick={save}>{t("common.save")}</button>
    </>}>
      <div className="stack">
        <Field label={t("common.name")}><input className="input" autoFocus value={w.name} placeholder="Daily health check" onChange={(e) => setW({ ...w, name: e.target.value })} /></Field>
        <Field label={`${t("snip.description")} (${t("common.optional")})`}><input className="input" value={w.description} onChange={(e) => setW({ ...w, description: e.target.value })} /></Field>

        <div className="sect-label">{t("wf.steps")}</div>
        {w.steps.map((s, i) => (
          <div key={s.id} className="step-edit">
            <div className="step-edit-head" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="n">{i + 1}</span>
              <span className="grow">{s.name || <span className="muted">{s.command || t("wf.step")}</span>}</span>
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); move(i, -1); }}><ArrowUp size={14} /></button>
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); move(i, 1); }}><ArrowDown size={14} /></button>
              <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); setW({ ...w, steps: w.steps.filter((x) => x.id !== s.id) }); }}><X size={14} /></button>
            </div>
            {open === s.id && (
              <div className="stack step-edit-body">
                <Field label={t("common.name")}><input className="input" value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} /></Field>
                <Field label={t("snip.command")} hint={t("wf.cmdHint")}>
                  <textarea className="textarea mono" rows={3} spellCheck={false} value={s.command} onChange={(e) => setStep(i, { command: e.target.value })} />
                </Field>
                <div className="row">
                  <Field label={t("wf.timeout")}><input className="input" type="number" min={1} value={s.timeoutSec} onChange={(e) => setStep(i, { timeoutSec: Math.max(1, Number(e.target.value) || 60) })} /></Field>
                  <Field label={t("wf.okExit")} hint={t("wf.okExitHint")}>
                    <input className="input mono" value={s.okExit.join(",")} placeholder="0"
                      onChange={(e) => setStep(i, { okExit: e.target.value.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0) })} />
                  </Field>
                </div>
                <Field label={`${t("wf.expect")} (${t("common.optional")})`}><input className="input mono" value={s.expectOutput} onChange={(e) => setStep(i, { expectOutput: e.target.value })} /></Field>
                <div className="toggle-row"><span>{t("wf.continueOnError")}</span><Switch on={s.continueOnError} onChange={(b) => setStep(i, { continueOnError: b })} /></div>
              </div>
            )}
          </div>
        ))}
        <button className="btn" onClick={() => { const s = blankStep(); setW({ ...w, steps: [...w.steps, s] }); setOpen(s.id); }}><Plus size={14} />{t("wf.addStep")}</button>

        <div className="sect-label">{t("wf.params")}</div>
        <p className="hint-block">{t("wf.paramsHint")}</p>
        {w.params.map((p, i) => (
          <div key={i} className="row" style={{ alignItems: "end" }}>
            <Field label={t("wf.paramName")}><input className="input mono" value={p.name} placeholder="service" onChange={(e) => setW({ ...w, params: w.params.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x)) })} /></Field>
            <Field label={t("wf.paramDefault")}><input className="input mono" value={p.default} onChange={(e) => setW({ ...w, params: w.params.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)) })} /></Field>
            <div className="toggle-row" style={{ flex: "0 0 auto", height: 34, gap: 8 }}><small>{t("wf.secret")}</small><Switch on={p.secret} onChange={(b) => setW({ ...w, params: w.params.map((x, j) => (j === i ? { ...x, secret: b } : x)) })} /></div>
            <button className="icon-btn danger" style={{ flex: "0 0 auto", marginBottom: 3 }} onClick={() => setW({ ...w, params: w.params.filter((_, j) => j !== i) })}><X size={14} /></button>
          </div>
        ))}
        <button className="btn" onClick={() => setW({ ...w, params: [...w.params, { name: "", label: "", default: "", secret: false }] })}><Plus size={14} />{t("wf.addParam")}</button>

        <div className="sect-label">{t("wf.defaultHosts")}</div>
        <HostChecklist hosts={hosts} value={w.hostIds} onChange={(hostIds) => setW({ ...w, hostIds })} />
        <Field label={t("wf.parallel")}><input className="input" type="number" min={1} max={16} value={w.parallel} onChange={(e) => setW({ ...w, parallel: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })} /></Field>
      </div>
    </Drawer>
  );
}

function HostChecklist({ hosts, value, onChange }: { hosts: { id: string; label: string; hostname: string; environment: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  if (!hosts.length) return <p className="hint-block">{t("hosts.empty.title")}</p>;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="checklist">
      {hosts.map((h) => (
        <label key={h.id} className={"check" + (value.includes(h.id) ? " on" : "")}>
          <input type="checkbox" checked={value.includes(h.id)} onChange={() => toggle(h.id)} />
          <span className="grow">{h.label} <span className="sub">{h.hostname}</span></span>
          <EnvBadge env={h.environment} />
        </label>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ run dialog (targets -> preview -> confirm)

function RunDialog({ wf, onClose }: { wf: WorkflowDef; onClose: () => void }) {
  const t = useT();
  const { openRun, toast } = useStore();
  const hosts = useStore((s) => s.vault?.hosts ?? []);
  const [hostIds, setHostIds] = useState<string[]>(wf.hostIds.filter((id) => hosts.some((h) => h.id === id)));
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(wf.params.map((p) => [p.name, p.default])));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const risky = useMemo(() => (preview?.steps ?? []).filter((s) => s.risks.length), [preview]);

  const doPreview = async () => {
    try { setPreview(await api.workflowPreview(wf, hostIds, params)); setAck(false); } catch (e) { toast(errText(e), "error"); }
  };
  const start = async () => {
    setBusy(true);
    try {
      const id = await api.workflowRun(wf, hostIds, params, !!preview?.needsConfirm && ack);
      onClose();
      openRun(id, wf.name);
    } catch (e) { toast(errText(e), "error"); }
    setBusy(false);
  };

  return (
    <Modal wide onClose={onClose}>
      <h3>{t("wf.runTitle", { name: wf.name })}</h3>
      {!preview ? (
        <>
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="sect-label" style={{ marginTop: 0 }}>{t("wf.targets")}</div>
            <HostChecklist hosts={hosts} value={hostIds} onChange={setHostIds} />
            {wf.params.length > 0 && <div className="sect-label">{t("wf.params")}</div>}
            {wf.params.map((p) => (
              <Field key={p.name} label={p.label || p.name}>
                <input className="input mono" type={p.secret ? "password" : "text"} value={params[p.name] ?? ""} spellCheck={false}
                  onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="actions">
            <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn primary" disabled={!hostIds.length} onClick={doPreview}>{t("wf.review")}</button>
          </div>
        </>
      ) : (
        <>
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="sub">{t("wf.willRunOn")}</div>
            <div className="chips">{preview.hosts.map((h) => <span key={h.id} className="chip">{h.label}<EnvBadge env={h.environment} /></span>)}</div>
            <ol className="wf-steps compact">
              {preview.steps.map((s, i) => (
                <li key={i}><span className="n">{i + 1}</span><div className="grow"><div className="ttl">{s.name}</div><code className="cmd">{s.command}</code>
                  {s.risks.length > 0 && <div className="risk">{s.risks.join(" · ")}</div>}</div></li>
              ))}
            </ol>
            {preview.needsConfirm && (
              <div className="warn-box">
                <ShieldAlert size={20} />
                <div>
                  <b>{t("wf.confirmTitle")}</b>
                  {preview.productionHosts.length > 0 && <div style={{ fontSize: 12 }}>{t("wf.prodWarn", { hosts: preview.productionHosts.join(", ") })}</div>}
                  {risky.length > 0 && <div style={{ fontSize: 12 }}>{t("wf.riskWarn", { n: risky.length })}</div>}
                  <label className="ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t("wf.ack")}</label>
                </div>
              </div>
            )}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setPreview(null)}>{t("wf.back")}</button>
            <button className={"btn " + (preview.needsConfirm ? "danger solid" : "primary")} disabled={busy || (preview.needsConfirm && !ack)} onClick={start}><Play size={14} />{t("wf.run")}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
