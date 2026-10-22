import { useEffect, useMemo, useRef, useState } from "react";
import { History, MessageSquare, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { useAi } from "../lib/ai/agent";
import { clearSessions, newSession, removeSession, renameSession, switchTo, useSessions, type ChatSession } from "../lib/ai/sessions";

function ago(at: number, lang: string): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === "id" ? "id" : "en", { numeric: "auto", style: "narrow" });
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  if (s < 86400 * 30) return rtf.format(-Math.floor(s / 86400), "day");
  return new Date(at).toLocaleDateString(lang === "id" ? "id-ID" : "en-US", { month: "short", day: "numeric" });
}

/** Header button + pop-over to switch between, rename and delete saved AI chats. */
export function SessionsMenu() {
  const t = useT();
  const lang = useStore((s) => s.vault?.settings.language) ?? "en";
  const { sessions, activeId } = useSessions();
  const busy = useAi((s) => s.busy);
  const [pop, setPop] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pop) return;
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setPop(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); if (editing) setEditing(null); else setPop(false); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [pop, editing]);
  useEffect(() => { if (!pop) { setQ(""); setEditing(null); setConfirm(null); } }, [pop]);
  useEffect(() => { if (!confirm) return; const id = window.setTimeout(() => setConfirm(null), 3000); return () => window.clearTimeout(id); }, [confirm]);

  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    const byTime = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    return n ? byTime.filter((s) => s.title.toLowerCase().includes(n)) : byTime;
  }, [sessions, q]);

  const open = (s: ChatSession) => { if (s.id !== activeId) void switchTo(s.id); setPop(false); };
  const commit = (id: string) => { renameSession(id, draft); setEditing(null); };
  const msgs = (s: ChatSession) => s.history.filter((m) => m.role === "user" && m.content.some((p) => p.type === "text")).length;

  return (
    <div className="sess-wrap" ref={wrap}>
      <button className={"icon-btn" + (pop ? " on" : "")} title={t("ai.sess.title")} onClick={() => setPop(!pop)}><History size={15} /></button>
      {pop && (
        <div className="sess-pop" role="dialog" aria-label={t("ai.sess.title")}>
          <div className="sess-head">
            <b>{t("ai.sess.title")}</b>
            <button className="btn sm" disabled={!useAi.getState().history.length && !busy} onClick={() => { void newSession(); setPop(false); }}><Plus size={13} />{t("ai.newChat")}</button>
          </div>
          {sessions.length > 5 && (
            <label className="sess-search"><Search size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ai.sess.search")} spellCheck={false} /></label>
          )}
          <ul className="sess-list">
            {list.map((s) => (
              <li key={s.id} className={s.id === activeId ? "on" : ""}>
                {editing === s.id ? (
                  <input className="sess-edit" autoFocus value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} onBlur={() => commit(s.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(s.id); }} />
                ) : (
                  <button className="sess-main" onClick={() => open(s)} onDoubleClick={() => { setEditing(s.id); setDraft(s.title); }}>
                    <MessageSquare size={13} />
                    <span className="sess-t"><span className="sess-name">{s.title}</span><span className="sess-meta">{t("ai.sess.msgs", { n: msgs(s) })} · {ago(s.updatedAt, lang)}</span></span>
                  </button>
                )}
                {editing !== s.id && (
                  <span className="sess-act">
                    <button className="icon-btn sm" title={t("ai.sess.rename")} onClick={() => { setEditing(s.id); setDraft(s.title); }}><Pencil size={12} /></button>
                    {confirm === s.id
                      ? <button className="sess-del" onClick={() => { setConfirm(null); void removeSession(s.id); }}>{t("ai.sess.confirm")}</button>
                      : <button className="icon-btn sm" title={t("ai.sess.delete")} onClick={() => setConfirm(s.id)}><Trash2 size={12} /></button>}
                  </span>
                )}
              </li>
            ))}
            {!list.length && <li className="sess-empty">{q ? t("ai.sess.noMatch") : t("ai.sess.empty")}</li>}
          </ul>
          {sessions.length > 0 && (
            <div className="sess-foot">
              <span>{t("ai.sess.count", { n: sessions.length })}</span>
              {confirm === "*"
                ? <button className="sess-del" onClick={() => { setConfirm(null); void clearSessions(); setPop(false); }}>{t("ai.sess.clearConfirm")}</button>
                : <button className="link-btn" onClick={() => setConfirm("*")}>{t("ai.sess.clear")}</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
