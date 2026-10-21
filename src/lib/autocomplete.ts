/**
 * Terminal autocomplete (like Termius): suggestions from the commands you ran on that host,
 * your snippets and a small dictionary of common commands. History is kept per host and
 * stored encrypted in the vault.
 */
import { api, type Snippet } from "./api";

export interface Suggestion {
  /** Text that replaces what was typed. */
  text: string;
  kind: "history" | "snippet" | "common";
  /** Snippet name, for display. */
  label?: string;
}

interface Entry { c: string; n: number; t: number }
type Store = Record<string, Entry[]>;

const MAX_PER_HOST = 600;
let store: Store | null = null;
let loading: Promise<void> | null = null;
let saveTimer: number | undefined;

export function loadHistory(): Promise<void> {
  if (store) return Promise.resolve();
  loading ??= api.historyLoad()
    .then((raw) => { try { store = raw ? (JSON.parse(raw) as Store) : {}; } catch { store = {}; } })
    .catch(() => { store = {}; });
  return loading;
}

function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { if (store) api.historySave(JSON.stringify(store)).catch(() => {}); }, 1500);
}

/** Record a command the user ran (Enter) on a host. */
export function remember(hostId: string, command: string) {
  const c = command.replace(/\s+$/, "");
  // like HISTCONTROL=ignorespace: a leading space keeps it out of history
  if (!store || !c.trim() || c.startsWith(" ") || c.length > 400 || c.includes("\n")) return;
  const list = (store[hostId] ??= []);
  const e = list.find((x) => x.c === c);
  if (e) { e.n++; e.t = Date.now(); } else list.push({ c, n: 1, t: Date.now() });
  if (list.length > MAX_PER_HOST) {
    list.sort((a, b) => score(b) - score(a));
    list.length = MAX_PER_HOST;
  }
  persist();
}

export function forget(hostId: string, command: string) {
  if (!store?.[hostId]) return;
  store[hostId] = store[hostId].filter((x) => x.c !== command);
  persist();
}

export function clearHistory() {
  store = {};
  api.historySave("").catch(() => {});
}

/** Frequency, decaying with age (half-life about two weeks). */
function score(e: Entry) {
  const days = (Date.now() - e.t) / 86_400_000;
  return e.n * Math.pow(0.5, days / 14) + 0.5;
}

const COMMON = [
  "ls -lah", "cd ..", "pwd", "df -h", "df -hT -x tmpfs", "du -sh * | sort -h", "du -xh --max-depth=1 / 2>/dev/null | sort -h", "free -h", "uptime", "uname -a",
  "cat /etc/os-release", "top -b -n 1 | head -20", "htop", "ps aux --sort=-%cpu | head -15", "ps aux --sort=-%mem | head -15", "ss -tulpn", "netstat -tulpn",
  "ip -br a", "ip route", "ping -c 4 ", "curl -I ", "curl -sS ", "wget ", "dig +short ", "nslookup ", "traceroute ",
  "systemctl status ", "systemctl restart ", "systemctl reload ", "systemctl start ", "systemctl stop ", "systemctl enable --now ",
  "systemctl list-units --failed", "systemctl list-units --type=service --state=running", "systemctl daemon-reload",
  "journalctl -xe --no-pager | tail -50", "journalctl -u  --no-pager -n 100", "journalctl -p err -b --no-pager", "journalctl --disk-usage", "journalctl --vacuum-size=200M",
  "tail -n 100 -f ", "tail -n 200 /var/log/syslog", "less ", "grep -rn \"\" .", "find . -name \"\"", "find / -xdev -size +500M 2>/dev/null",
  "sudo -i", "sudo su -", "sudo apt update", "sudo apt upgrade -y", "sudo apt install ", "sudo apt autoremove -y", "apt list --upgradable",
  "sudo dnf update", "sudo dnf install ", "sudo yum install ", "sudo apk add ", "sudo pacman -Syu",
  "docker ps", "docker ps -a", "docker images", "docker logs -f --tail 100 ", "docker exec -it  sh", "docker stats --no-stream", "docker system df",
  "docker compose ps", "docker compose up -d", "docker compose down", "docker compose pull", "docker compose logs -f --tail 100", "docker compose restart",
  "kubectl get pods -A", "kubectl get nodes -o wide", "kubectl describe pod ", "kubectl logs -f ", "kubectl get svc -A",
  "git status", "git pull", "git log --oneline -20", "git diff", "git checkout ", "git branch -a",
  "nginx -t", "sudo nginx -t && sudo systemctl reload nginx", "certbot certificates", "sudo certbot renew --dry-run",
  "crontab -l", "crontab -e", "last -n 20", "who", "w", "id", "history | tail -50",
  "chmod +x ", "chown -R ", "mkdir -p ", "cp -a ", "mv ", "rm -i ", "tar -czf  .", "tar -xzf ", "unzip ", "scp ", "rsync -avz --progress ",
  "ssh-keygen -t ed25519 -C \"\"", "ssh-copy-id ", "cat ~/.ssh/authorized_keys", "lsblk", "mount | column -t", "sensors", "vmstat 1 5", "iostat -xz 1 3",
  "zpool status", "zfs list", "pveversion", "qm list", "pct list",
];

/**
 * Suggestions for what has been typed so far. History first (best match by score), then snippets,
 * then common commands. Never suggests exactly what is already typed.
 */
export function suggest(hostId: string, typed: string, snippets: Snippet[], limit = 7): Suggestion[] {
  const q = typed.replace(/^\s+/, "");
  if (q.length < 2) return [];
  const ql = q.toLowerCase();
  const seen = new Set<string>([q]);
  const out: Suggestion[] = [];
  const push = (s: Suggestion) => { if (!seen.has(s.text) && out.length < limit) { seen.add(s.text); out.push(s); } };

  const hist = (store?.[hostId] ?? []).filter((e) => e.c.startsWith(q)).sort((a, b) => score(b) - score(a));
  hist.slice(0, 5).forEach((e) => push({ text: e.c, kind: "history" }));
  for (const sn of snippets) {
    const one = sn.command.includes("\n") ? null : sn.command;
    if (!one) continue;
    if (one.startsWith(q) || sn.name.toLowerCase().startsWith(ql)) push({ text: one, kind: "snippet", label: sn.name });
  }
  // other hosts' history: same command often works elsewhere
  if (out.length < limit && store) {
    const other = new Map<string, number>();
    for (const [h, list] of Object.entries(store)) if (h !== hostId) for (const e of list) if (e.c.startsWith(q)) other.set(e.c, (other.get(e.c) ?? 0) + score(e));
    [...other.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([c]) => push({ text: c, kind: "history" }));
  }
  for (const c of COMMON) if (c.startsWith(q)) push({ text: c, kind: "common" });
  return out;
}
