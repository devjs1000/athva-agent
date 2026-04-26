import type { ExtensionCommand } from "./vscode-extension-support";

export type OnCommandExecute = (command: ExtensionCommand) => void;

export class CommandPalette {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private resultsList: HTMLElement;
  private onExecute: OnCommandExecute;
  private commands: ExtensionCommand[] = [];
  private filtered: ExtensionCommand[] = [];
  private selectedIndex = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private containerFilter: string | null = null;

  constructor(onExecute: OnCommandExecute) {
    this.onExecute = onExecute;
    this.overlay = document.getElementById("command-palette-overlay")!;
    this.input = document.getElementById("command-palette-input") as HTMLInputElement;
    this.resultsList = document.getElementById("command-palette-results")!;

    this.input.addEventListener("input", () => this.onInputChange());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  setExtensionCommands(commands: ExtensionCommand[]) {
    this.commands = commands;
    if (!this.overlay.classList.contains("hidden")) {
      this.filter(this.input.value.trim());
    }
  }

  open() {
    this.containerFilter = null;
    this.input.placeholder = "Search extension commands…";
    this._open();
  }

  openFilteredToContainer(containerId: string, containerTitle: string) {
    this.containerFilter = containerId;
    this.input.placeholder = `Commands in ${containerTitle}…`;
    this._open();
  }

  close() {
    this.overlay.classList.add("hidden");
    this.input.value = "";
    this.resultsList.innerHTML = "";
    this.containerFilter = null;
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains("hidden");
  }

  private _open() {
    this.input.value = "";
    this.selectedIndex = 0;
    this.overlay.classList.remove("hidden");
    this.input.focus();
    this.filter("");
  }

  private onInputChange() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.filter(this.input.value.trim()), 60);
  }

  private filter(query: string) {
    let pool = this.commands;

    if (this.containerFilter) {
      pool = pool.filter((cmd) => {
        const prefix = this.containerFilter! + ".";
        return cmd.command.startsWith(prefix) || cmd.command === this.containerFilter;
      });
    }

    const lower = query.toLowerCase();
    this.filtered = pool.filter((cmd) => {
      if (!lower) return true;
      const label = cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title;
      return label.toLowerCase().includes(lower) || cmd.command.toLowerCase().includes(lower);
    });

    this.selectedIndex = 0;
    this.render();
  }

  private render() {
    if (!this.filtered.length) {
      this.resultsList.innerHTML = `<div class="quick-open-empty">${this.commands.length ? "No matching commands" : "No extension commands registered"}</div>`;
      return;
    }

    this.resultsList.innerHTML = this.filtered
      .map((cmd, idx) => {
        const label = cmd.category ? `${this.escapeHtml(cmd.category)}: ${this.escapeHtml(cmd.title)}` : this.escapeHtml(cmd.title);
        const id = this.escapeHtml(cmd.command);
        return `<div class="quick-open-item ${idx === this.selectedIndex ? "selected" : ""}" data-index="${idx}">
          <span class="quick-open-item-icon command-palette-icon">${cmd.iconCodicon ? this.escapeHtml(cmd.iconCodicon) : "⌘"}</span>
          <span class="quick-open-item-name">${label}</span>
          <span class="quick-open-item-path">${id}</span>
        </div>`;
      })
      .join("");

    this.resultsList.querySelectorAll(".quick-open-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt((el as HTMLElement).dataset.index ?? "0");
        this.select(idx);
      });
      el.addEventListener("mouseenter", () => {
        this.selectedIndex = parseInt((el as HTMLElement).dataset.index ?? "0");
        this.updateSelection();
      });
    });

    this.scrollToSelected();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.filtered.length - 1);
      this.updateSelection();
      this.scrollToSelected();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.updateSelection();
      this.scrollToSelected();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.select(this.selectedIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  private select(index: number) {
    const cmd = this.filtered[index];
    if (!cmd) return;
    this.close();
    this.onExecute(cmd);
  }

  private updateSelection() {
    this.resultsList.querySelectorAll(".quick-open-item").forEach((el, i) => {
      el.classList.toggle("selected", i === this.selectedIndex);
    });
  }

  private scrollToSelected() {
    const selected = this.resultsList.querySelector(".quick-open-item.selected") as HTMLElement | null;
    selected?.scrollIntoView({ block: "nearest" });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
