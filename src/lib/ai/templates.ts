/**
 * Built-in prompt templates for TermX AI. `{host}` becomes the host in context; `[…]` marks a
 * part the user fills in (the composer selects the first one after inserting).
 */

export interface PromptTemplate {
  id: string;
  cat: "diagnose" | "perf" | "logs" | "security" | "docker" | "web" | "maint" | "local";
  icon: string;
  en: { name: string; prompt: string };
  id_: { name: string; prompt: string };
}

export const TEMPLATE_CATS: Record<PromptTemplate["cat"], { en: string; id: string }> = {
  diagnose: { en: "Diagnose", id: "Diagnosa" },
  perf: { en: "Performance", id: "Performa" },
  logs: { en: "Logs", id: "Log" },
  security: { en: "Security", id: "Keamanan" },
  docker: { en: "Containers", id: "Container" },
  web: { en: "Web & network", id: "Web & jaringan" },
  maint: { en: "Maintenance", id: "Perawatan" },
  local: { en: "This computer", id: "Komputer ini" },
};

export const TEMPLATES: PromptTemplate[] = [
  { id: "health", cat: "diagnose", icon: "activity",
    en: { name: "Full health check", prompt: "Run a full health check on {host}: OS and uptime, load vs CPU count, memory and swap, disk space and inodes on every mount, failed systemd units, and the last errors in the system log. Finish with a short table of what is OK, what needs attention, and what you recommend, in order of priority. Do not change anything." },
    id_: { name: "Cek kesehatan lengkap", prompt: "Lakukan cek kesehatan lengkap di {host}: OS dan uptime, load dibanding jumlah CPU, memori dan swap, ruang disk dan inode di setiap mount, unit systemd yang gagal, dan error terakhir di log sistem. Akhiri dengan tabel singkat: apa yang aman, apa yang perlu perhatian, dan rekomendasi Anda berurutan sesuai prioritas. Jangan ubah apa pun." } },
  { id: "why-slow", cat: "perf", icon: "gauge",
    en: { name: "Why is it slow?", prompt: "{host} feels slow. Find out why: check load and CPU steal, the top processes by CPU and memory, swap activity, disk I/O wait and the busiest devices, and network connections. Explain the most likely cause in plain words and suggest fixes, but ask before changing anything." },
    id_: { name: "Kenapa lambat?", prompt: "{host} terasa lambat. Cari tahu penyebabnya: cek load dan CPU steal, proses teratas berdasarkan CPU dan memori, aktivitas swap, I/O wait dan disk tersibuk, serta koneksi jaringan. Jelaskan penyebab yang paling mungkin dengan bahasa sederhana dan sarankan perbaikan, tapi tanya dulu sebelum mengubah apa pun." } },
  { id: "disk", cat: "maint", icon: "hard-drive",
    en: { name: "Free up disk space", prompt: "Disk space on {host} is running low. Find what is using the most space (largest directories and files, old logs, journal size, package caches, Docker images and volumes if Docker is installed). List what is safe to clean and how much each frees, then ask me which ones to remove." },
    id_: { name: "Kosongkan ruang disk", prompt: "Ruang disk di {host} hampir penuh. Cari apa yang paling banyak memakan ruang (direktori dan file terbesar, log lama, ukuran journal, cache paket, image dan volume Docker bila ada). Daftarkan yang aman dibersihkan beserta berapa ruang yang dibebaskan, lalu tanya saya mana yang dihapus." } },
  { id: "errors", cat: "logs", icon: "scroll",
    en: { name: "Recent errors", prompt: "Show me the errors and warnings on {host} from the last 24 hours (journalctl with priority err and warning, plus the kernel log). Group repeated messages, count them, explain what each group means and whether it needs action." },
    id_: { name: "Error terbaru", prompt: "Tampilkan error dan warning di {host} dalam 24 jam terakhir (journalctl dengan prioritas err dan warning, ditambah log kernel). Kelompokkan pesan yang berulang, hitung jumlahnya, jelaskan arti tiap kelompok dan apakah perlu ditindaklanjuti." } },
  { id: "service", cat: "logs", icon: "server",
    en: { name: "Debug a service", prompt: "The service [service name] on {host} is not working. Check its status, its unit file, the last 100 lines of its logs, the ports it should listen on and its config test if it has one. Tell me the root cause and the exact fix; ask before restarting it." },
    id_: { name: "Debug sebuah service", prompt: "Service [nama service] di {host} tidak berjalan. Cek statusnya, unit file-nya, 100 baris log terakhir, port yang seharusnya dibuka, dan uji konfigurasinya bila ada. Beri tahu akar masalah dan perbaikan yang tepat; tanya dulu sebelum me-restart." } },
  { id: "audit", cat: "security", icon: "shield",
    en: { name: "Security audit", prompt: "Do a read-only security review of {host}: SSH config (root login, password auth), users with a login shell and sudo rights, listening ports and which process owns each, firewall status, pending security updates, and failed login attempts. Rate each finding (high / medium / low) and give the fix for each. Change nothing." },
    id_: { name: "Audit keamanan", prompt: "Lakukan tinjauan keamanan baca-saja di {host}: konfigurasi SSH (login root, auth password), user dengan shell login dan hak sudo, port yang terbuka dan proses pemiliknya, status firewall, update keamanan yang tertunda, dan percobaan login gagal. Beri tingkat untuk tiap temuan (tinggi / sedang / rendah) dan perbaikannya. Jangan ubah apa pun." } },
  { id: "logins", cat: "security", icon: "key",
    en: { name: "Who logged in?", prompt: "Who has logged in to {host} recently? Show successful and failed SSH logins from the last 7 days, the source IPs, and anything that looks like a brute-force attempt." },
    id_: { name: "Siapa yang login?", prompt: "Siapa saja yang login ke {host} baru-baru ini? Tampilkan login SSH yang berhasil dan gagal dalam 7 hari terakhir, IP asalnya, dan apa pun yang terlihat seperti brute-force." } },
  { id: "containers", cat: "docker", icon: "box",
    en: { name: "Container status", prompt: "List the Docker (or Podman) containers on {host} with their state, health, restarts, uptime, ports and resource use. For any container that is unhealthy, restarting or exited, show its last logs and explain why." },
    id_: { name: "Status container", prompt: "Daftarkan container Docker (atau Podman) di {host} beserta status, health, jumlah restart, uptime, port, dan pemakaian resource. Untuk container yang unhealthy, terus restart, atau mati, tampilkan log terakhirnya dan jelaskan penyebabnya." } },
  { id: "compose", cat: "docker", icon: "layers",
    en: { name: "Update a compose stack", prompt: "On {host}, update the Docker Compose stack in [directory]: show what is running now, pull newer images, show which ones changed, then (after I approve) recreate only the changed services and check they come back healthy." },
    id_: { name: "Update stack compose", prompt: "Di {host}, update stack Docker Compose di [direktori]: tampilkan yang berjalan sekarang, pull image terbaru, tunjukkan mana yang berubah, lalu (setelah saya setujui) buat ulang hanya service yang berubah dan pastikan kembali sehat." } },
  { id: "nginx", cat: "web", icon: "globe",
    en: { name: "Web server check", prompt: "Check the web server on {host} (nginx, Apache or Caddy, whichever is installed): config test, enabled sites and their domains, TLS certificate expiry dates, recent 5xx errors in the access and error logs, and whether ports 80/443 answer locally." },
    id_: { name: "Cek web server", prompt: "Cek web server di {host} (nginx, Apache, atau Caddy, mana yang terpasang): uji konfigurasi, situs yang aktif beserta domainnya, tanggal kedaluwarsa sertifikat TLS, error 5xx terbaru di access log dan error log, dan apakah port 80/443 merespons secara lokal." } },
  { id: "ports", cat: "web", icon: "network",
    en: { name: "Ports & connections", prompt: "On {host}, list every listening port with the process behind it and whether it is reachable from outside (bound to 0.0.0.0 / :: vs localhost). Then summarise the established connections by remote address. Flag anything unexpected." },
    id_: { name: "Port & koneksi", prompt: "Di {host}, daftarkan setiap port yang listening beserta prosesnya dan apakah bisa diakses dari luar (bind ke 0.0.0.0 / :: atau hanya localhost). Lalu ringkas koneksi aktif berdasarkan alamat tujuan. Tandai apa pun yang tidak wajar." } },
  { id: "updates", cat: "maint", icon: "download",
    en: { name: "Pending updates", prompt: "Check pending package updates on {host} using its package manager. Separate security updates from the rest, say whether a reboot will be needed (kernel, libc, systemd), and ask me before installing anything." },
    id_: { name: "Update tertunda", prompt: "Cek update paket yang tertunda di {host} memakai package manager-nya. Pisahkan update keamanan dari yang lain, sebutkan apakah perlu reboot (kernel, libc, systemd), dan tanya saya sebelum memasang apa pun." } },
  { id: "cron", cat: "maint", icon: "clock",
    en: { name: "Scheduled jobs", prompt: "List all scheduled jobs on {host}: user crontabs, /etc/cron.*, and systemd timers with their next and last run. Explain in plain words what each one does and flag any that failed last time." },
    id_: { name: "Job terjadwal", prompt: "Daftarkan semua job terjadwal di {host}: crontab user, /etc/cron.*, dan systemd timer beserta jadwal berikutnya dan terakhir. Jelaskan dengan bahasa sederhana fungsi masing-masing dan tandai yang gagal terakhir kali." } },
  { id: "fleet", cat: "diagnose", icon: "servers",
    en: { name: "Fleet summary", prompt: "Give me a summary of all my hosts: for each one show uptime, load, memory and the fullest disk (use host_overview, skip hosts that do not answer within the timeout). Put it in one table and point out the three that need attention most." },
    id_: { name: "Ringkasan semua server", prompt: "Beri ringkasan semua server saya: untuk tiap server tampilkan uptime, load, memori, dan disk yang paling penuh (pakai host_overview, lewati server yang tidak merespons). Sajikan dalam satu tabel dan sebutkan tiga yang paling perlu perhatian." } },
  { id: "explain", cat: "diagnose", icon: "help",
    en: { name: "Explain this output", prompt: "Explain what is on my terminal screen right now: what the command did, what the output means, and whether anything in it is a problem. If there is an error, tell me how to fix it." },
    id_: { name: "Jelaskan output ini", prompt: "Jelaskan apa yang ada di layar terminal saya sekarang: apa yang dilakukan perintahnya, arti outputnya, dan apakah ada masalah di dalamnya. Bila ada error, beri tahu cara memperbaikinya." } },
  { id: "script", cat: "maint", icon: "code",
    en: { name: "Write a script", prompt: "Write a safe, commented bash script for {host} that [what it should do]. Use set -euo pipefail, check prerequisites first, and make it idempotent. Show the script, explain how to run it, and offer to save it as a snippet." },
    id_: { name: "Buat script", prompt: "Tulis script bash yang aman dan berkomentar untuk {host} yang [apa yang harus dilakukan]. Gunakan set -euo pipefail, cek prasyarat dulu, dan buat idempoten. Tampilkan script-nya, jelaskan cara menjalankannya, dan tawarkan untuk menyimpannya sebagai snippet." } },
  { id: "ssh-key", cat: "local", icon: "key",
    en: { name: "Set up an SSH key", prompt: "On this computer (local shell), check whether I already have an SSH key. If not, create an ed25519 key with a comment of my user and hostname. Then explain how to add it to {host} with TermX (Keys page) or ssh-copy-id." },
    id_: { name: "Siapkan SSH key", prompt: "Di komputer ini (shell lokal), cek apakah saya sudah punya SSH key. Bila belum, buat key ed25519 dengan komentar user dan hostname saya. Lalu jelaskan cara memasangnya ke {host} lewat TermX (halaman Keys) atau ssh-copy-id." } },
  { id: "reach", cat: "local", icon: "network",
    en: { name: "Can't connect to a host", prompt: "I cannot connect to {host}. From this computer (local shell), check DNS resolution, ping (with -c), whether the SSH port answers (nc or Test-NetConnection on Windows), and the route. Tell me where it breaks and what to try." },
    id_: { name: "Tidak bisa konek ke server", prompt: "Saya tidak bisa konek ke {host}. Dari komputer ini (shell lokal), cek resolusi DNS, ping (dengan -c), apakah port SSH merespons (nc, atau Test-NetConnection di Windows), dan rutenya. Beri tahu di mana putusnya dan apa yang perlu dicoba." } },
];

export function tplText(t: PromptTemplate, lang: string) {
  return lang === "id" ? t.id_ : t.en;
}

/** Fill `{host}`; returns the text and the range of the first `[…]` placeholder, if any. */
export function fillTemplate(prompt: string, host: string | null, lang: string): { text: string; sel: [number, number] | null } {
  const fallback = lang === "id" ? "[server]" : "[host]";
  const text = prompt.replace(/\{host\}/g, host ?? fallback);
  const m = /\[[^\]]+\]/.exec(text);
  return { text, sel: m ? [m.index, m.index + m[0].length] : null };
}
