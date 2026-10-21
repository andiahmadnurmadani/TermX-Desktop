import { siAlmalinux, siAlpinelinux, siApple, siArchlinux, siCentos, siDebian, siDeepin, siElementary, siEndeavouros, siFedora, siFreebsd,
  siGentoo, siKalilinux, siLinux, siLinuxmint, siManjaro, siMxlinux, siNetbsd, siNixos, siOpenbsd, siOpensuse, siOpenwrt, siPopos,
  siRaspberrypi, siRedhat, siRockylinux, siSlackware, siUbuntu, siVoidlinux, siZorin, type SimpleIcon } from "simple-icons";
import { Server } from "lucide-react";
import type { Host } from "./api";

type Glyph = { path: string; hex: string; title: string };
const g = (i: SimpleIcon): Glyph => ({ path: i.path, hex: i.hex, title: i.title });
const WINDOWS: Glyph = { title: "Windows", hex: "0078D4", path: "M0 0h11.377v11.372H0zm12.623 0H24v11.372H12.623zM0 12.623h11.377V24H0zm12.623 0H24V24H12.623z" };

/** os-release `ID` (or our own "macos"/"windows"/"linux") -> logo. */
const BY_ID: Record<string, Glyph> = {
  ubuntu: g(siUbuntu), debian: g(siDebian), macos: g(siApple), darwin: g(siApple), windows: WINDOWS,
  centos: g(siCentos), fedora: g(siFedora), rhel: g(siRedhat), redhat: g(siRedhat), arch: g(siArchlinux), archarm: g(siArchlinux),
  alpine: g(siAlpinelinux), raspbian: g(siRaspberrypi), linuxmint: g(siLinuxmint), opensuse: g(siOpensuse), "opensuse-leap": g(siOpensuse),
  "opensuse-tumbleweed": g(siOpensuse), sles: g(siOpensuse), rocky: g(siRockylinux), almalinux: g(siAlmalinux), freebsd: g(siFreebsd),
  openbsd: g(siOpenbsd), netbsd: g(siNetbsd), kali: g(siKalilinux), manjaro: g(siManjaro), gentoo: g(siGentoo), nixos: g(siNixos),
  pop: g(siPopos), endeavouros: g(siEndeavouros), void: g(siVoidlinux), slackware: g(siSlackware), mx: g(siMxlinux), deepin: g(siDeepin),
  openwrt: g(siOpenwrt), elementary: g(siElementary), zorin: g(siZorin), linux: g(siLinux),
};
/** Pretty-name hints for distros that report a parent ID (e.g. Raspberry Pi OS says "debian"). */
const BY_NAME: [RegExp, Glyph][] = [
  [/raspberry|raspbian/i, g(siRaspberrypi)], [/ubuntu/i, g(siUbuntu)], [/debian/i, g(siDebian)], [/mac ?os|os x/i, g(siApple)],
  [/windows/i, WINDOWS], [/fedora/i, g(siFedora)], [/centos/i, g(siCentos)], [/red ?hat/i, g(siRedhat)], [/rocky/i, g(siRockylinux)],
  [/alma/i, g(siAlmalinux)], [/arch/i, g(siArchlinux)], [/alpine/i, g(siAlpinelinux)], [/suse/i, g(siOpensuse)], [/mint/i, g(siLinuxmint)],
  [/freebsd/i, g(siFreebsd)], [/linux/i, g(siLinux)],
];

export function osGlyph(host: Pick<Host, "osId" | "osName">): Glyph | null {
  const name = host.osName ?? "";
  // a more specific pretty name wins over a generic parent id
  if (/raspberry|raspbian/i.test(name)) return g(siRaspberrypi);
  const id = (host.osId ?? "").toLowerCase();
  if (id && BY_ID[id] && id !== "linux") return BY_ID[id];
  for (const [re, gl] of BY_NAME) if (re.test(name)) return gl;
  return id ? BY_ID[id] ?? g(siLinux) : null;
}

const luma = (hex: string) => {
  const n = parseInt(hex, 16);
  const [r, gg, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
};

/** Rounded tile with the host's OS logo; falls back to a server glyph in the host colour until the OS is known. */
export function OsIcon({ host, size = 38 }: { host: Pick<Host, "osId" | "osName">; size?: number }) {
  const gl = osGlyph(host);
  const px = Math.round(size * 0.5);
  if (!gl) return <div className="avatar" style={{ width: size, height: size }}><Server size={px} /></div>;
  const l = luma(gl.hex);
  // near-black brands (Apple, AlmaLinux, ...) follow the theme instead of disappearing on dark backgrounds
  const mono = l < 0.03;
  const style = mono
    ? { width: size, height: size, background: "var(--text)", color: "var(--bg)" }
    : { width: size, height: size, background: `#${gl.hex}`, color: l > 0.5 ? "#1a1a1a" : "#fff" };
  return (
    <div className="avatar os" style={style} title={host.osName ?? gl.title}>
      <svg viewBox="0 0 24 24" width={px} height={px} fill="currentColor" aria-hidden="true"><path d={gl.path} /></svg>
    </div>
  );
}
