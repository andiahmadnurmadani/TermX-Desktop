#!/usr/bin/env python3
"""Builds site/dist (en at /, id at /id/) from strings.py + static assets. Run: python3 site/src/build.py"""
import html, json, os, shutil
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

def e(s): return html.escape(s, quote=True)

def page(lang):
    t = S[lang]
    def arrow(label):
        return f'<div class="link" aria-hidden="true"><span class="rule"></span><span class="lbl">{e(label)}</span></div>'
    layers = ""
    for i, (name, stack, body) in enumerate(t["a_layers"]):
        layers += f'<div class="layer"><div class="lh"><span class="ln">{e(name)}</span><span class="ls">{e(stack)}</span></div><p>{e(body)}</p></div>'
        if i < len(t["a_links"]): layers += arrow(t["a_links"][i])
    side = "".join(f'<div><h4>{e(a)}</h4><p>{e(b)}</p></div>' for a, b in t["a_side"])
    feats = "".join(f'<div class="row reveal"><h3>{e(a)}</h3><p>{e(b)}</p></div>' for a, b in t["f"])
    flow = "".join(f"<li>{x}</li>" for x in t["a_flow"])
    why = "".join(f'<div class="row reveal"><h3>{e(a)}</h3><p>{e(b)}</p></div>' for a, b in t["a_why"])
    nots = "".join(f"<li>{e(x)}</li>" for x in t["a_not"])
    tabs = "".join(f'<button role="tab" data-scene="{k}" aria-selected="{"true" if i==0 else "false"}">{e(v)}</button>' for i, (k, v) in enumerate(t["s_tabs"]))
    shots = ""
    for k, _ in t["s_tabs"]:
        for th in ("dark", "light"):
            shots += f'<img class="shot {th}" data-scene="{k}" src="/assets/shots/{th}-{k}.webp" alt="" width="1920" height="{H.get(k, 1200)}" loading="lazy">'
    caps = "".join(f'<p class="cap" data-scene="{k}">{e(v)}</p>' for k, v in t["s_caps"].items())
    plats = ""
    for pid, name, req, files in t["d_platforms"]:
        btns = "".join(
            f'<a class="dl" data-dl="{fid}" href="https://github.com/{ANDROID_REPO if fid=="android" else DESKTOP_REPO}/releases/latest" rel="noopener">'
            f'<span class="dn">{e(label)}</span><span class="de">{e(ext)}</span><span class="dm" data-meta></span></a>'
            for fid, label, ext in files)
        plats += f'<div class="plat reveal" data-plat="{pid}"><div class="pn"><h3>{e(name)}</h3><span>{e(req)}</span></div><div class="pf">{btns}</div></div>'
    dnotes = "".join(f"<div><h4>{e(a)}</h4><p>{b}</p></div>" for a, b in t["d_notes"])
    ld = json.dumps({"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "TermX", "applicationCategory": "DeveloperApplication",
        "operatingSystem": "macOS, Windows, Linux, Android", "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "license": "https://opensource.org/licenses/MIT", "url": SITE + t["self_href"], "description": t["desc"]})
    cfg = json.dumps({"desktop": DESKTOP_REPO, "android": ANDROID_REPO, "dlFor": t["cta_dl_for"], "dl": t["cta_dl"], "checking": t["d_checking"]})
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
<link rel="stylesheet" href="/assets/site.css">
<script>try{{var t=localStorage.getItem("termx-theme");if(!t)t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}}catch(e){{document.documentElement.dataset.theme="dark"}}</script>
<script type="application/ld+json">{ld}</script>
</head>
<body>
<a class="skip" href="#main">{e(t["skip"])}</a>
<header class="top">
  <div class="wrap bar">
    <a class="word" href="{t["self_href"]}" aria-label="TermX"><img src="/assets/icon-256.png" alt="" width="22" height="22">TermX</a>
    <nav aria-label="Primary">
      <a href="#features">{e(t["nav_features"])}</a><a href="#screens">{e(t["nav_screens"])}</a><a href="#architecture">{e(t["nav_arch"])}</a><a href="#download">{e(t["nav_download"])}</a>
      <a href="https://github.com/{DESKTOP_REPO}" rel="noopener">{e(t["nav_github"])}</a>
    </nav>
    <div class="tools">
      <a class="pill" href="{t["alt_href"]}" hreflang="{t["alt_lang"]}" lang="{t["alt_lang"]}" aria-label="{e(t["lang_label"])}">{t["alt_label"]}</a>
      <button class="pill" id="theme" aria-label="{e(t["theme"])}"><span class="ico-dark">◐</span></button>
    </div>
  </div>
</header>
<main id="main">
<section class="hero wrap">
  <p class="eyebrow">{e(t["eyebrow"])}</p>
  <h1>{t["h1"]}</h1>
  <p class="lede">{e(t["lede"])}</p>
  <div class="cta">
    <a class="btn primary" id="hero-dl" href="#download">{e(t["cta_dl"])}</a>
    <a class="btn" href="https://github.com/{DESKTOP_REPO}" rel="noopener">{e(t["cta_src"])}</a>
  </div>
  <p class="meta">{e(t["hero_meta"])}</p>
</section>
<section class="wrap hero-shot">
  <figure class="frame"><div class="chrome" aria-hidden="true"><i></i><i></i><i></i></div>
    <img class="shot dark" src="/assets/shots/dark-grid.webp" width="1920" height="1200" alt="TermX 2×2 workspace">
    <img class="shot light" src="/assets/shots/light-grid.webp" width="1920" height="1200" alt="TermX 2×2 workspace">
  </figure>
  <p class="fig">{e(t["frame_caption"])}</p>
</section>

<section class="sec wrap" id="features">
  <div class="shead"><p class="lab">{e(t["f_label"])}</p><h2>{e(t["f_title"])}</h2></div>
  <div class="rows">{feats}</div>
</section>

<section class="sec wrap" id="screens">
  <div class="shead"><p class="lab">{e(t["s_label"])}</p><h2>{e(t["s_title"])}</h2></div>
  <div class="tabs" role="tablist">{tabs}</div>
  <figure class="frame big"><div class="chrome" aria-hidden="true"><i></i><i></i><i></i></div><div class="stage">{shots}</div></figure>
  <div class="caps">{caps}</div>
  <p class="fig">{e(t["theme_note"])}</p>
</section>

<section class="sec wrap" id="architecture">
  <div class="shead"><p class="lab">{e(t["a_label"])}</p><h2>{e(t["a_title"])}</h2></div>
  <p class="intro">{e(t["a_intro"])}</p>
  <div class="arch">
    <div class="stack">{layers}</div>
    <aside class="side"><h3>{e(t["a_side_t"])}</h3>{side}</aside>
  </div>
  <p class="android">{t["a_android"]}</p>
  <div class="two">
    <div><h3 class="sub">{e(t["a_flow_t"])}</h3><ol class="flow">{flow}</ol></div>
    <div><h3 class="sub">{e(t["a_tree_t"])}</h3><pre class="code"><code>{e(TREE)}</code></pre></div>
  </div>
  <h3 class="sub gap">{e(t["a_why_t"])}</h3>
  <div class="rows tight">{why}</div>
  <h3 class="sub gap">{e(t["a_not_t"])}</h3>
  <ul class="nots">{nots}</ul>
</section>

<section class="sec wrap" id="download">
  <div class="shead"><p class="lab">{e(t["d_label"])}</p><h2>{e(t["d_title"])}</h2></div>
  <p class="intro">{e(t["d_sub"])} <span class="ver" id="ver"></span></p>
  <div class="plats">{plats}</div>
  <p class="all"><a href="https://github.com/{DESKTOP_REPO}/releases" rel="noopener">{e(t["d_all"])} →</a> <span class="sep">·</span> <a href="https://github.com/{ANDROID_REPO}/releases" rel="noopener">{e(t["foot_android"])} →</a></p>
  <div class="two notes">
    <div><h3 class="sub">{e(t["d_notes_t"])}</h3><div class="nlist">{dnotes}</div><p class="verify">{e(t["d_verify"])}</p></div>
    <div><h3 class="sub">{e(t["d_src_t"])}</h3><pre class="code"><code>{e(BUILD.format(repo=DESKTOP_REPO))}</code></pre></div>
  </div>
</section>
</main>
<footer class="foot">
  <div class="wrap fb">
    <p>{e(t["foot_tag"])}</p>
    <p class="fl"><a href="https://github.com/{DESKTOP_REPO}/blob/main/LICENSE" rel="noopener">{e(t["foot_license"])}</a><a href="https://github.com/{ANDROID_REPO}/blob/main/CHANGELOG.md" rel="noopener">{e(t["foot_changelog"])}</a><a href="https://github.com/{DESKTOP_REPO}/issues" rel="noopener">{e(t["foot_issues"])}</a></p>
  </div>
</footer>
<script>window.TERMX={cfg};</script>
<script src="/assets/site.js" defer></script>
</body>
</html>
'''

def main():
    if os.path.isdir(DIST): shutil.rmtree(DIST)
    os.makedirs(DIST + "/id")
    shutil.copytree(os.path.join(ROOT, "assets"), DIST + "/assets")
    open(DIST + "/index.html", "w").write(page("en"))
    open(DIST + "/id/index.html", "w").write(page("id"))
    open(DIST + "/CNAME", "w").write("termx.kroombox.com\n")
    open(DIST + "/robots.txt", "w").write(f"User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n")
    open(DIST + "/sitemap.xml", "w").write(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>{SITE}/</loc></url><url><loc>{SITE}/id/</loc></url></urlset>\n')
    open(DIST + "/404.html", "w").write('<!doctype html><meta charset="utf-8"><title>404 · TermX</title><meta http-equiv="refresh" content="0;url=/">')
    print("built", DIST)

if __name__ == "__main__":
    main()
