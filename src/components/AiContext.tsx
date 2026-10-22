import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Minimize2 } from "lucide-react";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { currentContext, fitContext, useAi } from "../lib/ai/agent";
import { LIMIT_PRESETS, contextLimit, contextMode, type ContextMode } from "../lib/ai/context";
import { resolveProvider } from "../lib/ai/providers";

export const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Ring + percentage in the composer; opens a pop-over with the breakdown, the limit and the compaction mode. */
export function ContextMeter() {
  const t = useT();
  const { history, busy, compacting, lastInput, usage } = useAi();
  const vault = useStore((s) => s.vault)!;
  const saveSettings = useStore((s) => s.saveSettings);
  const toast = useStore((s) => s.toast);
  const ai = vault.settings.ai;
  const { model } = resolveProvider(ai);
  const [pop, setPop] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // the screen and host list are part of the system prompt, so recompute when the turn state changes too
  const info = useMemo(() => currentContext(), [history, busy, ai.contextLimit, ai.provider, ai.models, ai.runMode, ai.instructions, vault.hosts, vault.settings.language]); // eslint-disable-line react-hooks/exhaustive-deps
  const mode = contextMode(ai);
  const limit = contextLimit(ai, model);
  const auto = (ai.contextLimit ?? 0) === 0;

  useEffect(() => {
    if (!pop) return;
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setPop(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setPop(false); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [pop]);

  const tone = info.pct >= 90 ? "hot" : info.pct >= 70 ? "warm" : "ok";
  const C = 2 * Math.PI * 7;
  const dash = Math.min(1, info.total / Math.max(1, limit)) * C;
  const seg = (n: number) => `${Math.min(100, (n / Math.max(1, limit)) * 100)}%`;
  const set = (p: Partial<typeof ai>) => saveSettings({ ai: { ...ai, ...p } });
  const compact = async () => {
    if (busy || compacting) return;
    if (!(await fitContext(true))) toast(t("ai.ctx.nothing"), "info");
  };
  const modes: { v: ContextMode; label: string }[] = [
    { v: "compact", label: t("ai.ctx.mode.compact") }, { v: "trim", label: t("ai.ctx.mode.trim") }, { v: "off", label: t("ai.ctx.mode.off") },
  ];

  return (
    <div className="ctx-wrap" ref={wrap}>
      <button className={"ctx-btn " + tone + (pop ? " on" : "")} onClick={() => setPop(!pop)} title={t("ai.ctx.tip", { used: fmtTokens(info.total), limit: fmtTokens(limit), pct: info.pct })}>
        {compacting
          ? <Loader2 size={15} className="spin" />
          : <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" className="ctx-track" /><circle cx="9" cy="9" r="7" className="ctx-fill" strokeDasharray={`${dash} ${C}`} transform="rotate(-90 9 9)" /></svg>}
        <span>{info.pct}%</span>
      </button>
      {pop && (
        <div className="ctx-pop" role="dialog" aria-label={t("ai.ctx.title")}>
          <div className="ctx-head"><b>{t("ai.ctx.title")}</b><span>{fmtTokens(info.total)} / {fmtTokens(limit)} · {info.pct}%</span></div>
          <div className="ctx-bar" aria-hidden="true"><i className="s" style={{ width: seg(info.system) }} /><i className="t" style={{ width: seg(info.tools) }} /><i className="c" style={{ width: seg(info.chat) }} /></div>
          <ul className="ctx-rows">
            <li><i className="s" />{t("ai.ctx.system")}<em>{fmtTokens(info.system)}</em></li>
            <li><i className="t" />{t("ai.ctx.tools")}<em>{fmtTokens(info.tools)}</em></li>
            <li><i className="c" />{t("ai.ctx.chat", { n: info.messages })}<em>{fmtTokens(info.chat)}</em></li>
          </ul>
          {lastInput > 0 && <div className="ctx-note">{t("ai.ctx.last", { n: fmtTokens(lastInput) })} · {t("ai.ctx.spent", { a: fmtTokens(usage.input), b: fmtTokens(usage.output) })}</div>}

          <div className="ctx-label">{t("ai.ctx.limit")}</div>
          <div className="ctx-chips">
            <button className={auto ? "on" : ""} onClick={() => set({ contextLimit: 0 })}>{t("ai.ctx.auto")}</button>
            {LIMIT_PRESETS.map((n) => <button key={n} className={ai.contextLimit === n ? "on" : ""} onClick={() => set({ contextLimit: n })}>{fmtTokens(n)}</button>)}
          </div>
          <div className="ctx-label">{t("ai.ctx.mode")}</div>
          <div className="ctx-chips col">
            {modes.map((m) => <button key={m.v} className={mode === m.v ? "on" : ""} onClick={() => set({ contextMode: m.v })}>{m.label}</button>)}
          </div>
          <button className="btn sm ctx-compact" onClick={compact} disabled={busy || compacting || history.length < 2}><Minimize2 size={13} />{t("ai.ctx.compactNow")}</button>
        </div>
      )}
    </div>
  );
}
