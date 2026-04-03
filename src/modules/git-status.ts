import { invoke } from "@tauri-apps/api/core";

interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  is_repo: boolean;
}

export class GitStatusBar {
  private statusEl: HTMLElement;
  private branchEl: HTMLElement;
  private aheadBehindEl: HTMLElement;
  private pullBtn: HTMLElement;
  private pushBtn: HTMLElement;
  private syncBtn: HTMLElement;
  private projectPath: string = "";
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isBusy = false;

  constructor() {
    this.statusEl = document.getElementById("git-status")!;
    this.branchEl = document.getElementById("git-branch")!;
    this.aheadBehindEl = document.getElementById("git-ahead-behind")!;
    this.pullBtn = document.getElementById("btn-git-pull")!;
    this.pushBtn = document.getElementById("btn-git-push")!;
    this.syncBtn = document.getElementById("btn-git-sync")!;

    this.pullBtn.addEventListener("click", () => this.pull());
    this.pushBtn.addEventListener("click", () => this.push());
    this.syncBtn.addEventListener("click", () => this.sync());
  }

  async setProject(path: string) {
    this.projectPath = path;
    if (this.pollInterval) clearInterval(this.pollInterval);
    await this.refresh();
    this.pollInterval = setInterval(() => this.refresh(), 10000);
  }

  hide() {
    this.statusEl.classList.add("hidden");
    this.pullBtn.classList.add("hidden");
    this.pushBtn.classList.add("hidden");
    this.syncBtn.classList.add("hidden");
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private show() {
    this.statusEl.classList.remove("hidden");
    this.pullBtn.classList.remove("hidden");
    this.pushBtn.classList.remove("hidden");
    this.syncBtn.classList.remove("hidden");
  }

  async refresh() {
    if (!this.projectPath) return;

    try {
      const status = await invoke<GitStatusResult>("git_status", { path: this.projectPath });

      if (!status.is_repo) {
        this.hide();
        return;
      }

      this.show();
      this.branchEl.textContent = status.branch || "HEAD";

      // Show ahead/behind in sync button like VS Code: ↓1 ↑2
      const parts: string[] = [];
      if (status.behind > 0) parts.push(`\u2193${status.behind}`);
      if (status.ahead > 0) parts.push(`\u2191${status.ahead}`);
      this.aheadBehindEl.textContent = parts.join(" ");
    } catch {
      this.hide();
    }
  }

  private async pull() {
    if (this.isBusy || !this.projectPath) return;
    this.setBusy(true);
    try {
      await invoke("git_pull", { path: this.projectPath });
    } catch (e) {
      console.error("Git pull failed:", e);
    } finally {
      this.setBusy(false);
      await this.refresh();
    }
  }

  private async push() {
    if (this.isBusy || !this.projectPath) return;
    this.setBusy(true);
    try {
      await invoke("git_push", { path: this.projectPath });
    } catch (e) {
      console.error("Git push failed:", e);
    } finally {
      this.setBusy(false);
      await this.refresh();
    }
  }

  private async sync() {
    if (this.isBusy || !this.projectPath) return;
    this.setBusy(true);
    try {
      await invoke("git_sync", { path: this.projectPath });
    } catch (e) {
      console.error("Git sync failed:", e);
    } finally {
      this.setBusy(false);
      await this.refresh();
    }
  }

  private setBusy(busy: boolean) {
    this.isBusy = busy;
    const btns = [this.pullBtn, this.pushBtn, this.syncBtn];
    if (busy) {
      btns.forEach((b) => b.setAttribute("disabled", "true"));
      this.syncBtn.classList.add("syncing");
    } else {
      btns.forEach((b) => b.removeAttribute("disabled"));
      this.syncBtn.classList.remove("syncing");
    }
  }
}
