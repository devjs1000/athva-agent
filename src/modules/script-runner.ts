import { invoke } from "@tauri-apps/api/core";
import type { TerminalPanel } from "./terminal";

type RunnerItem =
  | { type: "script"; name: string; command: string; pm: string }
  | { type: "builtin"; name: string; command: string; description: string };

export class ScriptRunner {
  private overlay: HTMLElement;
  private listEl: HTMLElement;
  private terminal: TerminalPanel;
  private projectPath: string = "";

  constructor(terminal: TerminalPanel) {
    this.overlay = document.getElementById("script-runner-overlay")!;
    this.listEl = document.getElementById("script-runner-list")!;
    this.terminal = terminal;

    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) {
        e.preventDefault();
        this.close();
      }
    });
  }

  setProject(path: string) {
    this.projectPath = path;
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains("hidden");
  }

  async open() {
    if (!this.projectPath) return;

    const scripts = await this.readScripts();
    const pm = await this.detectPackageManager();
    const items = this.getRunnerItems(scripts || {}, pm);

    if (items.length === 0) {
      this.listEl.innerHTML = `<div class="quick-open-empty">No run options available</div>`;
      this.overlay.classList.remove("hidden");
      return;
    }

    this.listEl.innerHTML = items
      .map(
        (item, index) => `
        <div class="quick-open-item script-item" data-index="${index}">
          <span class="script-item-icon">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a.5.5 0 0 1 .812-.39l8 5.5a.5.5 0 0 1 0 .78l-8 5.5A.5.5 0 0 1 4 13V2z"/></svg>
          </span>
          <span class="quick-open-item-name">${this.escapeHtml(item.name)}</span>
          <span class="quick-open-item-path">${this.escapeHtml(item.type === "script" ? item.command : item.description)}</span>
        </div>`
      )
      .join("");

    this.listEl.querySelectorAll(".script-item").forEach((el) => {
      el.addEventListener("click", () => {
        const item = items[Number((el as HTMLElement).dataset.index)];
        if (!item) return;
        this.close();
        this.runItem(item);
      });
    });

    this.overlay.classList.remove("hidden");
  }

  close() {
    this.overlay.classList.add("hidden");
  }

  private async readScripts(): Promise<Record<string, string> | null> {
    const pkgPath = `${this.projectPath}/package.json`;
    try {
      const content = await invoke<string>("read_file", { path: pkgPath });
      const pkg = JSON.parse(content);
      return pkg.scripts || null;
    } catch {
      return null;
    }
  }

  private async detectPackageManager(): Promise<string> {
    // Check for lockfiles to detect package manager
    const checks: [string, string][] = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["package-lock.json", "npm"],
    ];

    for (const [file, pm] of checks) {
      try {
        const exists = await invoke<boolean>("check_path_exists", {
          path: `${this.projectPath}/${file}`,
        });
        if (exists) return pm;
      } catch {
        continue;
      }
    }

    return "npm";
  }

  private getRunnerItems(scripts: Record<string, string>, pm: string): RunnerItem[] {
    const scriptItems: RunnerItem[] = Object.entries(scripts).map(([name, command]) => ({
      type: "script",
      name,
      command,
      pm,
    }));

    return [
      {
        type: "builtin",
        name: "Live Server",
        command: this.getServeCommand(pm),
        description: "Serve this project folder locally with serve",
      },
      ...scriptItems,
    ];
  }

  private getServeCommand(pm: string): string {
    if (pm === "pnpm") return "pnpm dlx serve .";
    if (pm === "yarn") return "yarn dlx serve .";
    if (pm === "bun") return "bunx serve .";
    return "npx serve .";
  }

  private runItem(item: RunnerItem) {
    const command = item.type === "script" ? `${item.pm} run ${item.name}` : item.command;
    this.terminal.runCommand(command);
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

}
