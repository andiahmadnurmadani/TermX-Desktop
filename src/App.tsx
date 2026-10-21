import { useEffect } from "react";
import { Activity, ArrowUpCircle, FolderOpen, KeyRound, LayoutGrid, ListChecks, Lock, Plus, ScrollText, Search, Server, Settings, Workflow, X, Zap } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tabState, useStore, type View } from "./lib/store";
import { api } from "./lib/api";
import { useT, type Key } from "./lib/i18n";
import { useApplyTheme, useApplyUi, useFullscreen } from "./lib/theme";
import { useUpdater } from "./lib/updater";
import { isMac, isMod, modLabel } from "./lib/util";
import { HostsView } from "./components/HostsView";
import { HostDrawer } from "./components/HostDrawer";
import { TerminalView } from "./components/TerminalView";
import { SftpView } from "./components/SftpView";
import { KeysView } from "./components/KeysView";
import { SnippetsView } from "./components/SnippetsView";
import { SettingsView } from "./components/SettingsView";
import { Prompts } from "./components/Prompts";
import { GridView } from "./components/GridView";
import { RunView } from "./components/RunView";
import { WorkspacesView } from "./components/WorkspacesView";
import { WorkflowsView } from "./components/WorkflowsView";
import { OverviewView } from "./components/OverviewView";
import { LogsView, LogTabView } from "./components/LogsView";
import { UpdateCard, useUpdateCheck } from "./components/UpdateCard";
import { LockScreen, useAutoLock } from "./components/LockScreen";
import { Palette } from "./components/Palette";
import { BrandMark, DialogHost, Toasts } from "./components/ui";

const NAV: { v: View; icon: typeof Server; label: Key }[] = [
  { v: "hosts", icon: Server, label: "nav.hosts" },
  { v: "workspaces", icon: LayoutGrid, label: "nav.workspaces" },
  { v: "workflows", icon: Workflow, label: "nav.workflows" },
  { v: "overview", icon: Activity, label: "nav.overview" },
  { v: "logs", icon: ScrollText, label: "nav.logs" },
  { v: "keys", icon: KeyRound, label: "nav.keys" },
  { v: "snippets", icon: Zap, label: "nav.snippets" },
  { v: "settings", icon: Settings, label: "nav.settings" },
];

