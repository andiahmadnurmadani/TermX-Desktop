(() => {
  const C = window.TERMX, root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) root.classList.add("reduce");

  // theme
  document.getElementById("theme").addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("termx-theme", next); } catch (e) {}
  });

  // reveal on scroll
  const io = "IntersectionObserver" in window && !reduce ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" }) : null;
  document.querySelectorAll(".reveal").forEach((el) => (io ? io.observe(el) : el.classList.add("in")));

  // screens
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const show = (scene) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.scene === scene)));
    document.querySelectorAll(".stage .shot, .cap").forEach((el) => el.classList.toggle("on", el.dataset.scene === scene));
  };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.scene)));
  show("terminal");

  // OS detection
  const ua = navigator.userAgent, plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  let os = "other";
  if (/android/i.test(ua)) os = "android"; else if (/win/i.test(plat + ua)) os = "win"; else if (/mac/i.test(plat + ua) && !/iphone|ipad/i.test(ua)) os = "mac"; else if (/linux|x11|cros/i.test(plat + ua)) os = "linux";
  const names = { mac: "macOS", win: "Windows", linux: "Linux", android: "Android" };
  const hero = document.getElementById("hero-dl");
  if (names[os]) {
    hero.textContent = C.dlFor.replace("{os}", names[os]);
    const row = document.querySelector(`[data-plat="${os}"]`);
    if (row) row.classList.add("here");
  }

  // pick best asset per button from the latest releases
  const rules = {
    "mac-arm": (n) => /\.dmg$/i.test(n) && /aarch64|arm64/i.test(n),
    "mac-x64": (n) => /\.dmg$/i.test(n) && /x64|x86_64|intel/i.test(n),
    "win-msi": (n) => /\.msi$/i.test(n),
    "win-exe": (n) => /\.exe$/i.test(n),
    "lin-appimage": (n) => /\.AppImage$/i.test(n),
    "lin-deb": (n) => /\.deb$/i.test(n),
    "lin-rpm": (n) => /\.rpm$/i.test(n),
    android: (n) => /\.apk$/i.test(n),
  };
  const mb = (b) => (b / 1048576 >= 10 ? (b / 1048576).toFixed(0) : (b / 1048576).toFixed(1)) + " MB";
  const get = (repo) => fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([get(C.desktop), get(C.android)]).then(([d, a]) => {
    const versions = [];
    [[d, false], [a, true]].forEach(([rel, isAndroid]) => {
      if (!rel || !rel.assets) return;
      versions.push((isAndroid ? "Android " : "Desktop ") + rel.tag_name);
      document.querySelectorAll("[data-dl]").forEach((el) => {
        const id = el.dataset.dl;
        if ((id === "android") !== isAndroid) return;
        const asset = rel.assets.find((x) => rules[id](x.name));
        if (!asset) return;
        el.href = asset.browser_download_url;
        el.querySelector("[data-meta]").textContent = mb(asset.size);
      });
    });
    if (versions.length) document.getElementById("ver").textContent = versions.join(" · ");
    // point the hero button at the exact file for this visitor
    const best = os === "win" ? "win-exe" : os === "linux" ? "lin-appimage" : os === "android" ? "android" : null;
    const el = best && document.querySelector(`[data-dl="${best}"]`);
    if (el && /\/releases\/download\//.test(el.href)) hero.href = el.href;
  });
})();
