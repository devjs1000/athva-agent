import { invoke } from "@tauri-apps/api/core";
import { showConfirmDialog } from "./dialogs";

interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  is_repo: boolean;
}

interface GitBranchResult {
  name: string;
  current: boolean;
}

export class GitStatusBar {
  private statusEl: HTMLElement;
  private branchEl: HTMLElement;
  private aheadBehindEl: HTMLElement;
  private syncBtn: HTMLElement;
  private branchMenuEl: HTMLElement;
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
    this.branchMenuEl = document.createElement("div");
    this.branchMenuEl.className = "context-menu hidden git-branch-menu";
    document.body.appendChild(this.branchMenuEl);

    this.syncBtn.addEventListener("click", () => this.sync());
    this.statusEl.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openBranchMenu();
    });
    document.addEventListener("click", () => this.closeBranchMenu());
    document.addEventListener("contextmenu", (e) => {
      if (!this.branchMenuEl.contains(e.target as Node)) {
        this.closeBranchMenu();
      }
    });
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
    this.closeBranchMenu();
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
      this.statusEl.setAttribute("disabled", "true");
      this.syncBtn.classList.add("syncing");
    } else {
      this.syncBtn.removeAttribute("disabled");
      this.statusEl.removeAttribute("disabled");
      this.syncBtn.classList.remove("syncing");
    }
  }

  private async openBranchMenu() {
    if (this.isBusy || !this.projectPath) return;

    try {
      const branches = await invoke<GitBranchResult[]>("git_list_branches", { path: this.projectPath });
      if (branches.length === 0) return;

      this.branchMenuEl.innerHTML = "";
      for (const branch of branches) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `context-menu-item git-branch-menu-item${branch.current ? " current" : ""}`;
        item.innerHTML = `
          <span class="git-branch-menu-check">${branch.current ? "\u2713" : ""}</span>
          <span>${this.escapeHtml(branch.name)}</span>
        `;
        item.addEventListener("click", async (e) => {
          e.stopPropagation();
          this.closeBranchMenu();
          if (branch.current) return;
          await this.switchBranch(branch.name);
        });
        this.branchMenuEl.appendChild(item);
      }

      const rect = this.statusEl.getBoundingClientRect();
      this.branchMenuEl.classList.remove("hidden");
      this.branchMenuEl.style.left = `${rect.left}px`;
      this.branchMenuEl.style.top = `${rect.top - this.branchMenuEl.offsetHeight - 4}px`;

      requestAnimationFrame(() => {
        const menuRect = this.branchMenuEl.getBoundingClientRect();
        if (menuRect.right > window.innerWidth) {
          this.branchMenuEl.style.left = `${window.innerWidth - menuRect.width - 4}px`;
        }
        if (menuRect.top < 0) {
          this.branchMenuEl.style.top = `${rect.bottom + 4}px`;
        }
      });
    } catch (e) {
      console.error("Failed to list branches:", e);
      await showConfirmDialog("Git Error", this.formatErrorMessage(e), "OK");
    }
  }

  private closeBranchMenu() {
    this.branchMenuEl.classList.add("hidden");
  }

  private async switchBranch(branch: string) {
    if (this.isBusy || !this.projectPath) return;
    this.setBusy(true);
    try {
      await invoke("git_switch_branch", { path: this.projectPath, branch });
    } catch (e) {
      console.error("Git branch switch failed:", e);
      await showConfirmDialog("Git Branch Switch Failed", this.formatErrorMessage(e), "OK");
    } finally {
      this.setBusy(false);
      await this.refresh();
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  private formatErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  }
}
