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
    // Poll every 10 seconds
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

  async refresh() {
    if (!this.projectPath) return;

    try {
      const status = await invoke<GitStatusResult>("git_status", { path: this.projectPath });

      if (!status.is_repo) {
        this.hide();
        return;
      }

      this.statusEl.classList.remove("hidden");
      this.pullBtn.classList.remove("hidden");
      this.pushBtn.classList.remove("hidden");
      this.syncBtn.classList.remove("hidden");

      this.branchEl.textContent = status.branch || "HEAD";

      const parts: string[] = [];
      if (status.ahead > 0) parts.push(`${status.ahead}\u2191`);
      if (status.behind > 0) parts.push(`${status.behind}\u2193`);
      this.aheadBehindEl.textContent = parts.length > 0 ? parts.join(" ") : "";
    } catch {
      this.hide();
    }
  }

  private async pull() {
    if (!this.projectPath) return;
    this.pullBtn.setAttribute("disabled", "true");
    this.pullBtn.textContent = "Pulling...";
    try {
      await invoke("git_pull", { path: this.projectPath });
    } catch (e) {
      console.error("Git pull failed:", e);
    } finally {
      this.pullBtn.removeAttribute("disabled");
      this.pullBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 1a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 13.293V1.5A.5.5 0 0 1 8 1z"/></svg> Pull`;
      await this.refresh();
    }
  }

  private async push() {
    if (!this.projectPath) return;
    this.pushBtn.setAttribute("disabled", "true");
    this.pushBtn.textContent = "Pushing...";
    try {
      await invoke("git_push", { path: this.projectPath });
    } catch (e) {
      console.error("Git push failed:", e);
    } finally {
      this.pushBtn.removeAttribute("disabled");
      this.pushBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 .5.5z"/></svg> Push`;
      await this.refresh();
    }
  }

  private async sync() {
    if (!this.projectPath) return;
    this.syncBtn.setAttribute("disabled", "true");
    this.syncBtn.textContent = "Syncing...";
    try {
      await invoke("git_sync", { path: this.projectPath });
    } catch (e) {
      console.error("Git sync failed:", e);
    } finally {
      this.syncBtn.removeAttribute("disabled");
      this.syncBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg> Sync`;
      await this.refresh();
    }
  }
}
