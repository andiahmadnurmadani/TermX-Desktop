//! Agentless host overview: one read-only POSIX shell script over SSH, parsed into numbers.
//! Works on Linux (procfs) and macOS/BSD (sysctl); anything missing is simply left empty.
use serde::Serialize;

pub const SCRIPT: &str = r#"
if [ -r /etc/os-release ]; then echo "os=$(. /etc/os-release; echo "${PRETTY_NAME:-$NAME}")"
elif command -v sw_vers >/dev/null 2>&1; then echo "os=$(sw_vers -productName) $(sw_vers -productVersion)"
else echo "os=$(uname -s 2>/dev/null)"; fi
echo "kernel=$(uname -r 2>/dev/null)"
if [ -r /proc/uptime ]; then echo "uptime=$(cut -d' ' -f1 /proc/uptime)"; else
  b=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ *sec = \([0-9]*\).*/\1/p'); [ -n "$b" ] && echo "uptime=$(( $(date +%s) - b ))"; fi
if [ -r /proc/loadavg ]; then echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"; else echo "load=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"; fi
echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"
if [ -r /proc/meminfo ]; then awk '/^MemTotal:/{print "mem_total_kb="$2} /^MemAvailable:/{print "mem_avail_kb="$2}' /proc/meminfo; else
  t=$(sysctl -n hw.memsize 2>/dev/null); [ -n "$t" ] && echo "mem_total_kb=$((t/1024))"
  ps=$(pagesize 2>/dev/null || echo 4096)
  vm_stat 2>/dev/null | awk -v ps="$ps" '/Pages free/{f=$3} /Pages inactive/{i=$3} /Pages speculative/{s=$3} END{gsub(/\./,"",f);gsub(/\./,"",i);gsub(/\./,"",s); if (f!="") print "mem_avail_kb=" int((f+i+s)*ps/1024)}'
fi
df -Pk / 2>/dev/null | awk 'NR==2{print "disk_total_kb="$2; print "disk_used_kb="$3}'
if command -v systemctl >/dev/null 2>&1; then echo "failed_units=$(systemctl --failed --no-legend --plain 2>/dev/null | grep -c .)"; fi
"#;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub uptime_sec: Option<u64>,
    pub load: Option<[f32; 3]>,
    pub cpus: Option<u32>,
    pub mem_total_kb: Option<u64>,
    pub mem_avail_kb: Option<u64>,
    pub disk_total_kb: Option<u64>,
    pub disk_used_kb: Option<u64>,
    /// None when systemd is not present.
    pub failed_units: Option<u32>,
}

pub fn parse(out: &str) -> Overview {
    let mut o = Overview::default();
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "os" => o.os = Some(v.to_string()),
            "kernel" => o.kernel = Some(v.to_string()),
            "uptime" => o.uptime_sec = v.parse::<f64>().ok().map(|f| f as u64),
            "load" => {
                let n: Vec<f32> = v.split_whitespace().filter_map(|x| x.replace(',', ".").parse().ok()).collect();
                if n.len() >= 3 {
                    o.load = Some([n[0], n[1], n[2]]);
                }
            }
            "cpus" => o.cpus = v.parse().ok(),
            "mem_total_kb" => o.mem_total_kb = v.parse().ok(),
            "mem_avail_kb" => o.mem_avail_kb = v.parse().ok(),
            "disk_total_kb" => o.disk_total_kb = v.parse().ok(),
            "disk_used_kb" => o.disk_used_kb = v.parse().ok(),
            "failed_units" => o.failed_units = v.parse().ok(),
            _ => {}
        }
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_linux() {
        let o = parse("os=Linux\nkernel=6.8.0\nuptime=12345.67\nload=0.52 0.40 0.31\ncpus=8\nmem_total_kb=16000000\nmem_avail_kb=8000000\ndisk_total_kb=100\ndisk_used_kb=40\nfailed_units=0\n");
        assert_eq!(o.uptime_sec, Some(12345));
        assert_eq!(o.load, Some([0.52, 0.40, 0.31]));
        assert_eq!(o.failed_units, Some(0));
    }
    #[test]
    fn parses_macos_and_gaps() {
        let o = parse("os=Darwin\nuptime=99\nload= 1,20 1,10 0,90 \ncpus=\nmem_total_kb=8388608\n");
        assert_eq!(o.load, Some([1.2, 1.1, 0.9]));
        assert_eq!(o.cpus, None);
        assert_eq!(o.failed_units, None);
    }
}
