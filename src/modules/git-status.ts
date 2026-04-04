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
  private syncBtn: HTMLElement;
  private projectPath: string = "";
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isBusy = false;
  private ahead = 0;
  private behind = 0;

  constructor() {
    this.statusEl = document.getElementById("git-status")!;
    this.branchEl = document.getElementById("git-branch")!;
    this.aheadBehindEl = document.getElementById("git-ahead-behind")!;
    this.syncBtn = document.getElementById("btn-git-sync")!;

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
    this.syncBtn.classList.add("hidden");
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private show() {
    this.statusEl.classList.remove("hidden");
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
      this.ahead = status.ahead;
      this.behind = status.behind;
      this.branchEl.textContent = status.branch || "HEAD";

      const parts: string[] = [];
      if (status.behind > 0) parts.push(`\u2193${status.behind}`);
      if (status.ahead > 0) parts.push(`\u2191${status.ahead}`);
      this.aheadBehindEl.textContent = parts.join(" ");

      this.updateSyncTooltip();
    } catch {
      this.hide();
    }
  }

  private updateSyncTooltip() {
    if (this.ahead > 0 && this.behind > 0) {
      this.syncBtn.title = "Pull then Push";
    } else if (this.ahead > 0) {
      this.syncBtn.title = "Push";
    } else if (this.behind > 0) {
      this.syncBtn.title = "Pull";
    } else {
      this.syncBtn.title = "Sync";
    }
  }

  private async sync() {
    if (this.isBusy || !this.projectPath) return;
    this.setBusy(true);
    try {
      if (this.ahead > 0 && this.behind > 0) {
        // Both: pull first, then push
        await invoke("git_sync", { path: this.projectPath });
      } else if (this.ahead > 0) {
        // Only commits to push
        await invoke("git_push", { path: this.projectPath });
      } else if (this.behind > 0) {
        // Only remote commits to pull
        await invoke("git_pull", { path: this.projectPath });
      }
    } catch (e) {
      console.error("Git sync failed:", e);
    } finally {
      this.setBusy(false);
      await this.refresh();
    }
  }

  private setBusy(busy: boolean) {
    this.isBusy = busy;
    if (busy) {
      this.syncBtn.setAttribute("disabled", "true");
      this.syncBtn.classList.add("syncing");
    } else {
      this.syncBtn.removeAttribute("disabled");
      this.syncBtn.classList.remove("syncing");
    }
  }
}
