import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUpCircle, Archive, Download, KeyRound, Lock, RefreshCw, ScrollText, Trash2, Upload } from "lucide-react";
import { api, errText } from "../lib/api";
import { useStore } from "../lib/store";
import { confirmDialog } from "../lib/dialogs";
import { useT } from "../lib/i18n";
import { THEME_IDS, THEME_NAMES, terminalTheme } from "../lib/themes";
import { uiFontStack, useResolvedDark } from "../lib/theme";
import { useUpdater } from "../lib/updater";
import { Field, Modal, PasswordInput, Seg, Switch } from "./ui";
import { AiSetup } from "./AiPanel";
import { fmtTokens } from "./AiContext";
import { LIMIT_PRESETS } from "../lib/ai/context";

const ACCENTS = ["#3ddc97", "#5aa9ff", "#b58cff", "#ff8ab3", "#ffb35c", "#f2d45c", "#5fd7e0", "#ff6b6b"];
const FONTS = ["JetBrains Mono", "Menlo", "SF Mono", "Monaco", "Consolas", "Cascadia Code", "Fira Code", "Source Code Pro", "IBM Plex Mono", "Hack", "DejaVu Sans Mono", "Ubuntu Mono"];
const TERM_FONTS = FONTS.map((f) => ({ v: f, label: f }));
const UI_FONTS: { v: string; label: string }[] = [
  { v: "inter", label: "Inter" }, { v: "system", label: "System" }, { v: "SF Pro Text", label: "SF Pro" }, { v: "Segoe UI", label: "Segoe UI" },
  { v: "Roboto", label: "Roboto" }, { v: "Ubuntu", label: "Ubuntu" }, { v: "Helvetica Neue", label: "Helvetica Neue" }, { v: "Noto Sans", label: "Noto Sans" },
];

