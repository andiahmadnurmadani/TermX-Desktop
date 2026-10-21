#!/usr/bin/env python3
"""Builds site/dist (en at /, id at /id/) from strings.py + static assets. Run: python3 site/src/build.py"""
import hashlib, html, json, os, re, shutil, urllib.request
from strings import S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
SITE = "https://termx.kroombox.com"
DESKTOP_REPO = "andiahmadnurmadani/TermX-Desktop"
ANDROID_REPO = "andiahmadnurmadani/TermX"

TREE = """termx/
├── core/                 termx-core: no GUI dependencies
│   ├── src/ssh.rs        connections, jump hosts, shells, reconnect
│   ├── src/sftp.rs       list, transfer, edit, progress, cancel
│   ├── src/keys.rs       generate and import SSH keys
│   ├── src/secrets.rs    AES-256-GCM, keychain or master password
│   ├── src/store.rs      SQLite, transactions, migrations
│   ├── src/workflow.rs   multi-host engine, masking, cancel
│   ├── src/overview.rs   agentless health probe
│   ├── src/backup.rs     encrypted export / restore
│   └── tests/live.rs     4 panes + workflows against a real sshd
├── src-tauri/            Tauri commands, prompt broker
├── src/                  React + TypeScript interface
└── site/                 this website"""

BUILD = """git clone https://github.com/{repo}.git
cd TermX-Desktop
npm install
npx tauri dev      # run with hot reload
npx tauri build    # installer for your OS"""

H = {"hosts": 1125, "settings": 1125, "terminal": 795, "sftp": 795}

# Asset rules; keep in sync with RULES in assets/site.js
RULES = {
    "mac-arm": lambda n: n.endswith(".dmg") and re.search(r"aarch64|arm64", n),
    "mac-x64": lambda n: n.endswith(".dmg") and re.search(r"x64|x86_64|intel", n, re.I),
    "win-msi": lambda n: n.endswith(".msi"),
    "win-exe": lambda n: n.endswith(".exe"),
    "lin-appimage": lambda n: n.endswith(".AppImage"),
    "lin-deb": lambda n: n.endswith(".deb"),
    "lin-rpm": lambda n: n.endswith(".rpm"),
    "android": lambda n: n.endswith(".apk"),
}
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "releases.json")

def releases():
    """Latest release of each repo, baked into the page so downloads work without the GitHub API.
    Uses GITHUB_TOKEN if set; falls back to the last good cache when offline or rate limited."""
    out = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    for repo in (DESKTOP_REPO, ANDROID_REPO):
        req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases/latest", headers={"Accept": "application/vnd.github+json"})
        if os.environ.get("GITHUB_TOKEN"): req.add_header("Authorization", "Bearer " + os.environ["GITHUB_TOKEN"])
        try:
            d = json.load(urllib.request.urlopen(req, timeout=10))
            out[repo] = {"tag": d["tag_name"], "assets": [{"name": a["name"], "url": a["browser_download_url"], "size": a["size"]} for a in d["assets"]]}
        except Exception as ex:
            print("release lookup failed for", repo, "-", ex, "(using cache)" if repo in out else "")
    json.dump(out, open(CACHE, "w"), indent=1)
    return out

def asset_for(rels, fid):
    rel = rels.get(ANDROID_REPO if fid == "android" else DESKTOP_REPO)
    return next((a for a in (rel or {}).get("assets", []) if RULES[fid](a["name"])), None)

def mb(n): return f"{n / 1048576:.1f} MB"

def e(s): return html.escape(s, quote=True)

