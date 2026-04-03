import { invoke } from "@tauri-apps/api/core";
import { getFileIcon } from "./file-icons";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export type OnFileOpen = (path: string, name: string) => void;

export class QuickOpen {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private resultsList: HTMLElement;
  private onFileOpen: OnFileOpen;
  private projectRoot: string = "";
  private results: FileEntry[] = [];
  private selectedIndex: number = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onFileOpen: OnFileOpen) {
    this.overlay = document.getElementById("quick-open-overlay")!;
    this.input = document.getElementById("quick-open-input") as HTMLInputElement;
    this.resultsList = document.getElementById("quick-open-results")!;
    this.onFileOpen = onFileOpen;

    this.input.addEventListener("input", () => this.onInputChange());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  setProjectRoot(root: string) {
    this.projectRoot = root;
  }

  open() {
    if (!this.projectRoot) return;
    this.input.value = "";
    this.results = [];
    this.selectedIndex = 0;
    this.overlay.classList.remove("hidden");
    this.input.focus();
    this.search("");
  }

  close() {
    this.overlay.classList.add("hidden");
    this.input.value = "";
    this.resultsList.innerHTML = "";
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains("hidden");
  }

  private onInputChange() {
    const query = this.input.value.trim();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.search(query), 80);
  }

  private async search(query: string) {
    try {
      this.results = await invoke<FileEntry[]>("search_files", {
        root: this.projectRoot,
        query,
        maxResults: 50,
      });
    } catch {
      this.results = [];
    }
    this.selectedIndex = 0;
    this.renderResults();
  }

  private renderResults() {
    if (this.results.length === 0) {
      this.resultsList.innerHTML = `<div class="quick-open-empty">No files found</div>`;
      return;
    }

    this.resultsList.innerHTML = this.results
      .map((file, idx) => {
        const relPath = this.getRelativePath(file.path);
        const dir = relPath.includes("/")
          ? relPath.substring(0, relPath.lastIndexOf("/"))
          : "";
        return `<div class="quick-open-item ${idx === this.selectedIndex ? "selected" : ""}" data-index="${idx}">
          <span class="quick-open-item-icon">${getFileIcon(file.name)}</span>
          <span class="quick-open-item-name">${this.escapeHtml(file.name)}</span>
          <span class="quick-open-item-path">${this.escapeHtml(dir)}</span>
        </div>`;
      })
      .join("");

    this.resultsList.querySelectorAll(".quick-open-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt((el as HTMLElement).dataset.index || "0");
        this.selectItem(idx);
      });
      el.addEventListener("mouseenter", () => {
        const idx = parseInt((el as HTMLElement).dataset.index || "0");
        this.selectedIndex = idx;
        this.updateSelection();
      });
    });

    this.scrollToSelected();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.results.length - 1);
      this.updateSelection();
      this.scrollToSelected();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.updateSelection();
      this.scrollToSelected();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.selectItem(this.selectedIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  private selectItem(index: number) {
    const file = this.results[index];
    if (!file) return;
    this.close();
    this.onFileOpen(file.path, file.name);
  }

  private updateSelection() {
    this.resultsList.querySelectorAll(".quick-open-item").forEach((el, i) => {
      el.classList.toggle("selected", i === this.selectedIndex);
    });
  }

  private scrollToSelected() {
    const selected = this.resultsList.querySelector(".quick-open-item.selected") as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }

  private getRelativePath(fullPath: string): string {
    if (fullPath.startsWith(this.projectRoot)) {
      const rel = fullPath.substring(this.projectRoot.length);
      return rel.startsWith("/") ? rel.substring(1) : rel;
    }
    return fullPath;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