/** Preset list plus a free-text "custom" entry for any installed font. */
function FontPicker({ value, presets, onChange, mono }: { value: string; presets: { v: string; label: string }[]; onChange: (v: string) => void; mono?: boolean }) {
  const known = presets.some((p) => p.v === value);
  const [custom, setCustom] = useState(!known);
  const [txt, setTxt] = useState(known ? "" : value);
  useEffect(() => { const k = presets.some((p) => p.v === value); setCustom(!k); if (!k) setTxt(value); }, [value, presets]);
  return (
    <div className="font-picker">
      <select className="select" value={custom ? "__custom" : value} onChange={(e) => {
        if (e.target.value === "__custom") { setCustom(true); setTxt(""); } else { setCustom(false); onChange(e.target.value); }
      }}>
        {presets.map((p) => <option key={p.v} value={p.v} style={{ fontFamily: p.v === "inter" ? undefined : p.v === "system" ? undefined : `"${p.v}"` }}>{p.label}</option>)}
        <option value="__custom">Custom…</option>
      </select>
      {custom && (
        <input className={"input" + (mono ? " mono" : "")} autoFocus placeholder="Font name" value={txt} spellCheck={false}
          onChange={(e) => setTxt(e.target.value)} onBlur={() => txt.trim() && txt.trim() !== value && onChange(txt.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      )}
    </div>
  );
}

function UpdateRow() {
  const t = useT();
  const { status, update, error, check, open } = useUpdater();
  const [checked, setChecked] = useState(false);
  const run = async () => { setChecked(true); const st = await check(true); if (st === "available") open(); };
  return (
    <Row title={t("set.version") + " " + (useStore.getState().info?.version ?? "")}
      hint={status === "checking" ? "…" : update && status !== "none" ? t("upd.available", { v: update.version }) : checked && status === "none" ? t("set.upToDate") : checked && status === "error" ? t("upd.failed", { e: error }) : undefined}>
      {update && (status === "available" || status === "error")
        ? <button className="btn primary" onClick={open}><ArrowUpCircle size={14} />{t("upd.now")}</button>
        : <button className="btn" disabled={status === "checking" || status === "downloading" || status === "installing"} onClick={run}><RefreshCw size={14} className={status === "checking" ? "spin" : ""} />{t("set.checkNow")}</button>}
    </Row>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <div className="setting"><div className="meta"><div>{title}</div>{hint && <small>{hint}</small>}</div><div className="ctl">{children}</div></div>;
}

/** Number field that only commits (clamped) on blur/Enter so typing "14" does not get clamped at "1". */
function NumInput({ value, min, max, step, width, onCommit }: { value: number; min: number; max: number; step?: number; width: number; onCommit: (n: number) => void }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  const commit = () => {
    const n = Number(txt);
    const v = Number.isFinite(n) && txt.trim() !== "" ? Math.min(max, Math.max(min, n)) : value;
    setTxt(String(v));
    if (v !== value) onCommit(v);
  };
  return <input className="input" type="number" step={step} min={min} max={max} style={{ width }} value={txt} onChange={(e) => setTxt(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

type PwDialog =
  | { kind: "enable" } | { kind: "change" } | { kind: "disable" }
  | { kind: "backup"; path: string } | { kind: "restore"; path: string };

function PasswordDialog({ d, onClose }: { d: PwDialog; onClose: () => void }) {
  const t = useT();
  const { load, toast } = useStore();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const needCur = d.kind === "change" || d.kind === "disable";
  const needNew = d.kind !== "disable" && d.kind !== "restore";
  const needOne = d.kind === "restore";
  const valid = (!needCur || cur) && (!needNew || (pw.length >= 8 && pw === pw2)) && (!needOne || pw);
  const title = t(("sec.dlg." + d.kind) as never);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      if (d.kind === "enable") await api.vaultSetMaster(null, pw);
      if (d.kind === "change") await api.vaultSetMaster(cur, pw);
      if (d.kind === "disable") await api.vaultSetMaster(cur, null);
      if (d.kind === "backup") await api.backupExport(d.path, pw);
      if (d.kind === "restore") {
        const r = await api.backupImport(d.path, pw);
        toast(t("sec.restored", { hosts: r.hosts, keys: r.keys, workflows: r.workflows, workspaces: r.workspaces }), "ok");
      } else toast(t("common.saved"), "ok");
      await load();
      onClose();
    } catch (e2) { toast(errText(e2), "error"); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit}>
        <h3>{title}</h3>
        <p>{t(("sec.dlgBody." + d.kind) as never)}</p>
        <div className="stack">
          {needCur && <Field label={t("sec.current")}><PasswordInput value={cur} onChange={setCur} autoFocus /></Field>}
          {needNew && <Field label={t("sec.new")} hint={t("sec.minLen")}><PasswordInput value={pw} onChange={setPw} autoFocus={!needCur} /></Field>}
          {needNew && <Field label={t("sec.repeat")} hint={pw2 && pw !== pw2 ? t("sec.mismatch") : undefined}><PasswordInput value={pw2} onChange={setPw2} /></Field>}
          {needOne && <Field label={t("sec.backupPw")}><PasswordInput value={pw} onChange={setPw} autoFocus /></Field>}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className={"btn " + (d.kind === "disable" ? "danger solid" : "primary")} disabled={!valid || busy}>{busy ? <span className="mini-spin" /> : null}{t("common.confirm")}</button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsView() {
  const t = useT();
  const { vault, saveSettings, run, info, toast, setView } = useStore();
  const dark = useResolvedDark();
  const s = vault!.settings;
  const [dlg, setDlg] = useState<PwDialog | null>(null);
  const status = vault!.status;
  const termTh = terminalTheme(s.terminalTheme, dark, s.accent);
  const startBackup = async () => {
    const p = await saveDialog({ defaultPath: `termx-backup-${new Date().toISOString().slice(0, 10)}.termx`, filters: [{ name: "TermX backup", extensions: ["termx"] }] });
    if (p) setDlg({ kind: "backup", path: p });
  };
  const startRestore = async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: "TermX backup", extensions: ["termx", "json"] }] });
    if (typeof p === "string") setDlg({ kind: "restore", path: p });
  };

  const doExport = async () => {
    const p = await saveDialog({ defaultPath: "termx-hosts.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!p) return;
    try { await api.configExport(p); toast(t("set.exported"), "ok"); } catch (e) { toast(errText(e), "error"); }
  };
  const doImport = async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof p !== "string") return;
    const n = await run(api.configImport(p));
    if (n !== undefined) toast(t("set.imported", { n }), "ok");
  };

  return (
    <div className="page"><div className="page-inner" style={{ maxWidth: 760 }}>
      <div className="page-head"><h1>{t("set.title")}</h1></div>

      <div className="section">
        <h2>{t("set.interface")}</h2>
        <div className="panel list">
          <Row title={t("set.theme")}>
            <Seg value={s.appearance} onChange={(v) => saveSettings({ appearance: v })} options={[{ v: "system", label: t("set.system") }, { v: "dark", label: t("set.dark") }, { v: "light", label: t("set.light") }]} />
          </Row>
          <Row title={t("set.accent")}>
            <div className="swatches" style={{ justifyContent: "flex-end" }}>
              {ACCENTS.map((c) => <button key={c} className={"swatch" + (s.accent === c ? " on" : "")} style={{ background: c }} onClick={() => saveSettings({ accent: c })} />)}
            </div>
          </Row>
          <Row title={t("set.uiFont")} hint={t("set.uiFontHint")}>
            <FontPicker value={s.uiFont} presets={UI_FONTS} onChange={(v) => saveSettings({ uiFont: v })} />
          </Row>
          <Row title={t("set.uiScale")} hint={t("set.uiScaleHint")}>
            <Seg value={String(s.uiScale)} onChange={(v) => saveSettings({ uiScale: Number(v) })} options={[
              { v: "90", label: "90%" }, { v: "100", label: "100%" }, { v: "110", label: "110%" }, { v: "125", label: "125%" }, { v: "150", label: "150%" },
            ]} />
          </Row>
          <div className="ui-preview" style={{ fontFamily: uiFontStack(s.uiFont) }}>
            <b>The quick brown fox</b> jumps over the lazy dog · 0123456789
          </div>
          <Row title={t("set.language")}>
            <Seg value={s.language} onChange={(v) => saveSettings({ language: v })} options={[{ v: "en", label: "English" }, { v: "id", label: "Indonesia" }]} />
          </Row>
        </div>
      </div>

      <div className="section">
        <h2>{t("set.terminal")}</h2>
        <div className="panel list">
          <div>
            <div className="setting" style={{ paddingBottom: 0 }}><div className="meta">{t("set.termTheme")}</div></div>
            <div className="theme-grid">
              {THEME_IDS.map((id) => {
                const th = terminalTheme(id, dark, s.accent);
                return (
                  <button key={id} className={"theme" + (s.terminalTheme === id ? " on" : "")} onClick={() => saveSettings({ terminalTheme: id })}>
                    <div className="pv" style={{ background: th.background, color: th.foreground }}>
                      <span style={{ color: th.green }}>~</span> <span style={{ color: th.blue }}>ls</span> -la<br />
                      <span style={{ color: th.yellow }}>drwxr</span> <span style={{ color: th.magenta }}>src</span> <span style={{ color: th.cyan }}>.git</span>
                    </div>
                    <div className="nm">{THEME_NAMES[id]}</div>
                  </button>
                );
              })}
            </div>
          </div>
          <Row title={t("set.font")} hint={t("set.termFontHint")}>
            <FontPicker mono value={s.fontFamily} presets={TERM_FONTS} onChange={(v) => saveSettings({ fontFamily: v })} />
          </Row>
          <Row title={t("set.fontSize")}>
            <NumInput value={s.fontSize} min={9} max={28} width={90} onCommit={(n) => saveSettings({ fontSize: n })} />
          </Row>
          <Row title={t("set.fontWeight")}>
            <Seg value={String(s.fontWeight)} onChange={(v) => saveSettings({ fontWeight: Number(v), fontWeightBold: Math.min(900, Math.max(700, Number(v) + 300)) })} options={[
              { v: "300", label: "300" }, { v: "400", label: "400" }, { v: "500", label: "500" }, { v: "600", label: "600" },
            ]} />
          </Row>
          <Row title={t("set.letterSpacing")}>
            <NumInput value={s.letterSpacing} min={-2} max={6} step={0.5} width={90} onCommit={(n) => saveSettings({ letterSpacing: n })} />
          </Row>
          <Row title={t("set.lineHeight")}>
            <NumInput value={s.lineHeight} min={1} max={2} step={0.05} width={90} onCommit={(n) => saveSettings({ lineHeight: n })} />
          </Row>
          <Row title={t("set.scrollback")}>
            <NumInput value={s.scrollback} min={1000} max={200000} step={1000} width={110} onCommit={(n) => saveSettings({ scrollback: Math.round(n) })} />
          </Row>
          <Row title={t("set.cursor")}>
            <Seg value={s.cursorStyle} onChange={(v) => saveSettings({ cursorStyle: v })} options={[{ v: "bar", label: t("set.cursorBar") }, { v: "block", label: t("set.cursorBlock") }, { v: "underline", label: t("set.cursorUnderline") }]} />
          </Row>
          <div className="font-preview" style={{
            fontFamily: `"${s.fontFamily}", "JetBrains Mono", Menlo, Consolas, monospace`, fontSize: s.fontSize, lineHeight: s.lineHeight,
            fontWeight: s.fontWeight, letterSpacing: s.letterSpacing, background: termTh.background, color: termTh.foreground,
          }}>
            <span style={{ color: termTh.green }}>deploy@web-01</span>:<span style={{ color: termTh.blue }}>~/app</span>$ git log --oneline -2<br />
            <span style={{ color: termTh.yellow }}>3f9c2a1</span> <b style={{ fontWeight: s.fontWeightBold }}>Fix</b> worker timeout {"->"} 30s {"{}"} [] 0O 1lI<br />
            <span style={{ color: termTh.yellow }}>a41be07</span> Add health check <span style={{ color: termTh.magenta }}>#128</span>
          </div>
          <Row title={t("set.cursorBlink")}><Switch on={s.cursorBlink} onChange={(b) => saveSettings({ cursorBlink: b })} /></Row>
          <Row title={t("set.copyOnSelect")}><Switch on={s.copyOnSelect} onChange={(b) => saveSettings({ copyOnSelect: b })} /></Row>
          <Row title={t("set.sudoAutofill")} hint={t("set.sudoAutofillHint")}><Switch on={!!s.sudoAutofill} onChange={(b) => saveSettings({ sudoAutofill: b })} /></Row>
          <Row title={t("set.autocomplete")} hint={t("set.autocompleteHint")}><Switch on={s.autocomplete !== false} onChange={(b) => saveSettings({ autocomplete: b })} /></Row>
        </div>
      </div>

      <div className="section">
        <h2>{t("ai.title")}</h2>
        <div className="panel list">
          <div className="setting ai-setting"><div className="meta"><div>{t("ai.provider")}</div><small>{t("ai.setupBody")}</small></div><div className="ctl"><AiSetup /></div></div>
          <Row title={t("ai.ctx.settingsLimit")} hint={t("ai.ctx.settingsLimitHint")}>
            <Seg value={String(s.ai.contextLimit ?? 0)} onChange={(v) => saveSettings({ ai: { ...s.ai, contextLimit: Number(v) } })}
              options={[{ v: "0", label: t("ai.ctx.auto") }, ...LIMIT_PRESETS.map((n) => ({ v: String(n), label: fmtTokens(n) }))]} />
          </Row>
          <Row title={t("ai.ctx.settingsMode")} hint={t("ai.ctx.settingsModeHint")}>
            <Seg value={s.ai.contextMode ?? "compact"} onChange={(v) => saveSettings({ ai: { ...s.ai, contextMode: v } })}
              options={[{ v: "compact", label: t("ai.ctx.mode.compact").split(":")[0] }, { v: "trim", label: t("ai.ctx.mode.trim").split(":")[0] }, { v: "off", label: t("ai.ctx.mode.off").split(":")[0] }]} />
          </Row>
          <Row title={t("ai.runMode.title")} hint={t("ai.runMode.hint")}>
            <Seg value={s.ai.runMode ?? "terminal"} onChange={(v) => saveSettings({ ai: { ...s.ai, runMode: v } })}
              options={[{ v: "terminal", label: t("ai.runMode.terminal") }, { v: "background", label: t("ai.runMode.background") }]} />
          </Row>
          <Row title={t("ai.approvalTitle")} hint={t("ai.approvalHint")}>
            <Seg value={s.ai.approval} onChange={async (v) => { if (v === "always" && !(await confirmDialog(t("ai.alwaysConfirm")))) return; saveSettings({ ai: { ...s.ai, approval: v } }); }}
              options={[{ v: "ask", label: t("ai.approval.ask") }, { v: "safe", label: t("ai.approval.safe") }, { v: "auto", label: t("ai.approval.auto") }, { v: "always", label: t("ai.approval.always") }]} />
          </Row>
          <Row title={t("ai.shareScreen")} hint={t("ai.shareScreenHint")}><Switch on={s.ai.shareScreen} onChange={(b) => saveSettings({ ai: { ...s.ai, shareScreen: b } })} /></Row>
          <div className="setting ai-setting"><div className="meta"><div>{t("ai.instructions")}</div><small>{t("ai.instructionsHint")}</small></div>
            <div className="ctl"><AiInstructions /></div></div>
        </div>
      </div>

      <div className="section">
        <h2>{t("nav.logs")}</h2>
        <div className="panel list">
          <Row title={t("logs.record")} hint={t("logs.recordHint")}><Switch on={s.sessionLogs} onChange={(b) => saveSettings({ sessionLogs: b })} /></Row>
          <Row title={t("nav.logs")} hint={t("set.logsHint")}><button className="btn" onClick={() => setView("logs")}><ScrollText size={14} />{t("logs.title")}</button></Row>
        </div>
      </div>

      <div className="section">
        <h2>{t("set.updates")}</h2>
        <div className="panel list">
          <UpdateRow />
          <Row title={t("set.checkUpdates")} hint={t("set.checkUpdatesHint")}><Switch on={s.checkUpdates} onChange={(b) => saveSettings({ checkUpdates: b })} /></Row>
        </div>
      </div>

      <div className="section">
        <h2>{t("set.security")}</h2>
        <div className="panel list">
          <Row title={t("sec.vault")} hint={t(status.mode === "master" ? "sec.modeMaster" : "sec.modeKeychain")}>
            {status.mode === "master" ? (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn" onClick={() => setDlg({ kind: "change" })}><KeyRound size={14} />{t("sec.change")}</button>
                <button className="btn danger" onClick={() => setDlg({ kind: "disable" })}>{t("sec.remove")}</button>
              </div>
            ) : (
              <button className="btn primary" onClick={() => setDlg({ kind: "enable" })}><Lock size={14} />{t("sec.enable")}</button>
            )}
          </Row>
          {status.mode === "master" && (
            <Row title={t("sec.autoLock")} hint={t("sec.autoLockHint")}>
              <Seg value={String(s.autoLockMin)} onChange={(v) => saveSettings({ autoLockMin: Number(v) })} options={[
                { v: "5", label: "5m" }, { v: "15", label: "15m" }, { v: "30", label: "30m" }, { v: "60", label: "1h" }, { v: "0", label: t("sec.never") },
              ]} />
            </Row>
          )}
          <Row title={t("sec.backup")} hint={t("sec.backupHint")}>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={startBackup}><Archive size={14} />{t("sec.backupNow")}</button>
              <button className="btn" onClick={startRestore}><Upload size={14} />{t("sec.restore")}</button>
            </div>
          </Row>
        </div>
      </div>
      {dlg && <PasswordDialog d={dlg} onClose={() => setDlg(null)} />}

      <div className="section">
        <h2>{t("set.knownHosts")}</h2>
        <div className="panel list">
          {(vault?.knownHosts ?? []).length === 0 && <div className="li" style={{ color: "var(--text-3)" }}>{t("set.knownEmpty")}</div>}
          {(vault?.knownHosts ?? []).map((k) => (
            <div className="li" key={k.hostPort}>
              <div className="grow"><div className="ttl">{k.hostPort} <span className="tag">{k.keyType}</span></div><div className="sub mono" style={{ fontSize: 11 }}>{k.fingerprint}</div></div>
              <button className="btn sm" onClick={() => run(api.knownHostDelete(k.hostPort))}><Trash2 size={13} />{t("set.forget")}</button>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>{t("set.data")}</h2>
        <div className="panel list">
          <Row title={t("set.export")} hint={t("set.exportHint")}><button className="btn" onClick={doExport}><Download size={14} />{t("set.export")}</button></Row>
          <Row title={t("set.import")}><button className="btn" onClick={doImport}><Upload size={14} />{t("set.import")}</button></Row>
          <div className="setting"><div className="meta"><div>{t("set.dataDir")}</div><small className="mono" style={{ userSelect: "text" }}>{info?.dataDir}</small></div></div>
        </div>
      </div>

      <div style={{ textAlign: "center", color: "var(--text-3)", fontSize: 12 }}>TermX {info?.version} · {info?.os}</div>
    </div></div>
  );
}

/** Custom instructions for the assistant, saved when the field loses focus. */
function AiInstructions() {
  const t = useT();
  const { vault, saveSettings } = useStore();
  const ai = vault!.settings.ai;
  const [v, setV] = useState(ai.instructions ?? "");
  return (
    <textarea className="input ai-instr" rows={5} value={v} placeholder={t("ai.instructionsPh")} spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (ai.instructions ?? "")) saveSettings({ ai: { ...ai, instructions: v } }); }} />
  );
}
