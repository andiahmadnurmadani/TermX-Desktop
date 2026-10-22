import { useEffect, useRef, useState, type ReactNode } from "react";
import { SquareTerminal, Terminal } from "lucide-react";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import type { ShellInfo } from "../lib/api";

/**
 * Button that opens a local terminal. When this computer has more than one shell (Windows: PowerShell, cmd and
 * every WSL distro) it opens a small menu first; otherwise it starts the default shell right away.
 */
export function LocalShellButton({ className, style, title, children }: { className?: string; style?: React.CSSProperties; title?: string; children: ReactNode }) {
  const t = useT();
  const shells = useStore((s) => s.shells);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".shell-menu")) close(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); window.removeEventListener("blur", close); window.removeEventListener("resize", close); };
  }, [pos]);

  const click = () => {
    if (shells.length < 2) { useStore.getState().openLocal(); return; }
    const r = btn.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(r.left, window.innerWidth - 248)), y: r.bottom + 6 });
  };
  const pick = (s: ShellInfo, i: number) => { setPos(null); useStore.getState().openLocal(i === 0 ? undefined : s); };

  return (
    <>
      <button ref={btn} className={className} style={style} title={title} onClick={click}>{children}</button>
      {pos && (
        <div className="shell-menu" style={{ left: pos.x, top: pos.y }} role="menu">
          <div className="shell-menu-h">{t("term.pickShell")}</div>
          {shells.map((s, i) => (
            <button key={s.id} className="shell-item" role="menuitem" onClick={() => pick(s, i)} autoFocus={i === 0}>
              {s.kind === "wsl" ? <Terminal size={14} /> : <SquareTerminal size={14} />}
              <span className="shell-name">{s.name}</span>
              {s.kind === "wsl" && <span className="shell-tag">WSL</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
