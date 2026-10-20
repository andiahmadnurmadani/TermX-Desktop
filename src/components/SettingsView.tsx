import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Download, Trash2, Upload } from "lucide-react";
import { api, errText } from "../lib/api";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { THEME_IDS, THEME_NAMES, terminalTheme } from "../lib/themes";
import { useResolvedDark } from "../lib/theme";
import { Seg, Switch } from "./ui";

const ACCENTS = ["#3ddc97", "#5aa9ff", "#b58cff", "#ff8ab3", "#ffb35c", "#f2d45c", "#5fd7e0", "#ff6b6b"];
const FONTS = ["JetBrains Mono", "Menlo", "SF Mono", "Consolas", "Cascadia Code", "Fira Code", "Source Code Pro", "DejaVu Sans Mono", "Ubuntu Mono", "monospace"];

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

export function SettingsView() {
  const t = useT();
  const { vault, saveSettings, run, info, toast } = useStore();
  const dark = useResolvedDark();
  const s = vault!.settings;
  const [fontText, setFontText] = useState(s.fontFamily);
  useEffect(() => setFontText(s.fontFamily), [s.fontFamily]);

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
        <h2>{t("set.appearance")}</h2>
        <div className="panel list">
          <Row title={t("set.theme")}>
            <Seg value={s.appearance} onChange={(v) => saveSettings({ appearance: v })} options={[{ v: "system", label: t("set.system") }, { v: "dark", label: t("set.dark") }, { v: "light", label: t("set.light") }]} />
          </Row>
          <Row title={t("set.accent")}>
            <div className="swatches" style={{ justifyContent: "flex-end" }}>
              {ACCENTS.map((c) => <button key={c} className={"swatch" + (s.accent === c ? " on" : "")} style={{ background: c }} onClick={() => saveSettings({ accent: c })} />)}
            </div>
          </Row>
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
          <Row title={t("set.font")}>
            <input className="input" list="fonts" value={fontText} onChange={(e) => setFontText(e.target.value)} onBlur={() => fontText.trim() && saveSettings({ fontFamily: fontText.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} spellCheck={false} />
            <datalist id="fonts">{FONTS.map((f) => <option key={f} value={f} />)}</datalist>
          </Row>
          <Row title={t("set.fontSize")}>
            <NumInput value={s.fontSize} min={9} max={28} width={90} onCommit={(n) => saveSettings({ fontSize: n })} />
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
          <Row title={t("set.cursorBlink")}><Switch on={s.cursorBlink} onChange={(b) => saveSettings({ cursorBlink: b })} /></Row>
          <Row title={t("set.copyOnSelect")}><Switch on={s.copyOnSelect} onChange={(b) => saveSettings({ copyOnSelect: b })} /></Row>
        </div>
      </div>

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
