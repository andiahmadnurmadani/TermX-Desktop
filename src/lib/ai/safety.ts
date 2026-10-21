/**
 * Classifies shell commands for the AI approval policy. "Read-only" is deliberately conservative:
 * anything not recognised needs the user's approval.
 */

const READ_ONLY = new Set([
  "ls", "ll", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "column", "nl",
  "df", "du", "free", "uptime", "uname", "whoami", "id", "hostname", "hostnamectl", "ps", "pgrep", "pstree", "ss", "netstat",
  "lsblk", "lscpu", "lsmem", "lspci", "lsusb", "lsof", "blkid", "findmnt", "date", "timedatectl", "pwd", "echo", "printf",
  "which", "type", "whereis", "stat", "file", "readlink", "realpath", "basename", "dirname", "env", "printenv", "locale",
  "vmstat", "iostat", "mpstat", "sar", "nproc", "getent", "last", "lastlog", "w", "who", "users", "groups", "dmesg",
  "journalctl", "md5sum", "sha1sum", "sha256sum", "dig", "nslookup", "host", "ping", "traceroute", "tracepath", "mtr",
  "jq", "yq", "awk", "sed", "less", "more", "tree", "true", "test", "[", "sleep", "seq", "diff", "cmp", "zcat", "zgrep",
  "nginx", "apachectl", "sw_vers", "system_profiler", "vm_stat", "sysctl", "top", "htop", "ip", "ifconfig", "route",
  "arp", "iwconfig", "sensors", "smartctl", "zpool", "zfs", "pveversion", "qm", "pct", "pvesm", "crontab", "getenforce",
  "ufw", "iptables", "nft", "firewall-cmd", "mount", "swapon", "cal", "id", "groups", "openssl", "curl", "wget",
  "systemctl", "service", "docker", "podman", "kubectl", "helm", "git", "apt", "apt-cache", "dpkg", "dpkg-query", "rpm",
  "yum", "dnf", "apk", "brew", "snap", "flatpak", "pip", "pip3", "npm", "node", "python", "python3", "php", "java",
  "go", "ruby", "perl", "composer", "cargo", "rustc", "psql", "mysql", "redis-cli", "lsb_release",
]);