export default function App() {
  const t = useT();
  const { vault, load, view, setView, tabs, active, setActive, closeTab, hostDialog, palette, setPalette, openHostDialog, toast, sessions } = useStore();
  useApplyTheme();
  useApplyUi();
  useAutoLock();
  useUpdateCheck();
  const fullscreen = useFullscreen();
  const info = useStore((s) => s.info);
  const upd = useUpdater();

  useEffect(() => { load().catch((e) => toast(String(e), "error")); }, [load, toast]);

  // global shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (isMod(e, "k")) { e.preventDefault(); st.setPalette(!st.palette); return; }
      if (isMod(e, "t")) { e.preventDefault(); st.setView("hosts"); return; }
      if (isMod(e, "w")) { if (st.active) { e.preventDefault(); st.closeTab(st.active); } return; }
      if (isMod(e, "n") && !isMac) { e.preventDefault(); st.openHostDialog(null); return; }
      if (isMod(e, "[") || isMod(e, "]")) {
        if (!st.tabs.length) return;
        e.preventDefault();
        const i = st.tabs.findIndex((x) => x.id === st.active);
        const d = e.key === "]" ? 1 : -1;
        st.setActive(st.tabs[(i + d + st.tabs.length) % st.tabs.length].id);
        return;
      }
      for (let n = 1; n <= 9; n++) if (isMod(e, String(n))) { const tb = st.tabs[n - 1]; if (tb) { e.preventDefault(); st.setActive(tb.id); } return; }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => { document.documentElement.lang = vault?.settings.language ?? "en"; }, [vault?.settings.language]);

  // double-click on the empty tab bar toggles maximize
  const toggleMax = () => { getCurrentWindow().toggleMaximize().catch(() => {}); };

  if (!vault) return <div className="app" />;

  return (
    <div className={"app" + (isMac ? " mac" : "") + (fullscreen ? " fs" : "")}>
      <aside className="sidebar">
        <div className="drag" data-tauri-drag-region>
          <div className="brand" data-tauri-drag-region><BrandMark />TermX</div>
        </div>
        <nav className="nav">
          {NAV.map(({ v, icon: Icon, label }) => (
            <button key={v} className={active === null && view === v ? "on" : ""} onClick={() => setView(v)}>
              <Icon size={16} />{t(label)}
              {v === "hosts" && <span className="count">{vault.hosts.length}</span>}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          {upd.update && (upd.status === "available" || upd.status === "error") && (
            <button className="update-btn" onClick={upd.open} title={t("upd.available", { v: upd.update.version })}><ArrowUpCircle size={14} />{t("upd.now")}<span className="ver">{upd.update.version}</span></button>
          )}
          {vault.status.mode === "master" && (
            <button className="lock-btn" title={t("lock.now")} onClick={() => api.vaultLock().then(load).catch(() => {})}><Lock size={14} />{t("lock.now")}</button>
          )}
          <div className="sidebar-foot"><span>TermX {info?.version ?? ""}</span><span>{isMac ? "⌘K" : "Ctrl+Shift+K"}</span></div>
        </div>
      </aside>

      <div className="main">
        <div className="tabbar" data-tauri-drag-region onDoubleClick={(e) => { if ((e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) toggleMax(); }}>
          <div className="tabs">
            {tabs.map((tab) => (
              <div key={tab.id} className={"tab" + (active === tab.id ? " on" : "")} onClick={() => setActive(tab.id)}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}>
                {tab.kind === "sftp" ? <FolderOpen size={14} /> : tab.kind === "grid" ? <LayoutGrid size={14} /> : tab.kind === "run" ? <ListChecks size={14} /> : tab.kind === "log" ? <ScrollText size={14} /> : <span className={"dot " + tabState(tab, sessions)} />}
                <span className="t">{tab.title}</span>
                <button className="x" title={t("term.closeTab")} onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}><X size={13} /></button>
              </div>
            ))}
            <button className="icon-btn" style={{ alignSelf: "center", marginLeft: 4 }} title={t("hosts.new")} onClick={() => openHostDialog(null)}><Plus size={16} /></button>
          </div>
          <div className="grow" data-tauri-drag-region />
          <button className="pal" style={{ marginBottom: 9 }} onClick={() => setPalette(true)}><Search size={13} />{t("palette.placeholder").replace("…", "")}<span className="kbd">{modLabel}K</span></button>
        </div>

        <div className="content">
          {active === null && view === "hosts" && <HostsView />}
          {active === null && view === "workspaces" && <WorkspacesView />}
          {active === null && view === "workflows" && <WorkflowsView />}
          {active === null && view === "overview" && <OverviewView />}
          {active === null && view === "logs" && <LogsView />}
          {active === null && view === "keys" && <KeysView />}
          {active === null && view === "snippets" && <SnippetsView />}
          {active === null && view === "settings" && <SettingsView />}
          {tabs.map((tab) => {
            const vis = active === tab.id;
            if (tab.kind === "term") return <TerminalView key={tab.id} sid={tab.id} hostId={tab.hostId!} visible={vis} onClose={() => closeTab(tab.id)} />;
            if (tab.kind === "grid") return <GridView key={tab.id} tab={tab} visible={vis} />;
            if (tab.kind === "run") return <RunView key={tab.id} tab={tab} visible={vis} />;
            if (tab.kind === "log") return <LogTabView key={tab.id} tab={tab} visible={vis} />;
            return <SftpView key={tab.id} tab={tab} visible={vis} />;
          })}
        </div>
      </div>

      {hostDialog && <HostDrawer key={hostDialog.hostId ?? "new"} />}
      {palette && <Palette />}
      <Prompts />
      <DialogHost />
      <Toasts />
      <UpdateCard />
      {vault.status.locked && <LockScreen />}
    </div>
  );
}