# Line icons (24×24, stroked) for the feature grid.
ICONS = {
    "grid": '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    "flow": '<rect x="3.5" y="3.5" width="6" height="6" rx="1.5"/><rect x="14.5" y="14.5" width="6" height="6" rx="1.5"/><path d="M6.5 9.5v3a2.5 2.5 0 0 0 2.5 2.5h5.5"/>',
    "pulse": '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
    "folder": '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 16.5v-5m-2.3 2.2L12 11.4l2.3 2.3"/>',
    "loop": '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
    "list": '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.4"/>',
    "key": '<circle cx="8" cy="15.5" r="4"/><path d="m10.9 12.6 8.6-8.6M16.5 7l2.5 2.5M14.5 9l1.8 1.8"/>',
    "server": '<rect x="3.5" y="4" width="17" height="7" rx="1.8"/><rect x="3.5" y="13" width="17" height="7" rx="1.8"/><path d="M7.5 7.5h.01M7.5 16.5h.01" stroke-width="2.4"/>',
    "lock": '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    "shield": '<path d="M12 3.5 5 6.2v5.6c0 4.4 3 7.4 7 8.7 4-1.3 7-4.3 7-8.7V6.2z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    "file": '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h4.5"/>',
    "update": '<path d="M12 3.5v11m-4.5-4.5L12 14.5l4.5-4.5"/><path d="M4.5 18.5v1a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-1"/>',
    "spark": '<path d="M12 3.5 13.9 9l5.6 2-5.6 2L12 18.5 10.1 13l-5.6-2 5.6-2z"/>',
    "send": '<path d="M5 12h13m-5-5 5 5-5 5"/>',
    "arrow": '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
}

def icon(name, cls="ico"):
    return f'<svg class="{cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>'

def logo(uid, size=28):
    """The TermX mark: a prompt chevron and its mirror forming an X over a cursor (see brand/termx-tile.svg)."""
    return (f'<svg class="logo" width="{size}" height="{size}" viewBox="100 100 824 824" aria-hidden="true"><defs>'
            f'<linearGradient id="{uid}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2228"/><stop offset="1" stop-color="#0a0d10"/></linearGradient>'
            f'<linearGradient id="{uid}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#62f2b3"/><stop offset="1" stop-color="#2bc283"/></linearGradient></defs>'
            f'<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#{uid}b)"/>'
            f'<g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="80"><path d="M296 282 L462 466 L296 650" stroke="url(#{uid}g)"/><path d="M728 282 L562 466 L728 650" stroke="#e6ebee"/></g>'
            f'<rect x="430" y="716" width="164" height="54" rx="27" fill="url(#{uid}g)"/></svg>')