/** For multi-purpose tools: the subcommands (or flags) that only read. */
const READ_SUB: Record<string, RegExp> = {
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-sockets|show|cat|--version|--failed)\b/,
  service: /^\S+\s+status\b|^--status-all\b/,
  docker: /^(ps|images|logs|inspect|stats\s+--no-stream|version|info|top|port|network\s+(ls|inspect)|volume\s+(ls|inspect)|compose\s+(ps|logs|ls|config|images))\b/,
  podman: /^(ps|images|logs|inspect|version|info|top|port)\b/,
  kubectl: /^(get|describe|logs|top|version|explain|api-resources|cluster-info|config\s+(view|get-contexts|current-context))\b/,
  helm: /^(list|ls|status|get|history|version|show|search)\b/,
  git: /^(status|log|diff|show|branch|remote|tag|describe|rev-parse|ls-files|blame|shortlog|config\s+(--get|-l|--list))\b/,
  apt: /^(list|show|search|policy)\b/,
  "apt-cache": /^(policy|show|search|depends|rdepends)\b/,
  dpkg: /^(-l|-L|-s|--list|--status|--listfiles|-S|--search)\b/,
  rpm: /^-q/,
  yum: /^(list|info|search|history|repolist)\b/,
  dnf: /^(list|info|search|history|repolist)\b/,
  apk: /^(info|list|search|policy)\b/,
  brew: /^(list|info|search|outdated|config|doctor|--version)\b/,
  snap: /^(list|info|find|version)\b/,
  flatpak: /^(list|info|search)\b/,
  pip: /^(list|show|freeze|--version|-V)\b/,
  pip3: /^(list|show|freeze|--version|-V)\b/,
  npm: /^(ls|list|view|outdated|-v|--version|config\s+(get|list))\b/,
  cargo: /^(--version|-V|tree|metadata)\b/,
  ip: /^(-\w+\s+)*(a|addr|address|r|route|l|link|n|neigh|neighbour|rule|-s)(\s+(show|list|ls))?\b/,
  ufw: /^(status)\b/,
  iptables: /^(-L|-S|--list|-nL|-nvL|-vnL)\b/,
  nft: /^(list)\b/,
  "firewall-cmd": /^(--list|--state|--get)/,
  zpool: /^(status|list|iostat|history|get)\b/,
  zfs: /^(list|get)\b/,
  qm: /^(list|status|config)\b/,
  pct: /^(list|status|config)\b/,
  pvesm: /^(status|list)\b/,
  crontab: /^-l\b/,
  nginx: /^(-t|-T|-v|-V)\b/,
  apachectl: /^(-t|-S|-M|-v|configtest)\b/,
  openssl: /^(x509|s_client|version|req\s+-text|verify)\b/,
  // interpreters only for version checks
  node: /^(-v|--version)\b/, python: /^(-V|--version)\b/, python3: /^(-V|--version)\b/, php: /^(-v|--version|-m)\b/,
  java: /^(-version|--version)\b/, go: /^(version|env)\b/, ruby: /^(-v|--version)\b/, perl: /^(-v|--version)\b/,
  composer: /^(--version|-V|show)\b/, rustc: /^(-V|--version)\b/,
  // network tools: plain GETs only
  curl: /^(?!.*(\s-X\s*(?!GET)|\s--request\s+(?!GET)|\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload|\s-o\b|\s-O\b|\s--output)).*/,
  wget: /^(-q\s+)?(-O\s*-|--spider|-qO-|-qO\s*-)/,
  // DB clients only with an inline read query is too hard to judge: ask
  psql: /^--version\b/, mysql: /^--version\b/, "redis-cli": /^(ping|info|--version)\b/i,
  mount: /^$/, swapon: /^(--show|-s)?$/, sysctl: /^(-a|-n\s|\S+$)/, top: /^-b/, htop: /^$/, smartctl: /^(-a|-i|-H|--all|--info|--health)\b/,
  sed: /^(?!.*(\s|^)(-i|--in-place)).*$/,
  awk: /^(?!.*\bsystem\s*\().*$/,
  find: /^(?!.*\s-(delete|exec|execdir|ok|okdir|fprint|fls)\b).*$/,
  dmesg: /^(?!.*(-c|-C|--clear)\b).*$/,
  hostnamectl: /^(status)?$/,
  timedatectl: /^(status|show)?$/,
  date: /^(?!.*\s-s\b|.*--set).*/,
  route: /^(-n)?$/,
};
READ_ONLY.add("find");

/** Split a command line into simple commands on ; && || | and newlines (quotes respected). */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if (c === "&" && cmd[i + 1] !== "&" && cmd[i - 1] !== "&" && cmd[i - 1] !== ">") { cur += c; continue; }
      out.push(cur); cur = ""; continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** True when every part of the command only reads state. */
