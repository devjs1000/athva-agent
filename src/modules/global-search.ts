import { invoke } from "@tauri-apps/api/core";

interface SearchMatch {
  path: string;
  line: number;
  col: number;
  line_content: string;
  match_start: number;
  match_end: number;
}

export type OnOpenFile = (path: string, name: string, line?: number) => void;
export type OnFilesReplaced = (paths: string[]) => void;

export class GlobalSearch {
  private panel: HTMLElement;
  private queryInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private caseBtn: HTMLElement;
  private regexBtn: HTMLElement;
  private resultCountEl: HTMLElement;
  private resultsEl: HTMLElement;
  private toggleReplaceBtn: HTMLElement;
  private replaceAllBtn: HTMLElement;
  private sidebarTitle: HTMLElement;
  private fileTree: HTMLElement;
  private explorerInfo: HTMLElement | null;

  private projectRoot: string = "";
  private caseSensitive: boolean = false;
  private useRegex: boolean = false;
  private replaceVisible: boolean = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private results: SearchMatch[] = [];

  private onOpenFile: OnOpenFile;
  private onFilesReplaced: OnFilesReplaced;

  constructor(onOpenFile: OnOpenFile, onFilesReplaced: OnFilesReplaced) {
    this.onOpenFile = onOpenFile;
    this.onFilesReplaced = onFilesReplaced;

    this.panel = document.getElementById("global-search-panel")!;
    this.queryInput = document.getElementById("gs-query") as HTMLInputElement;
    this.replaceInput = document.getElementById("gs-replace") as HTMLInputElement;
    this.replaceRow = document.getElementById("gs-replace-row")!;
    this.caseBtn = document.getElementById("gs-case")!;
    this.regexBtn = document.getElementById("gs-regex")!;
    this.resultCountEl = document.getElementById("gs-result-count")!;
    this.resultsEl = document.getElementById("gs-results")!;
    this.toggleReplaceBtn = document.getElementById("gs-toggle-replace-btn")!;
    this.replaceAllBtn = document.getElementById("gs-replace-all-btn")!;
    this.sidebarTitle = document.getElementById("sidebar-title")!;
    this.fileTree = document.getElementById("file-tree")!;
    this.explorerInfo = document.getElementById("explorer-info");

    this.queryInput.addEventListener("input", () => this.scheduleSearch());
    this.queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      if (e.key === "Enter") this.runSearch();
    });
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });

    this.caseBtn.addEventListener("click", () => {
      this.caseSensitive = !this.caseSensitive;
      this.caseBtn.classList.toggle("active", this.caseSensitive);
      this.scheduleSearch();
    });

    this.regexBtn.addEventListener("click", () => {
      this.useRegex = !this.useRegex;
      this.regexBtn.classList.toggle("active", this.useRegex);
      this.scheduleSearch();
    });

    this.toggleReplaceBtn.addEventListener("click", () => this.toggleReplace());

    this.replaceAllBtn.addEventListener("click", () => this.replaceAll());
  }

  setProjectRoot(root: string) {
    this.projectRoot = root;
  }

  open() {
    this.panel.classList.remove("hidden");
    this.fileTree.classList.add("hidden");
    this.explorerInfo?.classList.add("hidden");
    this.sidebarTitle.textContent = "SEARCH";
    this.queryInput.focus();
    this.queryInput.select();
    if (this.queryInput.value) this.runSearch();
  }

  close() {
    this.panel.classList.add("hidden");
    this.fileTree.classList.remove("hidden");
    this.explorerInfo?.classList.remove("hidden");
    this.sidebarTitle.textContent = "EXPLORER";
  }

  isOpen(): boolean {
    return !this.panel.classList.contains("hidden");
  }

  prefill(text: string) {
    this.queryInput.value = text;
  }

  private toggleReplace() {
    this.replaceVisible = !this.replaceVisible;
    this.replaceRow.classList.toggle("hidden", !this.replaceVisible);
    if (this.replaceVisible) this.replaceInput.focus();
  }

  private scheduleSearch() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.runSearch(), 200);
  }

  private async runSearch() {
    const query = this.queryInput.value;
    if (!query || !this.projectRoot) {
      this.results = [];
      this.renderResults();
      return;
    }

    try {
      this.results = await invoke<SearchMatch[]>("search_in_files", {
        root: this.projectRoot,
        query,
        caseSensitive: this.caseSensitive,
        useRegex: this.useRegex,
        maxResults: 500,
      });
    } catch (e) {
      this.results = [];
      this.resultCountEl.textContent = `Error: ${e}`;
      return;
    }

    this.renderResults();
  }

  private renderResults() {
    const total = this.results.length;
    if (total === 0) {
      this.resultCountEl.textContent = this.queryInput.value ? "No results" : "";
      this.resultsEl.innerHTML = "";
      return;
    }

    // Group by file path
    const byFile = new Map<string, SearchMatch[]>();
    for (const m of this.results) {
      if (!byFile.has(m.path)) byFile.set(m.path, []);
      byFile.get(m.path)!.push(m);
    }

    const fileCount = byFile.size;
    this.resultCountEl.textContent = `${total} result${total !== 1 ? "s" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}`;

    this.resultsEl.innerHTML = "";
    const query = this.queryInput.value;

    for (const [filePath, matches] of byFile) {
      const fileName = filePath.split("/").pop() || filePath;
      const relPath = this.projectRoot && filePath.startsWith(this.projectRoot)
        ? filePath.slice(this.projectRoot.length).replace(/^\//, "")
        : filePath;

      const group = document.createElement("div");
      group.className = "gs-file-group";

      const header = document.createElement("div");
      header.className = "gs-file-header";
      header.innerHTML = `
        <span class="gs-file-chevron">&#9660;</span>
        <span class="gs-file-name" title="${this.escapeAttr(relPath)}">${this.escapeHtml(fileName)}</span>
        <span class="gs-file-count">${matches.length}</span>
      `;
      header.addEventListener("click", () => {
        group.classList.toggle("collapsed");
      });
      group.appendChild(header);

      const matchList = document.createElement("div");
      matchList.className = "gs-file-matches";

      for (const m of matches) {
        const row = document.createElement("div");
        row.className = "gs-match";
        const lineNum = document.createElement("span");
        lineNum.className = "gs-match-line";
        lineNum.textContent = String(m.line);

        const text = document.createElement("span");
        text.className = "gs-match-text";
        text.innerHTML = this.highlightMatch(m.line_content, m.match_start, m.match_end, query);

        row.appendChild(lineNum);
        row.appendChild(text);
        row.addEventListener("click", () => {
          const name = filePath.split("/").pop() || filePath;
          this.onOpenFile(filePath, name, m.line);
        });
        matchList.appendChild(row);
      }

      group.appendChild(matchList);
      this.resultsEl.appendChild(group);
    }
  }

  private async replaceAll() {
    const query = this.queryInput.value;
    const replacement = this.replaceInput.value;
    if (!query || !this.projectRoot) return;

    const paths = [...new Set(this.results.map((m) => m.path))];
    if (paths.length === 0) return;

    try {
      const count = await invoke<number>("replace_in_files", {
        paths,
        query,
        replacement,
        caseSensitive: this.caseSensitive,
        useRegex: this.useRegex,
      });
      this.onFilesReplaced(paths);
      await this.runSearch();
      this.resultCountEl.textContent = `Replaced ${count} occurrence${count !== 1 ? "s" : ""}`;
    } catch (e) {
      this.resultCountEl.textContent = `Replace error: ${e}`;
    }
  }

  private highlightMatch(line: string, start: number, end: number, _query: string): string {
    const pre = this.escapeHtml(line.slice(0, start));
    const match = this.escapeHtml(line.slice(start, end));
    const post = this.escapeHtml(line.slice(end));
    return `${pre}<mark>${match}</mark>${post}`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private escapeAttr(str: string): string {
    return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
}