def page(lang, rels):
    t = S[lang]
    dtag = rels.get(DESKTOP_REPO, {}).get("tag", "")
    VER = " · ".join(f"{k} {rels[r]['tag']}" for k, r in (("Desktop", DESKTOP_REPO), ("Android", ANDROID_REPO)) if r in rels)
    GH = f"https://github.com/{DESKTOP_REPO}"

    facts = "".join(f'<div class="fact"><b>{e(a)}</b><span>{e(b)}</span></div>' for a, b in t["facts"])
    feats = "".join(f'<article class="feat reveal"><span class="fi">{icon(ic)}</span><h3>{e(a)}</h3><p>{e(b)}</p></article>' for ic, a, b in t["f"])

    d = t["ai_demo"]
    ai_points = "".join(f'<li><h3>{e(a)}</h3><p>{e(b)}</p></li>' for a, b in t["ai_points"])
    provs = "".join(f"<li>{e(p)}</li>" for p in t["ai_providers"])
    ai_demo = f'''<div class="ai-win" role="img" aria-label="{e(d["ask"])}">
      <div class="ai-head">{icon("spark", "ico sp")}<b>{e(d["title"])}</b><span class="ai-host"><i></i>{e(d["host"])}</span></div>
      <div class="ai-body">
        <p class="msg me">{e(d["ask"])}</p>
        <p class="msg bot">{e(d["say1"])}</p>
        <div class="cmd ok"><span class="pr">$</span><code>df -h /</code><span class="st">✓</span></div>
        <pre class="out">Filesystem  Size  Used Avail Use%
/dev/sda1    40G   38G  2.1G  95%</pre>
        <div class="cmd ok"><span class="pr">$</span><code>sudo du -xh /var -d2 | sort -h | tail -3</code><span class="st">✓</span></div>
        <pre class="out">1.2G  /var/lib/docker
3.1G  /var/log/journal
4.6G  /var</pre>
        <p class="msg bot">{e(d["say2"])}</p>
        <div class="cmd ask"><span class="pr">$</span><code>sudo journalctl --vacuum-size=200M</code>
          <div class="ask-row"><span class="wait">{e(d["wait"])}</span><span class="b">{e(d["skip"])}</span><span class="b go">{e(d["approve"])}</span></div></div>
      </div>
      <div class="ai-in"><span>{e(d["input"])}</span><span class="send">{icon("send")}</span></div>
    </div>'''

    tabs = "".join(f'<button role="tab" data-scene="{k}" aria-selected="{"true" if i==0 else "false"}">{e(v)}</button>' for i, (k, v) in enumerate(t["s_tabs"]))
    shots = ""
    for k, _ in t["s_tabs"]:
        for th in ("dark", "light"):
            shots += f'<img class="shot {th}" data-scene="{k}" src="/assets/shots/{th}-{k}.webp" alt="" width="1920" height="{H.get(k, 1200)}" loading="lazy" decoding="async">'
    caps = "".join(f'<p class="cap" data-scene="{k}">{e(v)}</p>' for k, v in t["s_caps"].items())

    def arrow(label):
        return f'<div class="link" aria-hidden="true"><span class="rule"></span><span class="lbl">{e(label)}</span></div>'
    layers = ""
    for i, (name, stack, body) in enumerate(t["a_layers"]):
        layers += f'<div class="layer"><div class="lh"><span class="ln">{e(name)}</span><span class="ls">{e(stack)}</span></div><p>{e(body)}</p></div>'
        if i < len(t["a_links"]): layers += arrow(t["a_links"][i])
    side = "".join(f'<div><h4>{e(a)}</h4><p>{e(b)}</p></div>' for a, b in t["a_side"])
    why = "".join(f'<div class="why reveal"><h3>{e(a)}</h3><p>{e(b)}</p></div>' for a, b in t["a_why"])

    plats = ""
    for pid, name, req, files in t["d_platforms"]:
        btns = ""
        for fid, label, ext in files:
            a = asset_for(rels, fid)
            href = a["url"] if a else f'https://github.com/{ANDROID_REPO if fid=="android" else DESKTOP_REPO}/releases/latest'
            btns += (f'<a class="dl" data-dl="{fid}" href="{e(href)}" rel="noopener">'
                     f'<span class="dn">{e(label)}</span><span class="de">{e(ext)}</span><span class="dm" data-meta>{mb(a["size"]) if a else ""}</span>{icon("update", "ico dli")}</a>')
        plats += (f'<div class="plat reveal" data-plat="{pid}"><div class="pn"><h3>{e(name)}</h3><span class="req">{e(req)}</span>'
                  f'<span class="here-tag">{e(t["d_here"])}</span></div><div class="pf">{btns}</div></div>')

    faq = "".join(f'<details class="qa"{" open" if i == 0 else ""}><summary><span>{e(q)}</span>{icon("plus", "ico qi")}</summary><div class="ans"><p>{a}</p></div></details>' for i, (q, a) in enumerate(t["faq"]))

    ld = json.dumps({"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "TermX", "applicationCategory": "DeveloperApplication",
        "operatingSystem": "macOS, Windows, Linux, Android", "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "license": "https://opensource.org/licenses/MIT", "url": SITE + t["self_href"], "description": t["desc"]})
    cfg = json.dumps({"desktop": DESKTOP_REPO, "android": ANDROID_REPO, "dlFor": t["cta_dl_for"], "dl": t["cta_dl"], "checking": t["d_checking"]})
    nav = (f'<a href="#features">{e(t["nav_features"])}</a><a href="#ai">{e(t["nav_ai"])}</a><a href="#screens">{e(t["nav_screens"])}</a>'
           f'<a href="#inside">{e(t["nav_arch"])}</a><a href="#faq">{e(t["nav_faq"])}</a><a href="{GH}" rel="noopener">{e(t["nav_github"])}</a>')
    return f'''<!doctype html>
<html lang="{t["html_lang"]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(t["title"])}</title>
<meta name="description" content="{e(t["desc"])}">
<link rel="canonical" href="{SITE}{t["self_href"]}">
<link rel="alternate" hreflang="en" href="{SITE}/">
<link rel="alternate" hreflang="id" href="{SITE}/id/">
<link rel="alternate" hreflang="x-default" href="{SITE}/">
<meta property="og:type" content="website">
<meta property="og:title" content="{e(t["title"])}">
<meta property="og:description" content="{e(t["desc"])}">
<meta property="og:url" content="{SITE}{t["self_href"]}">
<meta property="og:image" content="{SITE}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0b0c0d">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="preload" href="/assets/fonts/instrument-serif-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css">
<script>try{{var t=localStorage.getItem("termx-theme");if(!t)t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}}catch(e){{document.documentElement.dataset.theme="dark"}}</script>
<script type="application/ld+json">{ld}</script>
</head>
<body>
<a class="skip" href="#main">{e(t["skip"])}</a>
<header class="top">
  <div class="wrap bar">
    <a class="word" href="{t["self_href"]}" aria-label="TermX">{logo("hl", 26)}<span>TermX</span></a>
    <nav aria-label="Primary">{nav}</nav>
    <div class="tools">
      <a class="pill" href="{t["alt_href"]}" hreflang="{t["alt_lang"]}" lang="{t["alt_lang"]}" aria-label="{e(t["lang_label"])}">{t["alt_label"]}</a>
      <button class="pill" id="theme" type="button" aria-label="{e(t["theme"])}"><span class="ico-dark"></span></button>
      <a class="btn sm primary" href="#download">{e(t["nav_download"])}</a>
    </div>
  </div>
</header>
<main id="main">
<section class="hero">
  <div class="wrap">
    <a class="news" href="#ai"><span class="nb">{e(t["news"])}</span><span class="nt">{e(t["news_text"])}</span>{icon("arrow", "ico na")}</a>
    <p class="eyebrow">{t["eyebrow"]}</p>
    <h1>{t["h1"]}</h1>
    <div class="hero-foot">
      <p class="lede">{e(t["lede"])}</p>
      <div class="hero-act">
        <div class="cta">
          <a class="btn primary" id="hero-dl" href="#download">{e(t["cta_dl"])}</a>
          <a class="btn" href="{GH}" rel="noopener">{e(t["cta_src"])}</a>
        </div>
        <p class="meta"><span>{e(t["platforms_line"])}</span>{f'<span>{e(dtag)}</span>' if dtag else ''}</p>
      </div>
    </div>
  </div>
  <div class="wrap hero-shot">
    <figure class="frame"><div class="chrome" aria-hidden="true"><i></i><i></i><i></i></div>
      <img class="shot dark" src="/assets/shots/dark-grid.webp" width="1920" height="1200" alt="TermX 2×2 workspace" fetchpriority="high">
      <img class="shot light" src="/assets/shots/light-grid.webp" width="1920" height="1200" alt="TermX 2×2 workspace">
    </figure>
    <p class="fig">{e(t["frame_caption"])}</p>
  </div>
</section>

<section class="wrap facts" aria-label="TermX">{facts}</section>

<section class="sec wrap" id="features">
  <div class="shead"><p class="lab">{e(t["f_label"])}</p><h2>{e(t["f_title"])}</h2></div>
  <div class="feats">{feats}</div>
</section>

<section class="sec ai-sec" id="ai">
  <div class="wrap">
    <div class="shead"><p class="lab">{e(t["ai_label"])} <span class="badge">{e(t["ai_badge"])}</span></p><h2>{t["ai_title"]}</h2></div>
    <div class="ai-grid">
      <div class="ai-copy">
        <p class="intro">{e(t["ai_lede"])}</p>
        <ul class="ai-points">{ai_points}</ul>
        <p class="prov-t">{e(t["ai_prov_t"])}</p>
        <ul class="provs">{provs}</ul>
      </div>
      <div class="ai-demo reveal">{ai_demo}</div>
    </div>
  </div>
</section>

<section class="sec wrap" id="screens">
  <div class="shead"><p class="lab">{e(t["s_label"])}</p><h2>{e(t["s_title"])}</h2></div>
  <div class="tabs" role="tablist">{tabs}</div>
  <figure class="frame big"><div class="chrome" aria-hidden="true"><i></i><i></i><i></i></div><div class="stage">{shots}</div></figure>
  <div class="caps">{caps}</div>
  <p class="fig">{e(t["theme_note"])}</p>
</section>

<section class="sec wrap" id="inside">
  <div class="shead"><p class="lab">{e(t["a_label"])}</p><h2>{e(t["a_title"])}</h2></div>
  <p class="intro wide">{e(t["a_intro"])}</p>
  <div class="arch">
    <div class="stack">{layers}</div>
    <aside class="side"><h3 class="sub">{e(t["a_side_t"])}</h3>{side}<p class="android">{t["a_android"]}</p></aside>
  </div>
  <h3 class="sub gap">{e(t["a_why_t"])}</h3>
  <div class="whys">{why}</div>
  <details class="tree"><summary>{e(t["a_tree_t"])}{icon("plus", "ico qi")}</summary><pre class="code"><code>{e(TREE)}</code></pre></details>
</section>

<section class="sec wrap" id="download">
  <div class="shead"><p class="lab">{e(t["d_label"])}</p><h2>{e(t["d_title"])}</h2></div>
  <p class="intro">{e(t["d_sub"])} <span class="ver" id="ver">{e(VER)}</span></p>
  <div class="plats">{plats}</div>
  <p class="all"><a href="{GH}/releases" rel="noopener">{e(t["d_all"])} →</a><span class="sep">·</span><a href="https://github.com/{ANDROID_REPO}/releases" rel="noopener">{e(t["foot_android"])} →</a></p>
  <div class="build"><h3 class="sub">{e(t["d_src_t"])}</h3><pre class="code"><code>{e(BUILD.format(repo=DESKTOP_REPO))}</code></pre></div>
</section>

<section class="sec wrap" id="faq">
  <div class="shead"><p class="lab">{e(t["q_label"])}</p><h2>{e(t["q_title"])}</h2></div>
  <div class="faq">{faq}</div>
</section>
</main>
<footer class="foot">
  <div class="wrap">
    <div class="fgrid">
      <div class="fbrand"><a class="word" href="{t["self_href"]}" aria-label="TermX">{logo("fl", 30)}<span>TermX</span></a><p>{e(t["foot_tag"])}</p></div>
      <div class="fcol"><h4>{e(t["foot_product"])}</h4><a href="#features">{e(t["nav_features"])}</a><a href="#ai">{e(t["nav_ai"])}</a><a href="#screens">{e(t["nav_screens"])}</a><a href="#download">{e(t["nav_download"])}</a></div>
      <div class="fcol"><h4>{e(t["foot_project"])}</h4><a href="{GH}" rel="noopener">GitHub</a><a href="{GH}/releases" rel="noopener">{e(t["foot_releases"])}</a><a href="{GH}/issues" rel="noopener">{e(t["foot_issues"])}</a><a href="https://github.com/{ANDROID_REPO}" rel="noopener">{e(t["foot_android"])}</a></div>
    </div>
    <div class="fbot"><span>© 2026 Kroombox</span><a href="{GH}/blob/main/LICENSE" rel="noopener">{e(t["foot_license"])}</a></div>
  </div>
</footer>
<script>window.TERMX={cfg};</script>
<script src="/assets/site.js" defer></script>
</body>
</html>
'''

def main():
    # build next to the live folder, then swap, so the running server never sees a half-built site
    final, DIST_ = DIST, DIST + ".next"
    build(DIST_)
    old = final + ".old"
    if os.path.isdir(old): shutil.rmtree(old)
    if os.path.isdir(final): os.rename(final, old)
    os.rename(DIST_, final)
    if os.path.isdir(old): shutil.rmtree(old)
    print("built", final)

def versioned(doc, DIST):
    """Add a content hash to every local asset URL, so a CDN or browser never pairs new HTML with an old file."""
    def tag(m):
        f = os.path.join(DIST, m.group(2).lstrip("/"))
        if not os.path.isfile(f): return m.group(0)
        h = hashlib.sha256(open(f, "rb").read()).hexdigest()[:10]
        return f'{m.group(1)}{m.group(2)}?v={h}{m.group(3)}'
    return re.sub(r'((?:src|href)=")(/assets/(?!fonts/)[^"?#]+)(")', tag, doc)

def build(DIST):
    if os.path.isdir(DIST): shutil.rmtree(DIST)
    os.makedirs(DIST + "/id")
    shutil.copytree(os.path.join(ROOT, "assets"), DIST + "/assets")
    rels = releases()
    open(DIST + "/index.html", "w").write(versioned(page("en", rels), DIST))
    open(DIST + "/id/index.html", "w").write(versioned(page("id", rels), DIST))
    open(DIST + "/CNAME", "w").write("termx.kroombox.com\n")
    open(DIST + "/robots.txt", "w").write(f"User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n")
    open(DIST + "/sitemap.xml", "w").write(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>{SITE}/</loc></url><url><loc>{SITE}/id/</loc></url></urlset>\n')
    open(DIST + "/404.html", "w").write('<!doctype html><meta charset="utf-8"><title>404 · TermX</title><meta http-equiv="refresh" content="0;url=/">')

if __name__ == "__main__":
    main()