export function isReadOnly(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // command substitution, redirection to files, here-docs, backgrounding: ask
  if (/`|\$\(|<<|<\(|>\(/.test(cmd)) return false;
  const noDevNull = cmd.replace(/\d?>\s*\/dev\/null|\d?>&\d|&>\s*\/dev\/null/g, "");
  if (/>/.test(noDevNull)) return false;
  for (const seg of segments(cmd)) {
    const words = seg.replace(/^(\w+=\S*\s+)+/, "").split(/\s+/);
    let name = words[0];
    if (name === "sudo" || name === "doas" || name === "su") return false;
    if (name === "timeout" || name === "nice" || name === "watch") { words.shift(); while (words[0]?.startsWith("-") || /^\d/.test(words[0] ?? "")) words.shift(); name = words[0]; }
    name = (name ?? "").split("/").pop() ?? "";
    if (!READ_ONLY.has(name)) return false;
    const rest = words.slice(1).join(" ");
    const sub = READ_SUB[name];
    if (sub && !sub.test(rest)) return false;
    if (name === "tail" && /(^|\s)-\w*f/.test(rest)) return false; // follows forever
    if (name === "journalctl" && /(^|\s)(-f|--follow|--vacuum|--rotate|--flush)/.test(rest)) return false;
    if ((name === "ping") && !/(^|\s)-c\s*\d/.test(rest)) return false; // never stops on Linux
  }
  return true;
}

/** Commands worth an extra warning in the approval card. */
export function riskNote(command: string): string | null {
  const c = command;
  if (/\brm\s+(-\w*[rf]\w*\s+)+/.test(c)) return "Deletes files";
  if (/\b(mkfs|fdisk|parted|wipefs|dd)\b/.test(c)) return "Writes to disks";
  if (/\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/.test(c)) return "Restarts or stops the machine";
  if (/\b(drop\s+(table|database)|truncate\s+table)\b/i.test(c)) return "Destroys database data";
  if (/\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/.test(c)) return "Changes permissions recursively";
  if (/\bsystemctl\s+(stop|restart|disable|mask)\b|\bservice\s+\S+\s+(stop|restart)\b/.test(c)) return "Stops or restarts a service";
  if (/\b(kill|pkill|killall)\b/.test(c)) return "Kills processes";
  if (/curl[^|]*\|\s*(sudo\s+)?(ba)?sh\b|wget[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(c)) return "Runs a script from the internet";
  if (/\b(iptables|ufw|nft|firewall-cmd)\b/.test(c) && !isReadOnly(c)) return "Changes the firewall";
  return null;
}

/** Read-only but expensive: whole-filesystem scans and the like. On production these still ask. */
export function isHeavy(command: string): boolean {
  const c = command.replace(/\s+/g, " ");
  if (/\b(find|du|grep -r|grep -R|rg|ls -R|tree)\b[^|;&]*\s\/(\s|$|\*)/.test(c) && !/(-maxdepth|--max-depth|-d\s?\d|-xdev)/.test(c)) return true;
  if (/\b(zgrep|grep)\b[^|;&]*\/var\/log\/?(\s|$|\*)/.test(c) && /\s-\w*r/.test(c)) return true;
  if (/\bjournalctl\b/.test(c) && !/(-n|--lines|--since|-S|-b|-u)\b/.test(c)) return true;
  if (/\b(docker|podman) logs\b/.test(c) && !/(--tail|-n|--since)\b/.test(c)) return true;
  return false;
}

/** Commands that can destroy a machine in one go. Even in "always" mode these wait for the user. */
export function isCatastrophic(command: string): boolean {
  const c = command.replace(/\s+/g, " ");
  if (/\brm\s+(-\w*\s+)*-\w*[rR]\w*\s+(-\w*\s+)*(--no-preserve-root\s+)?(\/|\/\*|~|\$HOME|\/(etc|usr|var|boot|home|root|bin|lib|opt|srv))\/?(\s|$|;|&)/.test(c)) return true;
  if (/\b(mkfs(\.\w+)?|wipefs|fdisk|sfdisk|parted|sgdisk)\b/.test(c)) return true;
  if (/\bdd\b[^|;&]*\bof=\/dev\//.test(c)) return true;
  if (/>\s*\/dev\/(sd|nvme|vd|xvd|hd|mmcblk)/.test(c)) return true;
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(c)) return true;
  if (/\bchmod\s+(-\w+\s+)*-R\s+\S*\s+\/(\s|$)|\bchown\s+(-\w+\s+)*-R\s+\S+\s+\/(\s|$)/.test(c)) return true;
  if (/\b(drop\s+database|drop\s+schema)\b/i.test(c)) return true;
  return false;
}
