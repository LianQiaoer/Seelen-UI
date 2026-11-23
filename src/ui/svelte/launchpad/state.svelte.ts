import { IconPackManager, invoke, SeelenCommand, Widget } from "@seelen-ui/lib";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface LaunchpadApp {
  id: string;
  name: string;
  path: string;
  args: string;
  workdir: string;
  icon: string;
  elevated: boolean;
}

export interface EditorData {
  id: string | null;
  name: string;
  path: string;
  args: string;
  workdir: string;
  icon: string;
  elevated: boolean;
}

const DATA_FILE = "launchpad-apps.json";
const LS_KEY = "morgan-launchpad-apps-v1";

export function uid(): string {
  return "app-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function nameFromPath(p: string): string {
  const base = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return base.replace(/\.(exe|lnk|bat|cmd|msi|url)$/i, "");
}

export function tileColor(name: string): string {
  const colors = ["#5b7fa6", "#7a6ba5", "#4f8a6d", "#a5673f", "#8a4f6d", "#3f7d8a", "#6d7c3f", "#946b54"];
  let h = 0;
  const s = String(name || "?");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

export function matches(item: LaunchpadApp, q: string): boolean {
  if (!q) return true;
  const hay = ((item.name || "") + " " + (item.path || "")).toLowerCase();
  return hay.indexOf(q.toLowerCase()) !== -1;
}

function parseArgs(str: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

let iconManagerPromise: Promise<IconPackManager | null> | null = null;
export function getIconManager(): Promise<IconPackManager | null> {
  if (!iconManagerPromise) {
    iconManagerPromise = IconPackManager.create()
      .then(async (mgr) => {
        try {
          await mgr.onChange(() => lpState.bumpIcons());
        } catch {
          /* ignore */
        }
        return mgr;
      })
      .catch(() => null);
  }
  return iconManagerPromise;
}

const iconRequested = new Set<string>();
export function requestIconExtractionOnce(path: string): void {
  const key = (path || "").toLowerCase();
  if (!key || iconRequested.has(key)) return;
  iconRequested.add(key);
  IconPackManager.requestIconExtraction({ path, umid: null }).catch(() => {});
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

class LaunchpadState {
  apps = $state<LaunchpadApp[]>([]);
  query = $state("");
  page = $state(0);
  editing = $state(false);
  dragHover = $state(false);
  toastMsg = $state("");
  toastVisible = $state(false);
  iconVersion = $state(0);
  opening = $state(false);
  closing = $state(false);
  focusNonce = $state(0);
  editor = $state<EditorData | null>(null);
  menu = $state<{ x: number; y: number; item: LaunchpadApp } | null>(null);

  private widget: Widget | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFocusLossAt = 0;

  attachWidget(w: Widget): void {
    this.widget = w;
  }

  bumpIcons(): void {
    this.iconVersion++;
  }

  toast(msg: string): void {
    this.toastMsg = msg;
    this.toastVisible = true;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastVisible = false;
    }, 3400);
  }

  async load(): Promise<void> {
    const apply = (list: unknown) => {
      if (Array.isArray(list)) {
        this.apps = list.filter(
          (a): a is LaunchpadApp => !!a && typeof a.path === "string" && !!a.path.trim(),
        );
      }
    };
    try {
      const content = await invoke(SeelenCommand.ReadFile, { filename: DATA_FILE });
      try {
        apply(JSON.parse(content as string));
        return;
      } catch {
        /* fall through to localStorage */
      }
    } catch {
      /* fall through to localStorage */
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) apply(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }

  save(): void {
    const json = JSON.stringify(this.apps);
    try {
      localStorage.setItem(LS_KEY, json);
    } catch {
      /* ignore */
    }
    invoke(SeelenCommand.WriteFile, { filename: DATA_FILE, content: json }).catch(() => {});
  }

  async importData(): Promise<void> {
    try {
      const content = await invoke(SeelenCommand.ReadFile, { filename: DATA_FILE });
      const list: unknown = JSON.parse(content as string);
      if (!Array.isArray(list)) throw new Error("bad-format");
      const seen = new Set(this.apps.map((a) => a.path.toLowerCase()));
      let added = 0;
      for (const raw of list as Partial<LaunchpadApp>[]) {
        if (!raw || typeof raw.path !== "string" || !raw.path.trim()) continue;
        const key = raw.path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        this.apps.push({
          id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
          name: typeof raw.name === "string" && raw.name.trim() ? raw.name : nameFromPath(raw.path),
          path: raw.path,
          args: typeof raw.args === "string" ? raw.args : "",
          workdir: typeof raw.workdir === "string" ? raw.workdir : "",
          icon: typeof raw.icon === "string" ? raw.icon : "",
          elevated: !!raw.elevated,
        });
        added++;
      }
      if (added > 0) {
        this.save();
        this.toast("已导入 " + added + " 个应用");
      } else {
        this.toast("没有新的应用可导入");
      }
    } catch {
      this.toast("导入失败：没有读到可用的数据文件");
    }
  }

  private backupRunning = false;

  /**
   * Weekly backup of the apps data to a GitHub repo, as a JS file.
   * Config lives in `launchpad-backup.json` in this widget's data folder:
   * { "token": "...", "owner": "...", "repo": "...", "path": "...", "branch": "..." }.
   * Runs at most once a week: it becomes due on Saturday and is executed on
   * the next launchpad open after that (catch-up included). Without a config
   * file it stays completely silent.
   */
  async maybeBackup(): Promise<void> {
    if (this.backupRunning || !this.widget) return;
    const now = new Date();
    const saturday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    saturday.setDate(saturday.getDate() - ((now.getDay() + 1) % 7));
    let last = 0;
    try {
      last = Number(localStorage.getItem("lp-backup-last") || 0);
    } catch {
      /* ignore */
    }
    if (last >= saturday.getTime()) return;

    let cfg: { token?: string; owner?: string; repo?: string; path?: string; branch?: string };
    try {
      const raw = await invoke(SeelenCommand.ReadFile, { filename: "launchpad-backup.json" });
      cfg = JSON.parse(raw as string);
    } catch {
      return; // no backup configured
    }
    if (!cfg.token || !cfg.owner || !cfg.repo) return;

    this.backupRunning = true;
    try {
      const path = cfg.path || "backup/launchpad-apps.js";
      const branch = cfg.branch || "master";
      const text =
        "// Launchpad apps backup (Seelen UI)\n// Updated: " +
        new Date().toISOString() +
        "\nexport default " +
        JSON.stringify(this.apps, null, 2) +
        ";\n";
      const headers: Record<string, string> = {
        Authorization: "Bearer " + cfg.token,
        Accept: "application/vnd.github+json",
      };
      const url =
        "https://api.github.com/repos/" + cfg.owner + "/" + cfg.repo + "/contents/" + path;
      let sha: string | undefined;
      const getResp = await fetch(url + "?ref=" + encodeURIComponent(branch), { headers });
      if (getResp.ok) {
        const j = (await getResp.json()) as { sha?: string };
        sha = j.sha;
      }
      const body: Record<string, unknown> = {
        message: "backup: launchpad apps " + new Date().toISOString().slice(0, 10),
        content: utf8Base64(text),
        branch,
      };
      if (sha) body.sha = sha;
      const putResp = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!putResp.ok) throw new Error("github-" + putResp.status);
      try {
        localStorage.setItem("lp-backup-last", String(Date.now()));
      } catch {
        /* ignore */
      }
      this.toast("启动台数据已备份到 GitHub");
    } catch {
      this.toast("备份到 GitHub 失败，下次打开启动台时会重试");
    } finally {
      this.backupRunning = false;
    }
  }

  addAppsFromPaths(paths: string[]): number {
    let added = 0;
    let skipped = 0;
    for (const p of paths || []) {
      if (!p) continue;
      if (this.apps.some((a) => a.path.toLowerCase() === p.toLowerCase())) {
        skipped++;
        continue;
      }
      this.apps.push({
        id: uid(),
        name: nameFromPath(p),
        path: p,
        args: "",
        workdir: "",
        icon: "",
        elevated: false,
      });
      added++;
    }
    if (added) {
      this.save();
      this.toast("已添加 " + added + " 个应用" + (skipped ? "，跳过 " + skipped + " 个重复项" : ""));
    } else if (skipped) {
      this.toast("这些应用已经在启动台里了");
    }
    return added;
  }

  private async runWithArgs(item: LaunchpadApp): Promise<void> {
    const argsStr = (item.args || "").trim();
    const attempts: (string | string[] | null)[] = argsStr ? [argsStr, parseArgs(argsStr)] : [null];
    let lastErr: unknown = null;
    for (const attempt of attempts) {
      try {
        await invoke(SeelenCommand.Run, {
          program: item.path,
          args: attempt,
          workingDir: (item.workdir || "").trim() || null,
          elevated: !!item.elevated,
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("run-failed");
  }

  launch(item: LaunchpadApp): void {
    if (!this.widget) {
      this.toast("预览模式下不能启动程序，请在 Seelen UI 中使用");
      return;
    }
    const p = (item.path || "").trim();
    const isShortcut = /\.(lnk|url)$/i.test(p);
    const hasArgs = !!(item.args && item.args.trim());
    let promise: Promise<unknown>;
    if (item.elevated) {
      promise = this.runWithArgs(item);
    } else if (isShortcut) {
      promise = invoke(SeelenCommand.OpenFile, { path: p });
      if (hasArgs) this.toast("快捷方式将按原样打开，启动参数仅对 exe 路径生效");
    } else if (hasArgs) {
      promise = this.runWithArgs(item).catch((err) =>
        invoke(SeelenCommand.OpenFile, { path: p }).catch(() => {
          throw err;
        }),
      );
    } else {
      promise = invoke(SeelenCommand.OpenFile, { path: p }).catch(() => this.runWithArgs(item));
    }
    promise
      .then(() => this.closeWithAnimation())
      .catch((err) =>
        this.toast("启动失败：" + (err && (err as Error).message ? (err as Error).message : String(err))),
      );
  }

  openEditor(item: LaunchpadApp | null): void {
    this.editor = item
      ? {
          id: item.id,
          name: item.name || "",
          path: item.path || "",
          args: item.args || "",
          workdir: item.workdir || "",
          icon: item.icon || "",
          elevated: !!item.elevated,
        }
      : { id: null, name: "", path: "", args: "", workdir: "", icon: "", elevated: false };
  }

  closeEditor(): void {
    this.editor = null;
  }

  saveEditor(): void {
    const ed = this.editor;
    if (!ed) return;
    const path = ed.path.trim();
    if (!path) {
      this.toast("请先填写程序路径");
      return;
    }
    const data: Omit<LaunchpadApp, "id"> = {
      name: ed.name.trim() || nameFromPath(path),
      path,
      args: ed.args.trim(),
      workdir: ed.workdir.trim(),
      icon: ed.icon.trim(),
      elevated: ed.elevated,
    };
    if (ed.id) {
      this.apps = this.apps.map((a) => (a.id === ed.id ? { ...a, ...data } : a));
    } else {
      this.apps.push({ ...data, id: uid() });
    }
    this.save();
    this.closeEditor();
  }

  deleteEditorItem(): void {
    const ed = this.editor;
    if (!ed || !ed.id) return;
    this.apps = this.apps.filter((a) => a.id !== ed.id);
    this.save();
    this.closeEditor();
  }

  removeApp(item: LaunchpadApp): void {
    this.apps = this.apps.filter((a) => a.id !== item.id);
    this.save();
  }

  openMenu(x: number, y: number, item: LaunchpadApp): void {
    this.menu = { x, y, item };
  }

  hideMenu(): void {
    this.menu = null;
  }

  goToPage(pg: number, pageCount: number): void {
    this.page = Math.max(0, Math.min(pageCount - 1, pg));
  }

  async pickFiles(): Promise<void> {
    if (!this.widget) return;
    try {
      // Hide first: the native dialog would otherwise steal focus and the
      // lib's hide-on-focus-loss would hide us mid-flow anyway.
      await this.widget.hide();
      const picked = await openDialog({
        multiple: true,
        directory: false,
        filters: [{ name: "应用", extensions: ["exe", "lnk", "bat", "cmd"] }],
      });
      if (picked) {
        this.addAppsFromPaths(Array.isArray(picked) ? picked : [picked]);
      }
    } catch {
      this.toast("文件选择不可用，请在编辑模式下点 + 手动填写路径");
    }
    try {
      await this.fitWindow();
      await this.widget.show();
      await this.widget.focus();
    } catch {
      /* ignore */
    }
  }

  handleDragDrop(payload: { type: string; paths?: string[] }): void {
    if (!payload) return;
    if (payload.type === "enter" || payload.type === "over") {
      this.dragHover = true;
    } else if (payload.type === "leave") {
      this.dragHover = false;
    } else if (payload.type === "drop") {
      this.dragHover = false;
      this.addAppsFromPaths(payload.paths || []);
    }
  }

  noteFocusLoss(): void {
    this.lastFocusLossAt = Date.now();
  }

  async fitWindow(): Promise<void> {
    if (!this.widget) return;
    try {
      const monitor = await this.widget.window.currentMonitor();
      if (monitor) {
        const sf = monitor.scaleFactor || (await this.widget.window.scaleFactor()) || 1;
        const w = Math.round(monitor.size.width / sf);
        const h = Math.round(monitor.size.height / sf);
        await this.widget.window.setSize(
          new LogicalSize(Math.floor(w * 0.94), Math.floor(h * 0.92)),
        );
        await this.widget.window.center();
        return;
      }
    } catch {
      /* fall through to the windowed size */
    }
    try {
      await this.widget.window.setSize(new LogicalSize(720, 560));
      await this.widget.window.center();
    } catch {
      /* ignore */
    }
  }

  playOpenAnimation(): void {
    this.opening = false;
    // restart the CSS animation on the next frame
    requestAnimationFrame(() => {
      this.opening = true;
      setTimeout(() => {
        this.opening = false;
      }, 320);
    });
  }

  async closeWithAnimation(): Promise<void> {
    if (!this.widget || this.closing) return;
    this.closing = true;
    this.opening = false;
    await new Promise((r) => setTimeout(r, 190));
    try {
      await this.widget.hide();
    } catch {
      /* ignore */
    }
    this.closing = false;
  }

  async handleTrigger(): Promise<void> {
    if (!this.widget || this.closing) return;
    const visible = await this.widget.window.isVisible();
    if (visible) {
      await this.closeWithAnimation();
      return;
    }
    if (Date.now() - this.lastFocusLossAt < 600) return;
    await this.fitWindow();
    await this.widget.show();
    await this.widget.focus();
    this.playOpenAnimation();
    this.focusNonce++;
    void this.maybeBackup();
  }
}

export const lpState = new LaunchpadState();
