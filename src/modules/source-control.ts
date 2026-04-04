import { invoke } from "@tauri-apps/api/core";
import type { AISettings } from "./settings";

interface GitFileChange {
  path: string;
  status: string; // "M", "A", "D", "R", "?", "U"
  staged: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  "?": "Untracked",
  U: "Conflict",
};

const STATUS_COLORS: Record<string, string> = {
  M: "#e2c08d",
  A: "#73c991",
  D: "#c74e39",
  R: "#73c991",
  "?": "#73c991",
  U: "#e5c07b",
};

export class SourceControl {
  private panelEl: HTMLElement;
  private resizeEl: HTMLElement;
  private commitInput: HTMLTextAreaElement;
  private stagedListEl: HTMLElement;
  private changesListEl: HTMLElement;
  private stagedHeaderEl: HTMLElement;
  private changesHeaderEl: HTMLElement;
  private projectPath = "";
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isBusy = false;
  private onResize: () => void;
  private getAISettings: () => AISettings;

  constructor(onResize: () => void, getAISettings: () => AISettings) {
    this.onResize = onResize;
    this.getAISettings = getAISettings;
    this.panelEl = document.getElementById("source-control-panel")!;
    this.resizeEl = document.getElementById("source-control-resize")!;
    this.commitInput = document.getElementById("scm-commit-input") as HTMLTextAreaElement;
    this.stagedListEl = document.getElementById("scm-staged-list")!;
    this.changesListEl = document.getElementById("scm-changes-list")!;
    this.stagedHeaderEl = document.getElementById("scm-staged-header")!;
    this.changesHeaderEl = document.getElementById("scm-changes-header")!;

    // Commit button
    document.getElementById("btn-scm-commit")!.addEventListener("click", () => this.commit());

    // Commit on Ctrl/Cmd+Enter in the input
    this.commitInput.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.commit();
      }
    });

    // Stage all / unstage all
    document.getElementById("btn-scm-stage-all")!.addEventListener("click", () => this.stageAll());
    document.getElementById("btn-scm-unstage-all")!.addEventListener("click", () => this.unstageAll());

    // AI generate commit message
    document.getElementById("btn-scm-ai-msg")!.addEventListener("click", () => this.generateCommitMessage());

    // Refresh
    document.getElementById("btn-scm-refresh")!.addEventListener("click", () => this.refresh());

    // Close
    document.getElementById("btn-close-scm")!.addEventListener("click", () => this.toggle());

    // Section collapse toggles
    this.stagedHeaderEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".scm-section-action")) return;
      this.stagedListEl.classList.toggle("collapsed");
      this.stagedHeaderEl.querySelector(".scm-chevron")?.classList.toggle("collapsed");
    });
    this.changesHeaderEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".scm-section-action")) return;
      this.changesListEl.classList.toggle("collapsed");
      this.changesHeaderEl.querySelector(".scm-chevron")?.classList.toggle("collapsed");
    });
  }

  setProject(path: string) {
    this.projectPath = path;
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.refresh();
    this.pollInterval = setInterval(() => {
      if (!this.panelEl.classList.contains("hidden")) {
        this.refresh();
      }
    }, 5000);
  }

  toggle() {
    const isVisible = !this.panelEl.classList.contains("hidden");
    if (isVisible) {
      this.panelEl.classList.add("hidden");
      this.resizeEl.classList.add("hidden");
    } else {
      this.panelEl.classList.remove("hidden");
      this.resizeEl.classList.remove("hidden");
      this.refresh();
    }
    setTimeout(() => this.onResize(), 0);
  }

  isOpen(): boolean {
    return !this.panelEl.classList.contains("hidden");
  }

  async refresh() {
    if (!this.projectPath) return;

    try {
      const files = await invoke<GitFileChange[]>("git_changed_files", { path: this.projectPath });

      const staged = files.filter((f) => f.staged);
      const unstaged = files.filter((f) => !f.staged);

      this.renderFileList(this.stagedListEl, staged, true);
      this.renderFileList(this.changesListEl, unstaged, false);

      // Update counts in headers
      const stagedCount = this.stagedHeaderEl.querySelector(".scm-section-count")!;
      const changesCount = this.changesHeaderEl.querySelector(".scm-section-count")!;
      stagedCount.textContent = staged.length.toString();
      changesCount.textContent = unstaged.length.toString();

      // Update badge on nav button
      const badge = document.getElementById("scm-badge");
      const total = files.length;
      if (badge) {
        badge.textContent = total.toString();
        badge.classList.toggle("hidden", total === 0);
      }
    } catch {
      // Not a git repo or error
      this.stagedListEl.innerHTML = "";
      this.changesListEl.innerHTML = "";
    }
  }

  private renderFileList(container: HTMLElement, files: GitFileChange[], isStaged: boolean) {
    if (files.length === 0) {
      container.innerHTML = `<div class="scm-empty">No ${isStaged ? "staged" : ""} changes</div>`;
      return;
    }

    container.innerHTML = files
      .map((f) => {
        const fileName = f.path.split("/").pop() || f.path;
        const dir = f.path.includes("/") ? f.path.substring(0, f.path.lastIndexOf("/")) : "";
        const color = STATUS_COLORS[f.status] || "#ccc";
        const label = STATUS_LABELS[f.status] || f.status;

        return `<div class="scm-file-item" data-path="${this.escHtml(f.path)}" data-staged="${isStaged}" title="${this.escHtml(f.path)} - ${label}">
          <span class="scm-file-name">${this.escHtml(fileName)}${dir ? `<span class="scm-file-dir"> ${this.escHtml(dir)}</span>` : ""}</span>
          <div class="scm-file-actions">
            ${
              isStaged
                ? `<button class="scm-file-action" data-action="unstage" title="Unstage">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.418A6 6 0 1 0 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z"/></svg>
                  </button>`
                : `<button class="scm-file-action" data-action="discard" title="Discard Changes">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854z"/></svg>
                  </button>
                  <button class="scm-file-action" data-action="stage" title="Stage">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/></svg>
                  </button>`
            }
          </div>
          <span class="scm-file-badge" style="color: ${color}">${this.escHtml(f.status)}</span>
        </div>`;
      })
      .join("");

    // Bind click events
    container.querySelectorAll(".scm-file-action").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const item = (btn as HTMLElement).closest(".scm-file-item") as HTMLElement;
        const filePath = item.dataset.path!;
        const action = (btn as HTMLElement).dataset.action!;
        this.handleFileAction(action, filePath);
      });
    });

    // Click on file to show diff
    container.querySelectorAll(".scm-file-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".scm-file-action")) return;
        const el = item as HTMLElement;
        this.showDiff(el.dataset.path!, el.dataset.staged === "true");
      });
    });
  }

  private async handleFileAction(action: string, filePath: string) {
    if (this.isBusy || !this.projectPath) return;
    this.isBusy = true;

    try {
      switch (action) {
        case "stage":
          await invoke("git_stage", { path: this.projectPath, file: filePath });
          break;
        case "unstage":
          await invoke("git_unstage", { path: this.projectPath, file: filePath });
          break;
        case "discard":
          await invoke("git_discard_file", { path: this.projectPath, file: filePath });
          break;
      }
      await this.refresh();
    } catch (e) {
      console.error(`Git ${action} failed:`, e);
    } finally {
      this.isBusy = false;
    }
  }

  private async stageAll() {
    if (this.isBusy || !this.projectPath) return;
    this.isBusy = true;
    try {
      await invoke("git_stage_all", { path: this.projectPath });
      await this.refresh();
    } catch (e) {
      console.error("Git stage all failed:", e);
    } finally {
      this.isBusy = false;
    }
  }

  private async unstageAll() {
    if (this.isBusy || !this.projectPath) return;
    this.isBusy = true;
    try {
      await invoke("git_unstage_all", { path: this.projectPath });
      await this.refresh();
    } catch (e) {
      console.error("Git unstage all failed:", e);
    } finally {
      this.isBusy = false;
    }
  }

  private async commit() {
    const message = this.commitInput.value.trim();
    if (!message || this.isBusy || !this.projectPath) return;
    this.isBusy = true;

    try {
      await invoke("git_commit", { path: this.projectPath, message });
      this.commitInput.value = "";
      await this.refresh();
    } catch (e) {
      console.error("Git commit failed:", e);
    } finally {
      this.isBusy = false;
    }
  }

  private async generateCommitMessage() {
    if (this.isBusy || !this.projectPath) return;

    const settings = this.getAISettings();
    if (!settings.apiKey) {
      this.commitInput.value = "Error: No API key configured. Go to Settings.";
      return;
    }

    const aiBtn = document.getElementById("btn-scm-ai-msg")!;
    aiBtn.setAttribute("disabled", "true");
    this.commitInput.value = "Generating...";

    try {
      // Get only a compact summary — no full file contents
      const files = await invoke<GitFileChange[]>("git_changed_files", { path: this.projectPath });
      const diffStat = await invoke<string>("git_diff_stat", { path: this.projectPath });

      const summary = files
        .map((f) => `${f.staged ? "[staged]" : "[unstaged]"} ${f.status} ${f.path}`)
        .join("\n");

      const prompt =
        `Generate a concise conventional commit message (one line, max 72 chars) for these changes.\n` +
        `Only return the commit message, nothing else.\n\n` +
        `Changed files:\n${summary}\n\nDiff stat:\n${diffStat}`;

      const message = await this.callAI(settings, prompt);
      this.commitInput.value = message.trim().replace(/^["']|["']$/g, "");
    } catch (e) {
      console.error("AI commit message failed:", e);
      this.commitInput.value = "";
    } finally {
      aiBtn.removeAttribute("disabled");
      this.commitInput.focus();
    }
  }

  private async callAI(settings: AISettings, prompt: string): Promise<string> {
    const messages = [{ role: "user", content: prompt }];

    switch (settings.provider) {
      case "openai":
      case "mimo":
      case "mistral": {
        const urls: Record<string, string> = {
          openai: "https://api.openai.com/v1/chat/completions",
          mimo: "https://api.xiaomimimo.com/v1/chat/completions",
          mistral: "https://api.mistral.ai/v1/chat/completions",
        };
        const res = await fetch(urls[settings.provider], {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify({
            model: settings.model || "gpt-4o-mini",
            messages,
            max_tokens: 512,
          }),
        });
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const data = await res.json();
        const msg = data.choices?.[0]?.message;
        // Some reasoning models (MiMo) put the answer in content and reasoning in reasoning_content.
        // If content is empty, the model may have exhausted tokens on reasoning — use reasoning_content as fallback.
        return msg?.content || msg?.reasoning_content || "";
      }

      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: settings.model || "claude-sonnet-4-20250514",
            max_tokens: 256,
            messages,
          }),
        });
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const data = await res.json();
        return data.content?.[0]?.text || "";
      }

      case "google": {
        const model = settings.model || "gemini-2.0-flash";
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 256 },
            }),
          }
        );
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }

      default:
        throw new Error(`Unknown provider: ${settings.provider}`);
    }
  }

  private async showDiff(filePath: string, staged: boolean) {
    if (!this.projectPath) return;

    try {
      const diff = await invoke<string>("git_diff_file", {
        path: this.projectPath,
        file: filePath,
        staged,
      });

      const diffView = document.getElementById("scm-diff-view")!;
      const diffTitle = document.getElementById("scm-diff-title")!;
      const diffContent = document.getElementById("scm-diff-content")!;

      diffTitle.textContent = filePath;
      diffContent.innerHTML = this.renderDiff(diff || "(No diff available — file may be untracked or binary)");
      diffView.classList.remove("hidden");
    } catch (e) {
      console.error("Failed to get diff:", e);
    }
  }

  private renderDiff(diff: string): string {
    return diff
      .split("\n")
      .map((line) => {
        let cls = "diff-line";
        if (line.startsWith("+") && !line.startsWith("+++")) cls += " diff-add";
        else if (line.startsWith("-") && !line.startsWith("---")) cls += " diff-del";
        else if (line.startsWith("@@")) cls += " diff-hunk";
        return `<div class="${cls}">${this.escHtml(line)}</div>`;
      })
      .join("");
  }

  private escHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  destroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
