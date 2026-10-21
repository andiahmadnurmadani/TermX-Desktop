import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Info, X } from "lucide-react";
import { useStore } from "../lib/store";
import { useDialogs } from "../lib/dialogs";
import { useT } from "../lib/i18n";

export function Switch({ on, onChange }: { on: boolean; onChange: (b: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)} />;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} type="button" className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function PasswordInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input className="input" type={show ? "text" : "password"} value={value} placeholder={placeholder} autoFocus={autoFocus}
        autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="icon-btn" tabIndex={-1} aria-label={show ? "Hide" : "Show"} title={show ? "Hide" : "Show"} onMouseDown={(e) => e.preventDefault()} onClick={() => setShow(!show)}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
    </div>
  );
}

export function Modal({ children, onClose, wide, className }: { children: ReactNode; onClose?: () => void; wide?: boolean; className?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && onClose) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal${wide ? " wide" : ""} ${className ?? ""}`} role="dialog">{children}</div>
    </div>
  );
}

export function Drawer({ title, children, footer, onClose }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} />
      <aside className="drawer" role="dialog">
        <header>{title}<button className="icon-btn" onClick={onClose}><X size={16} /></button></header>
        <div className="body">{children}</div>
        <footer>{footer}</footer>
      </aside>
    </>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ico">{icon}</div>
      <h3>{title}</h3>
      <div>{body}</div>
      {action}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>
          {t.kind === "error" ? <AlertTriangle size={15} /> : t.kind === "ok" ? <CheckCircle2 size={15} /> : <Info size={15} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Mount once: renders promise-based confirm()/prompt() dialogs. */
export function DialogHost() {
  const t = useT();
  const { confirm, prompt } = useDialogs();
  const [val, setVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (prompt) { setVal(prompt.initial); setTimeout(() => ref.current?.select(), 30); } }, [prompt]);
  if (confirm) {
    const done = (b: boolean) => { confirm.resolve(b); useDialogs.setState({ confirm: null }); };
    return (
      <Modal onClose={() => done(false)}>
        <p style={{ color: "var(--text)", marginBottom: 0 }}>{confirm.text}</p>
        <div className="actions">
          <button className="btn" onClick={() => done(false)}>{t("common.cancel")}</button>
          <button className={"btn " + (confirm.danger ? "danger solid" : "primary")} autoFocus onClick={() => done(true)}>{confirm.danger ? t("common.delete") : t("common.confirm")}</button>
        </div>
      </Modal>
    );
  }
  if (prompt) {
    const done = (s: string | null) => { prompt.resolve(s); useDialogs.setState({ prompt: null }); };
    return (
      <Modal onClose={() => done(null)}>
        <form onSubmit={(e) => { e.preventDefault(); if (val.trim()) done(val.trim()); }}>
          <h3>{prompt.title}</h3>
          <input ref={ref} className="input" value={val} onChange={(e) => setVal(e.target.value)} autoFocus spellCheck={false} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => done(null)}>{t("common.cancel")}</button>
            <button type="submit" className="btn primary" disabled={!val.trim()}>{t("common.save")}</button>
          </div>
        </form>
      </Modal>
    );
  }
  return null;
}

export interface MenuItem { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void; sep?: boolean }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); window.removeEventListener("keydown", esc); };
  }, [x, y, onClose]);
  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) => it.sep ? <hr key={i} /> : (
        <button key={i} className={it.danger ? "danger" : ""} onClick={() => { onClose(); it.onClick(); }}>{it.icon}{it.label}</button>
      ))}
    </div>
  );
}
